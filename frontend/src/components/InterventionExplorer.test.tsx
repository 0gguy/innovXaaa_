// Intervention Explorer (direct component tests; the full-app path is in PlanningSections.test.tsx).
// FIXTURE values only, validated by the real parser.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { InterventionQuery, InterventionResponse } from "../api/types";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { deferred, makeMeta, NOTICE } from "../test/fixtures";
import { makeIntervention } from "../test/planningFixtures";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";
import { InterventionExplorer } from "./InterventionExplorer";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const iv = en.intervention;
const DATE = "2025-07-28";
type SimFn = (q: InterventionQuery, signal: AbortSignal) => Promise<InterventionResponse>;

function mount(impl?: SimFn, opts: { lang?: "en" | "bn" } = {}) {
  const simulate = vi.fn<SimFn>(impl ?? ((q) => Promise.resolve(makeIntervention(q))));
  const view = render(
    <I18nProvider initial={opts.lang ?? "en"}>
      <InterventionExplorer simulate={simulate} meta={makeMeta()} selection={{ city: "Gazipur", ward: "GCC_Ward_01", date: DATE }} baseUrl="http://test.invalid" />
    </I18nProvider>,
  );
  return { simulate, view };
}
async function ready(impl?: SimFn, opts: { lang?: "en" | "bn" } = {}) {
  const m = mount(impl, opts);
  const region = await screen.findByRole("region", { name: (opts.lang === "bn" ? bn : en).intervention.title });
  await within(region).findByTestId("applied-parameters");
  return { ...m, region };
}
async function setBox(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = screen.getByLabelText(label);
  await user.clear(box);
  if (text) await user.type(box, text);
}

