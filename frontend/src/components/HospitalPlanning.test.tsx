// Hospital Planning (direct component tests; the full-app path is in PlanningSections.test.tsx).
// FIXTURE values only, validated by the real parser.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { HospitalRoutingQuery, HospitalRoutingResponse } from "../api/types";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { deferred, makeMeta, NOTICE } from "../test/fixtures";
import { makeHospital } from "../test/planningFixtures";
import { HospitalPlanning } from "./HospitalPlanning";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const h = en.hospital;
const DATE = "2025-07-28";
type RouteFn = (q: HospitalRoutingQuery, signal: AbortSignal) => Promise<HospitalRoutingResponse>;

function mount(impl?: RouteFn, opts: { lang?: "en" | "bn"; date?: string } = {}) {
  const route = vi.fn<RouteFn>(impl ?? ((q) => Promise.resolve(makeHospital(q))));
  const view = render(
    <I18nProvider initial={opts.lang ?? "en"}>
      <HospitalPlanning route={route} meta={makeMeta()} selection={{ city: "Gazipur", ward: "GCC_Ward_01", date: opts.date ?? DATE }} baseUrl="http://test.invalid" />
    </I18nProvider>,
  );
  return { route, view };
}
async function ready(impl?: RouteFn, opts: { lang?: "en" | "bn" } = {}) {
  const m = mount(impl, opts);
  const region = await screen.findByRole("region", { name: (opts.lang === "bn" ? bn : en).hospital.title });
  await within(region).findByTestId("applied-parameters");
  return { ...m, region };
}
async function setBox(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = screen.getByLabelText(label);
  await user.clear(box);
  if (text) await user.type(box, text);
}

describe("hospital planning requests", () => {
  it("requests once with the selected week and backend defaults, showing only the capacity control", async () => {
    const { route, region } = await ready();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0]).toEqual({ issue_date: DATE });
    expect(route.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(within(region).getByLabelText(en.scenario.capacityLabel)).toHaveValue("100");
    expect(within(region).queryByLabelText(en.scenario.stockLabel)).toBeNull();
    expect(within(region).queryByLabelText(en.scenario.totalCrewsLabel)).toBeNull();
  });

  it("does not request while typing; Apply sends the capacity once and the result is labelled from the backend", async () => {
    const user = userEvent.setup();
    const { route, region } = await ready();
    await setBox(user, en.scenario.capacityLabel, "75");
    expect(route).toHaveBeenCalledTimes(1);
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(en.planning.draftChanged);
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(h.appliedLine("28 Jul 2025", "100", "6"));
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    await waitFor(() => expect(route).toHaveBeenCalledTimes(2));
    expect(route.mock.calls[1]![0]).toEqual({ issue_date: DATE, capacity_pct: 75 });
    expect(await within(region).findByText(h.appliedLine("28 Jul 2025", "75", "6"))).toBeInTheDocument();
  });

  it("blocks out-of-range capacity without requesting", async () => {
    const user = userEvent.setup();
    const { route, region } = await ready();
    await setBox(user, en.scenario.capacityLabel, "300");
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(en.planning.blocked);
    expect(screen.getByLabelText(en.scenario.capacityLabel)).toHaveAttribute("aria-invalid", "true");
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("aborts a superseded request, ignores its late answer and aborts on unmount", async () => {
    const user = userEvent.setup();
    const pending: { q: HospitalRoutingQuery; signal: AbortSignal; d: ReturnType<typeof deferred<HospitalRoutingResponse>> }[] = [];
    const { view } = mount((q, signal) => {
      const d = deferred<HospitalRoutingResponse>();
      pending.push({ q, signal, d });
      return d.promise;
    });
    const region = await screen.findByRole("region", { name: h.title });
    await waitFor(() => expect(pending).toHaveLength(1));
    await setBox(user, en.scenario.capacityLabel, "50");
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.d.resolve(makeHospital(pending[1]!.q));
    expect(await within(region).findByText(h.appliedLine("28 Jul 2025", "50", "6"))).toBeInTheDocument();
    pending[0]!.d.resolve(makeHospital(pending[0]!.q));
    await new Promise((r) => setTimeout(r, 30));
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(h.appliedLine("28 Jul 2025", "50", "6"));
    await setBox(user, en.scenario.capacityLabel, "60");
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    await waitFor(() => expect(pending).toHaveLength(3));
    view.unmount();
    expect(pending[2]!.signal.aborted).toBe(true);
  });
});

describe("hospital planning results", () => {
  it("shows the three forecast weeks with demand, capacity, moves and the shortfall as returned", async () => {
    const { region } = await ready();
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([h.thWeek, h.thDemand, h.thCapacity, h.thLocal, h.thMoved, h.thUnmet, h.thUse]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("rowheader")).toHaveTextContent(h.weekLabel("2", "11 Aug 2025"));
    expect(within(rows[0]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["4", "6", "4", "0", "0", "66.7%"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["6", "6", "3", "1", "0", "100.0%"]);
  });

  it("shows each city at its headline week, with a shortfall marked in words", async () => {
    const { region } = await ready();
    const cities = within(within(region).getByRole("region", { name: h.citiesTitle })).getAllByRole("listitem");
    expect(cities.map((c) => c.querySelector("h4")?.textContent)).toEqual(["Gazipur", "Narayanganj"]);
    expect(cities[0]).toHaveTextContent(h.capacityLine("4", "5"));
    expect(cities[0]).toHaveTextContent(`${h.peakWeek}${h.weekLabel("4", "25 Aug 2025")}`);
    expect(cities[0]!.querySelector(".is-short")).toHaveTextContent(`${h.thUnmet}2`);
    expect(cities[1]).toHaveTextContent(`${h.peakWeek}${h.weekLabel("2", "11 Aug 2025")}`);
  });

  it("lists the simulated within-city moves and keeps the honesty framing and backend notes", async () => {
    const user = userEvent.setup();
    const { region } = await ready();
    expect(within(region).getByRole("region", { name: h.movesTitle })).toHaveTextContent(h.moveLine("1", "GCC Ward 01", "GCC Ward 02", "Gazipur", "4"));
    expect(region).toHaveTextContent(`${en.notLive} ${NOTICE} ${h.hypothetical}`);
    expect(region).toHaveTextContent("Capacity baseline calibrated on 2016-2023 data"); // backend warning shown as given
    expect(region.textContent).not.toMatch(/real-time|confirmed case|admitted|ambulance|travel time to/i);
    await user.click(within(region).getByText(en.planning.detailsSummary));
    expect(within(region).getByText(en.planning.detailsSummary).closest("details")).toHaveTextContent("No hospital locations, distances, travel times");
  });
});

describe("hospital planning states, accessibility and translations", () => {
  it("shows an error with an independent Retry that repeats the applied request", async () => {
    const user = userEvent.setup();
    let n = 0;
    const { route } = mount((q) => (++n === 1 ? Promise.reject(new ApiError("timeout", "slow")) : Promise.resolve(makeHospital(q))));
    const region = await screen.findByRole("region", { name: h.title });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(en.errTimeout);
    await user.click(within(alert).getByRole("button", { name: en.info.retryLabel }));
    expect(n).toBe(1);
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await within(region).findByTestId("applied-parameters")).toBeInTheDocument();
    expect(route.mock.calls[1]![0]).toEqual(route.mock.calls[0]![0]);
  });

  it("says so without a planning service, and shows loading while waiting", async () => {
    const { unmount } = render(
      <I18nProvider initial="en">
        <HospitalPlanning route={null} meta={makeMeta()} selection={{ city: "Gazipur", ward: "GCC_Ward_01", date: DATE }} baseUrl="x" />
      </I18nProvider>,
    );
    expect(screen.getByText(en.planning.unavailableTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.planning.apply })).toBeDisabled();
    unmount();
    mount(() => new Promise(() => {}));
    expect(await screen.findByText(h.loading)).toBeInTheDocument();
  });

  it("keeps Apply and its explanation independent, with no nested buttons or duplicate ids", async () => {
    const user = userEvent.setup();
    const { route, region } = await ready();
    const apply = within(region).getByRole("button", { name: en.planning.apply });
    const info = within(region).getByRole("button", { name: h.applyInfoLabel });
    expect(info.parentElement?.parentElement).toBe(apply.parentElement);
    await user.click(info);
    expect(openInfoPopoverKey()).not.toBeNull();
    expect(route).toHaveBeenCalledTimes(1);
    expect(document.querySelector("button button, button a, a button, label button")).toBeNull();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has matching Bangla keys and renders Bangla digits", async () => {
    expect(Object.keys(bn.hospital).sort()).toEqual(Object.keys(en.hospital).sort());
    expect(Object.keys(bn.planning).sort()).toEqual(Object.keys(en.planning).sort());
    const { region } = await ready(undefined, { lang: "bn" });
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(bn.hospital.appliedLine("২৮ জুলাই ২০২৫", "১০০", "৬"));
    expect(within(region).getByRole("table")).toHaveTextContent(bn.hospital.weekLabel("২", "১১ আগস্ট ২০২৫"));
  });
});