describe("intervention explorer requests", () => {
  it("requests once with the selected week and defaults, and offers crew, coverage and ROI controls", async () => {
    const { simulate, region } = await ready();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate.mock.calls[0]![0]).toEqual({ issue_date: DATE });
    expect(within(region).getByLabelText(en.scenario.totalCrewsLabel)).toHaveValue("60");
    expect(within(region).getByLabelText(en.scenario.minCoverageLabel)).toHaveValue("30");
    expect(within(region).getByLabelText(en.scenario.roiLabel)).not.toBeChecked();
    expect(within(region).queryByLabelText(en.scenario.capacityLabel)).toBeNull();
  });

  it("applies crews (including an explicit zero) and the ROI option once, never while typing", async () => {
    const user = userEvent.setup();
    const { simulate, region } = await ready();
    await setBox(user, en.scenario.totalCrewsLabel, "0");
    await user.click(within(region).getByLabelText(en.scenario.roiLabel));
    expect(simulate).toHaveBeenCalledTimes(1);
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    await waitFor(() => expect(simulate).toHaveBeenCalledTimes(2));
    expect(simulate.mock.calls[1]![0]).toEqual({ issue_date: DATE, total_crews: 0, include_roi_alternative: true });
    expect(await within(region).findByText(iv.appliedLine("28 Jul 2025", "0", "30", iv.roiOn))).toBeInTheDocument();
  });

  it("blocks fractional crews without requesting", async () => {
    const user = userEvent.setup();
    const { simulate, region } = await ready();
    await setBox(user, en.scenario.totalCrewsLabel, "1.5");
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(en.planning.blocked);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it("aborts a superseded request and ignores its late answer", async () => {
    const user = userEvent.setup();
    const pending: { q: InterventionQuery; signal: AbortSignal; d: ReturnType<typeof deferred<InterventionResponse>> }[] = [];
    const { view } = mount((q, signal) => {
      const d = deferred<InterventionResponse>();
      pending.push({ q, signal, d });
      return d.promise;
    });
    const region = await screen.findByRole("region", { name: iv.title });
    await waitFor(() => expect(pending).toHaveLength(1));
    await setBox(user, en.scenario.totalCrewsLabel, "5");
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.d.resolve(makeIntervention(pending[1]!.q));
    expect(await within(region).findByText(iv.appliedLine("28 Jul 2025", "5", "30", iv.roiOff))).toBeInTheDocument();
    pending[0]!.d.resolve(makeIntervention(pending[0]!.q));
    await new Promise((r) => setTimeout(r, 30));
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(iv.appliedLine("28 Jul 2025", "5", "30", iv.roiOff));
    view.unmount();
  });
});

describe("intervention explorer results", () => {
  it("compares the low, base and high assumed effects with the backend's figures", async () => {
    const { region } = await ready();
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([iv.thMeasure, en.scenario.effectLow, en.scenario.effectBase, en.scenario.effectHigh]);
    const row = (label: string) => within(within(table).getByRole("rowheader", { name: label }).closest("tr")!).getAllByRole("cell").map((c) => c.textContent);
    expect(row(iv.rowMax)).toEqual(["15.0%", "35.0%", "55.0%"]);
    expect(row(iv.rowBaseline)).toEqual(["31.5", "31.5", "31.5"]);
    expect(row(iv.rowAvoided)).toEqual(["0.5", "1.1", "1.7"]); // 0.45, 1.05, 1.65 shown to one decimal
    expect(row(iv.rowPerCrew)).toEqual(["0.2", "0.5", "0.8"]);
    expect(row(iv.rowSaline)).toEqual(["2", "2", "2"]);
    expect(within(region).getByText(iv.crewsLine("2", "60", "3", "58"))).toBeInTheDocument();
  });

  it("shows each city per scenario, and the ROI comparison only when it was requested", async () => {
    const user = userEvent.setup();
    const { region } = await ready();
    const cities = within(within(region).getByRole("region", { name: iv.citiesTitle })).getAllByRole("listitem");
    expect(cities.map((c) => c.querySelector("h4")?.textContent)).toEqual(["Gazipur", "Narayanganj"]);
    expect(cities[0]).toHaveTextContent(`${iv.avoidedIn(en.scenario.effectHigh)}1.1`);
    expect(within(region).queryByRole("region", { name: iv.roiTitle })).toBeNull();
    await user.click(within(region).getByLabelText(en.scenario.roiLabel));
    await user.click(within(region).getByRole("button", { name: en.planning.apply }));
    const roi = await within(region).findByRole("region", { name: iv.roiTitle });
    expect(within(roi).getAllByRole("listitem")[1]).toHaveTextContent(`${iv.roiPrimary}1.1${iv.roiAlternative}1.2${iv.roiDifference}0.1`);
  });

  it("keeps the assumed-effect, not-causal framing and the backend notes", async () => {
    const user = userEvent.setup();
    const { region } = await ready();
    expect(region).toHaveTextContent(`${en.notLive} ${NOTICE} ${iv.hypothetical}`);
    // apart from the disclaimer itself (which negates these words), no claim of real or proven effects
    const rest = (region.textContent ?? "").replace(iv.hypothetical, "");
    expect(rest).not.toMatch(/were prevented|proven|clinically validated|real ROI/i);
    await user.click(within(region).getByText(en.planning.detailsSummary));
    expect(within(region).getByText(en.planning.detailsSummary).closest("details")).toHaveTextContent("does not estimate or establish causal effectiveness");
  });
});

describe("intervention explorer states and translations", () => {
  it("shows an error with an independent Retry and an explanation that runs nothing", async () => {
    const user = userEvent.setup();
    let n = 0;
    mount((q) => (++n === 1 ? Promise.reject(new ApiError("http", "rejected", { status: 422, code: "invalid_input" })) : Promise.resolve(makeIntervention(q))));
    const region = await screen.findByRole("region", { name: iv.title });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(en.errRejected);
    await user.click(within(region).getByRole("button", { name: iv.applyInfoLabel }));
    expect(openInfoPopoverKey()).not.toBeNull();
    expect(n).toBe(1);
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await within(region).findByTestId("applied-parameters")).toBeInTheDocument();
    expect(n).toBe(2);
  });

  it("has matching Bangla keys and renders Bangla digits", async () => {
    expect(Object.keys(bn.intervention).sort()).toEqual(Object.keys(en.intervention).sort());
    for (const [k, v] of Object.entries(bn.intervention)) {
      const text = typeof v === "function" ? (v as (...a: string[]) => string)("১", "২", "৩", "৪") : v;
      expect(/[ঀ-৿]/.test(text), k).toBe(true);
    }
    const { region } = await ready(undefined, { lang: "bn" });
    expect(within(region).getByRole("table")).toHaveTextContent("৩১.৫");
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(bn.intervention.appliedLine("২৮ জুলাই ২০২৫", "৬০", "৩০", bn.intervention.roiOff));
  });
});
