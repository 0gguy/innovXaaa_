// Resource Planning: activation, shared week, draft vs applied scenario, the /allocation request lifecycle, the
// backend's region/city/ward figures, states, translations and isolation. FIXTURE values only; every mock answer
// goes through the real strict parser (parseAllocation), so the shapes match the committed contract.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ApiError, type ApiClient, type PlanningApiClient } from "../api/client";
import type { AllocationQuery, AllocationResponse } from "../api/types";
import { parseAllocation } from "../api/validate";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { allFor, deferred, fakeClient, makeMeta, NOTICE, oneFor } from "../test/fixtures";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";
import { ResourcePlanning } from "./ResourcePlanning";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const r = en.resources;
const s = en.scenario;
const DATE = "2025-07-28";

// ---------------------------------------------------------------- a balanced /allocation answer (validated)
type Json = Record<string, unknown>;
const pct1 = (a: number, d: number) => (d === 0 ? null : Math.round((1000 * a) / d) / 10);
const resSum = (demand: number, stock: number, allocated: number, short: number, below = 0): Json => ({
  demand, stock, allocated, deficit: demand - allocated, unallocated: stock - allocated, coverage_pct: pct1(allocated, demand), wards_with_deficit: short, wards_below_floor: below,
});
const crewSum = (demand: number, pool: number, assigned: number): Json => ({
  scenario_demand: demand, pool, assigned, scenario_deficit: demand - assigned, coverage_pct: pct1(assigned, demand), wards_with_scenario_deficit: demand > assigned ? 1 : 0, wards_below_floor: 0,
});
function wardRes(demand: number, allocated: number, floorPct: number): Json {
  const deficit = demand - allocated;
  const floor = Math.ceil((floorPct * demand) / 100);
  return {
    demand, floor, allocated, deficit, coverage_pct: pct1(allocated, demand), critical_deficit: deficit > 0,
    severity: deficit === 0 ? "no_deficit" : allocated < floor ? "below_floor" : "partial",
    reason: demand === 0 ? "no_demand" : deficit === 0 ? "fulfilled" : allocated < floor ? "below_floor" : "partial_priority",
  };
}
function wardCrew(demand: number, assigned: number, floorPct: number): Json {
  const deficit = demand - assigned;
  const floor = Math.ceil((floorPct * demand) / 100);
  return {
    scenario_demand: demand, floor, assigned, scenario_deficit: deficit, coverage_pct: pct1(assigned, demand), scenario_crew_deficit: deficit > 0,
    severity: deficit === 0 ? "no_deficit" : assigned < floor ? "below_floor" : "partial",
    reason: demand === 0 ? "no_demand" : deficit === 0 ? "fulfilled" : assigned < floor ? "below_floor" : "partial_priority",
  };
}
function ward(id: string, city: string, rank: number, tier: string, sal: [number, number], kit: [number, number], crew: [number, number], floorPct: number): Json {
  return {
    ward_id: id, city, priority_rank_in_city: rank,
    priority: { risk_tier: tier, early_alert: tier === "Critical", population_density_sqkm: 40000, predicted_cases_3wk: 12.5 },
    saline: wardRes(...sal, floorPct), kits: wardRes(...kit, floorPct), crews: wardCrew(...crew, floorPct),
    bed_plan: { peak_forecast_week: "2025-08-18", peak_horizon_week: 3, peak_week_expected_cases: 3.2, bed_planning_demand: 1, weekly_source: "companion" },
    exceeds_observed_range: false,
  };
}
/** Echoes the requested parameters back, like the backend; figures are fixed fixture values. */
function makeAllocation(q: AllocationQuery = {}, issue = DATE, empty = false): AllocationResponse {
  const stock = q.stock_pct ?? 100;
  const cov = q.min_coverage_pct ?? 30;
  const crews = q.total_crews ?? 60;
  const body = {
    mode: "historical_replay", notice: NOTICE, issue_date: q.issue_date ?? issue, model_version: "dengue-xgb-2to4w-1.1.0",
    policy: { name: "minimum_coverage_then_risk_priority", description: "Deterministic, fairness-first greedy allocation." },
    parameters: {
      stock_pct: { saline: q.stock_pct_saline ?? stock, kits: q.stock_pct_kits ?? stock }, min_coverage_pct: cov, total_crews: crews, rounding: "ROUND_HALF_UP",
      coefficients: { saline: "2.38485", kits: "1.16422", beds: "0.29844" },
      crew_rule: { eligible_tiers: ["Medium", "High", "Critical"], density_per_crew_sqkm: 12000, max_crews_per_ward: 6, status: "hypothetical_scenario" },
      priority_key: ["risk_tier", "early_alert", "population_density_sqkm", "predicted_cases_3wk", "ward_id"],
    },
    weekly_source: "companion",
    assumptions: ["100% stock means 100% of forecast planning demand in each city, not verified municipal inventory."],
    limitations: ["Historical replay on data that appear simulated; not a live or official plan."],
    region: {
      saline: resSum(120, 90, 90, 2, 1), kits: resSum(60, 45, 45, 2), crews: { ...crewSum(7, 5, 5), total_crews: 5, unassigned: 0 },
      beds: { planning_demand: 9, capacity_and_routing: "not_computed" },
    },
    cities: empty
      ? []
      : [
          { city: "Dhaka North", ward_count: 2, saline: resSum(100, 75, 75, 1, 1), kits: resSum(50, 38, 38, 1), crews: crewSum(5, 4, 4), beds: { planning_demand: 7, capacity_and_routing: "not_computed" } },
          { city: "Gazipur", ward_count: 1, saline: resSum(20, 15, 15, 1), kits: resSum(10, 7, 7, 1), crews: crewSum(2, 1, 1), beds: { planning_demand: 2, capacity_and_routing: "not_computed" } },
        ],
    wards: empty
      ? []
      : [
          ward("DNCC_Ward_12", "Dhaka North", 1, "Critical", [80, 70], [40, 33], [3, 3], cov),
          ward("DNCC_Ward_11", "Dhaka North", 2, "High", [20, 5], [10, 5], [2, 1], cov),
          ward("GCC_Ward_01", "Gazipur", 1, "Medium", [20, 15], [10, 7], [2, 1], cov),
        ],
  };
  // The strict parser rejects an empty city list, so a real backend answer can never be empty; the empty case is
  // handed over unparsed only to exercise the component's defensive empty state.
  return empty ? (body as unknown as AllocationResponse) : parseAllocation(body);
}

type AllocFn = (query?: AllocationQuery, signal?: AbortSignal) => Promise<AllocationResponse>;
function client(impl?: AllocFn) {
  const allocation = vi.fn<AllocFn>(impl ?? ((q) => Promise.resolve(makeAllocation(q))));
  const forecastWard = vi.fn((w: string, d: string) => Promise.resolve(oneFor(w, d)));
  const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
  const others = { hospitalRouting: vi.fn(), interventionSimulation: vi.fn(), dispatchBrief: vi.fn(), dispatchDocument: vi.fn(), dispatchBriefUrl: vi.fn() };
  const c = { ...fakeClient({ forecastWard, forecastAll }), allocation, ...others } as ApiClient & PlanningApiClient;
  return { client: c, allocation, forecastWard, forecastAll, others };
}

// ---------------------------------------------------------------- two ways to mount
// FULL APP: only for what needs the app shell (navigation, the shared week/ward selector, the language switch).
async function readyApp(c = client()) {
  render(<App client={c.client} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" }, { timeout: 3000 });
  await screen.findByRole("region", { name: /All 8 wards/ });
  return c;
}
const nav = () => screen.getByRole("navigation", { name: en.nav.label });
const navButton = (name: string) => within(nav()).getByRole("button", { name });
async function openResources(user = userEvent.setup()) {
  await user.click(navButton(en.nav.resources));
  const region = await screen.findByRole("region", { name: r.title });
  await within(region).findByTestId("applied-parameters");
  return region;
}

// COMPONENT: the real ResourcePlanning (real useScenario, ScenarioControls, buildAllocationQuery, InfoButton and
// parser-validated answers) with the same props the dashboard passes, without booting the whole dashboard.
function mountPlanning(c = client(), opts: { lang?: "en" | "bn"; date?: string } = {}) {
  const view = render(
    <I18nProvider initial={opts.lang ?? "en"}>
      <ResourcePlanning
        allocate={c.allocation}
        meta={makeMeta()}
        selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: opts.date ?? DATE }}
        baseUrl={c.client.baseUrl}
      />
    </I18nProvider>,
  );
  return { ...c, view };
}
async function planningReady(c = client(), opts: { lang?: "en" | "bn"; date?: string } = {}) {
  const m = mountPlanning(c, opts);
  const region = await screen.findByRole("region", { name: (opts.lang === "bn" ? bn : en).resources.title });
  await within(region).findByTestId("applied-parameters");
  return { ...m, region };
}
async function setBox(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = screen.getByLabelText(label);
  await user.clear(box);
  if (text) await user.type(box, text);
}

// ---------------------------------------------------------------- full-app integration (4 tests)
describe("resource planning navigation", () => {
  it("makes Resource Planning available among all six sections, requests nothing before it opens and calls no other planning endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c = await readyApp();
    const fetches = fetchSpy.mock.calls.length; // the validation panel may load its static file on the Overview
    expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual([en.nav.overview, en.nav.weekly, en.nav.resources, en.nav.hospitals, en.nav.interventions, en.nav.dispatch]);
    expect(document.querySelector(".section-tab-item.is-planned")).toBeNull();
    expect(c.allocation).not.toHaveBeenCalled(); // nothing until the section opens
    await openResources();
    expect(navButton(en.nav.resources)).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("region", { name: /All 8 wards/ })).toBeNull();
    expect(c.allocation).toHaveBeenCalledTimes(1);
    expect(c.allocation.mock.calls[0]![0]).toEqual({ issue_date: DATE });
    for (const fn of Object.values(c.others)) expect(fn).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.length).toBe(fetches);
  });

  it("keeps the shared selection and language across sections, with one selector", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("region", { name: /week of 4 Aug 2025/ });
    const region = await openResources(user);
    expect(region).toHaveTextContent(r.where("4 Aug 2025"));
    expect(c.allocation.mock.calls.at(-1)?.[0]).toEqual({ issue_date: "2025-08-04" });
    expect(screen.getAllByRole("form", { name: en.controlsLabel })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: en.langBnLabel }));
    expect(await screen.findByRole("region", { name: bn.resources.title })).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: bn.nav.label })).getByRole("button", { name: bn.nav.overview }));
    expect((await screen.findAllByLabelText(bn.week)).map((e) => (e as HTMLSelectElement).value)).toContain("2025-08-04");
  });

  it("closes an open explanation when switching sections, and is reachable from the keyboard", async () => {
    const user = userEvent.setup();
    await readyApp();
    navButton(en.nav.resources).focus();
    await user.keyboard("{Enter}");
    const region = await screen.findByRole("region", { name: r.title });
    await user.click(within(region).getByRole("button", { name: r.applyInfoLabel }));
    expect(openInfoPopoverKey()).not.toBeNull();
    fireEvent.click(navButton(en.nav.weekly));
    expect(openInfoPopoverKey()).toBeNull();
  });

  it("re-requests with the APPLIED assumptions when the shared week changes", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    const region = await openResources(user);
    await setBox(user, s.stockLabel, "55");
    await user.click(within(region).getByRole("button", { name: r.apply }));
    await waitFor(() => expect(c.allocation).toHaveBeenCalledTimes(2));
    await setBox(user, s.totalCrewsLabel, "9"); // a draft, not applied
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(c.allocation).toHaveBeenCalledTimes(3));
    expect(c.allocation.mock.calls[2]![0]).toEqual({ issue_date: "2025-08-04", stock_pct: 55 }); // draft crews not sent
    expect(await within(region).findByText(r.appliedLine("4 Aug 2025", "55", "55", "30", "60"))).toBeInTheDocument();
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveValue("9"); // the draft is kept, not reset
  });
});

// ---------------------------------------------------------------- component: requests, draft and applied
describe("resource planning requests", () => {
  it("requests once on mounting, with backend defaults omitted, the selected week and an abort signal", async () => {
    const c = await planningReady();
    expect(c.allocation).toHaveBeenCalledTimes(1);
    const [query, signal] = c.allocation.mock.calls[0]!;
    expect(query).toEqual({ issue_date: DATE }); // backend defaults are omitted, never re-sent
    expect(signal).toBeInstanceOf(AbortSignal);
    for (const fn of Object.values(c.others)) expect(fn).not.toHaveBeenCalled();
  });

  it("does not request while typing; Apply sends the exact scenario once and the results follow it", async () => {
    const user = userEvent.setup();
    const { allocation, region } = await planningReady();
    await setBox(user, s.stockLabel, "60");
    await setBox(user, s.minCoverageLabel, "0");
    await setBox(user, s.totalCrewsLabel, "0");
    await user.click(screen.getByText(s.overridesSummary));
    await setBox(user, s.salineLabel, "45");
    await setBox(user, s.kitsLabel, "90");
    expect(allocation).toHaveBeenCalledTimes(1); // still only the opening request
    // the old results stay labelled with what was actually applied, and the change is announced
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(r.appliedLine("28 Jul 2025", "100", "100", "30", "60"));
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(r.draftChanged);
    await user.click(within(region).getByRole("button", { name: r.apply }));
    await waitFor(() => expect(allocation).toHaveBeenCalledTimes(2));
    expect(allocation.mock.calls[1]![0]).toEqual({
      issue_date: DATE, stock_pct: 60, stock_pct_saline: 45, stock_pct_kits: 90, min_coverage_pct: 0, total_crews: 0,
    });
    expect(await within(region).findByText(r.appliedLine("28 Jul 2025", "45", "90", "0", "0"))).toBeInTheDocument();
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).not.toContain(r.draftChanged);
  });

  it("keeps an empty override apart from an explicit one", async () => {
    const user = userEvent.setup();
    const { allocation, region } = await planningReady();
    await setBox(user, s.stockLabel, "70");
    await user.click(within(region).getByRole("button", { name: r.apply }));
    await waitFor(() => expect(allocation).toHaveBeenCalledTimes(2));
    expect(allocation.mock.calls[1]![0]).toEqual({ issue_date: DATE, stock_pct: 70 }); // no saline/kit keys
    expect(await within(region).findByText(r.appliedLine("28 Jul 2025", "70", "70", "30", "60"))).toBeInTheDocument();
  });

  it("blocks invalid values: nothing is requested and the reason is announced", async () => {
    const user = userEvent.setup();
    const { allocation, region } = await planningReady();
    await setBox(user, s.totalCrewsLabel, "2.5");
    await user.click(within(region).getByRole("button", { name: r.apply }));
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveAttribute("aria-invalid", "true");
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(r.blocked);
    await new Promise((res) => setTimeout(res, 30));
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(r.appliedLine("28 Jul 2025", "100", "100", "30", "60"));
  });

  it("aborts the previous request on a newer Apply and ignores its late answer", async () => {
    const user = userEvent.setup();
    const pending: { q: AllocationQuery; signal?: AbortSignal; d: ReturnType<typeof deferred<AllocationResponse>> }[] = [];
    mountPlanning(
      client((q = {}, signal) => {
        const d = deferred<AllocationResponse>();
        pending.push({ q, signal, d });
        return d.promise;
      }),
    );
    const region = await screen.findByRole("region", { name: r.title });
    await waitFor(() => expect(pending).toHaveLength(1));
    await setBox(user, s.stockLabel, "40");
    await user.click(within(region).getByRole("button", { name: r.apply }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal?.aborted).toBe(true);
    pending[1]!.d.resolve(makeAllocation(pending[1]!.q));
    expect(await within(region).findByText(r.appliedLine("28 Jul 2025", "40", "40", "30", "60"))).toBeInTheDocument();
    pending[0]!.d.resolve(makeAllocation(pending[0]!.q));
    await new Promise((res) => setTimeout(res, 30));
    expect(within(region).getByTestId("applied-parameters")).toHaveTextContent(r.appliedLine("28 Jul 2025", "40", "40", "30", "60"));
  });

  it("aborts a pending request when the view goes away (the dashboard unmounts it on a section change)", async () => {
    let seen: AbortSignal | undefined;
    const { view } = mountPlanning(
      client((_q, signal) => {
        seen = signal;
        return new Promise<AllocationResponse>(() => {});
      }),
    );
    expect(await screen.findByText(r.loading)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: r.title })).toHaveAttribute("aria-busy", "true");
    expect(seen?.aborted).toBe(false);
    view.unmount();
    expect(seen?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------- component: figures
describe("resource planning results", () => {
  it("shows the region's saline, kit and crew figures exactly as returned", async () => {
    const { region } = await planningReady();
    const block = within(region).getByRole("region", { name: r.regionTitle });
    const cards = Array.from(block.querySelectorAll(".planning-card"));
    expect(cards).toHaveLength(3);
    const rows = (card: Element) => Array.from(card.querySelectorAll(".planning-dl > div")).map((d) => d.textContent);
    expect(cards[0]).toHaveTextContent(r.saline);
    expect(rows(cards[0]!)).toEqual([`${r.demand}120`, `${r.stock}90`, `${r.allocated}90`, `${r.deficit}30`, `${r.coverage}75.0%`]);
    expect(cards[0]).toHaveTextContent(r.wardsShort("2", "1"));
    expect(cards[1]).toHaveTextContent(r.kitsUnit);
    expect(rows(cards[1]!)).toEqual([`${r.demand}60`, `${r.stock}45`, `${r.allocated}45`, `${r.deficit}15`, `${r.coverage}75.0%`]);
    expect(rows(cards[2]!)).toEqual([`${r.crewDemand}7`, `${r.crewPool}5`, `${r.crewAssigned}5`, `${r.crewShort}2`, `${r.coverage}71.4%`]);
    expect(cards[2]).toHaveTextContent(r.crewsUnit);
    expect(block).toHaveTextContent(r.bedsLine("9"));
    // shortfalls are marked in words as well as colour
    expect(cards[0]!.querySelector(".is-short")).toHaveTextContent(r.deficit);
  });

  it("shows each city the backend returned", async () => {
    const { region } = await planningReady();
    const list = within(region).getByRole("region", { name: r.citiesTitle });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("h4")?.textContent)).toEqual(["Dhaka North", "Gazipur"]);
    expect(items[0]).toHaveTextContent(r.wardCount("2"));
    expect(items[0]).toHaveTextContent(`${r.saline}${r.ofDemand("75", "100", "25")}`);
    expect(items[0]).toHaveTextContent(`${r.crews}${r.ofDemand("4", "5", "1")}`);
    expect(items[1]).toHaveTextContent(`${r.kits}${r.ofDemand("7", "10", "3")}`);
  });

  it("lists wards in the backend's order with its rank, tier and figures, and marks shortfalls in words", async () => {
    const { region } = await planningReady();
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([r.thWard, r.thRank, r.thTier, r.saline, r.kits, r.crews, r.thStatus]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((tr) => tr.getAttribute("data-ward"))).toEqual(["DNCC_Ward_12", "DNCC_Ward_11", "GCC_Ward_01"]);
    const cells = (tr: HTMLElement) => within(tr).getAllByRole("cell").map((c) => c.textContent);
    expect(within(rows[0]!).getByRole("rowheader")).toHaveTextContent("DNCC Ward 12Dhaka North");
    expect(cells(rows[0]!)).toEqual(["1", `C${en.tier.Critical}${en.rowAlert}`, "70 / 80", "33 / 40", "3 / 3", r.statusShort]);
    expect(cells(rows[1]!)).toEqual(["2", `H${en.tier.High}`, "5 / 20", "5 / 10", "1 / 2", r.statusBelow]); // 5 < floor ceil(0.3*20)=6
    expect(cells(rows[2]!)[0]).toBe("1"); // rank restarts per city
    // the table scrolls inside its own labelled region, reachable by keyboard
    const wrap = table.closest(".planning-table-wrap")!;
    expect(wrap).toHaveAttribute("role", "region");
    expect(wrap).toHaveAttribute("tabindex", "0");
  });

  it("keeps the replay, hypothetical and not-an-instruction framing, and the backend's own notes", async () => {
    const user = userEvent.setup();
    const { region } = await planningReady();
    expect(region).toHaveTextContent(`${en.notLive} ${NOTICE} ${r.hypothetical}`);
    expect(region.textContent).not.toMatch(/real-time|confirmed case|official alert|has been dispatched|was sent to/i);
    await user.click(within(region).getByText(r.detailsSummary));
    const details = within(region).getByText(r.detailsSummary).closest("details")!;
    expect(details).toHaveTextContent("Deterministic, fairness-first greedy allocation.");
    expect(details).toHaveTextContent("not verified municipal inventory");
    expect(details).toHaveTextContent("not a live or official plan");
  });

  it("shows an empty state when no city or ward results come back (defensive: the validator rejects this shape)", async () => {
    mountPlanning(client((q) => Promise.resolve(makeAllocation(q, DATE, true))));
    const region = await screen.findByRole("region", { name: r.title });
    expect(await within(region).findByText(r.emptyTitle)).toBeInTheDocument();
    expect(within(region).queryByRole("table")).toBeNull();
  });
});

// ---------------------------------------------------------------- component: states and actions
describe("resource planning states", () => {
  it("shows an error with an independent Retry that repeats only the applied request", async () => {
    const user = userEvent.setup();
    let n = 0;
    const c = mountPlanning(client((q) => (++n === 1 ? Promise.reject(new ApiError("network", "x")) : Promise.resolve(makeAllocation(q)))));
    const region = await screen.findByRole("region", { name: r.title });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(en.errNetwork);
    await user.click(within(alert).getByRole("button", { name: en.info.retryLabel }));
    expect(n).toBe(1); // explaining does not retry
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await within(region).findByTestId("applied-parameters")).toBeInTheDocument();
    expect(n).toBe(2);
    expect(c.allocation.mock.calls[1]![0]).toEqual(c.allocation.mock.calls[0]![0]);
    for (const fn of [c.forecastWard, c.forecastAll, ...Object.values(c.others)]) expect(fn).not.toHaveBeenCalled();
  });

  it("shows a shape error as an error, never as figures", async () => {
    mountPlanning(client(() => Promise.reject(new ApiError("shape", "x"))));
    const region = await screen.findByRole("region", { name: r.title });
    expect(await within(region).findByRole("alert")).toHaveTextContent(en.errShape);
    expect(within(region).queryByRole("table")).toBeNull();
  });

  it("says so, and requests nothing, without a planning client or an issue week", () => {
    const { unmount } = render(
      <I18nProvider initial="en">
        <ResourcePlanning allocate={null} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: DATE }} baseUrl="http://test.invalid" />
      </I18nProvider>,
    );
    expect(screen.getByText(r.unavailableTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: r.apply })).toBeDisabled();
    unmount();
    const allocate = vi.fn();
    render(
      <I18nProvider initial="en">
        <ResourcePlanning allocate={allocate} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: "" }} baseUrl="http://test.invalid" />
      </I18nProvider>,
    );
    expect(screen.getAllByText(r.noWeekTitle).length).toBeGreaterThan(0);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("keeps Apply and its explanation independent, with no nested buttons or duplicate ids", async () => {
    const user = userEvent.setup();
    const { allocation, region } = await planningReady();
    const apply = within(region).getByRole("button", { name: r.apply });
    const info = within(region).getByRole("button", { name: r.applyInfoLabel });
    expect(info.parentElement?.parentElement).toBe(apply.parentElement);
    expect(apply).toHaveAttribute("type", "button");
    await user.click(info);
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(openInfoPopoverKey()).not.toBeNull();
    await user.click(apply);
    await waitFor(() => expect(allocation).toHaveBeenCalledTimes(2)); // same scenario, fresh request
    expect(openInfoPopoverKey()).toBeNull();
    expect(document.querySelector("button button, button a, a button, label button, summary button")).toBeNull();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------- Bangla and styles
describe("resource planning translations and styles", () => {
  it("has identical keys in English and Bangla, with real Bangla text", () => {
    expect(Object.keys(bn.resources).sort()).toEqual(Object.keys(en.resources).sort());
    for (const [k, v] of Object.entries(bn.resources)) {
      const text = typeof v === "function" ? (v as (...a: string[]) => string)("১", "২", "৩", "৪", "৫") : v;
      expect(/[ঀ-৿]/.test(text), k).toBe(true);
    }
  });

  it("renders in Bangla with Bangla digits", async () => {
    const { region } = await planningReady(client(), { lang: "bn" });
    const applied = within(region).getByTestId("applied-parameters");
    expect(applied).toHaveTextContent(bn.resources.appliedLine("২৮ জুলাই ২০২৫", "১০০", "১০০", "৩০", "৬০"));
    expect(within(region).getByRole("table")).toHaveTextContent("৭০ / ৮০");
    expect(region).toHaveTextContent(bn.resources.statusBelow);
    expect(within(region).getByRole("button", { name: bn.resources.apply })).toBeInTheDocument();
  });

  it("uses existing tokens only, keeps wide tables inside their own scroller, and adds no motion", async () => {
    const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
    const css = fs.readFileSync("src/styles.css", "utf8");
    const block = css.slice(css.indexOf("/* ---------- resource planning"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|gradient|box-shadow|transition|animation/);
    expect(block).toMatch(/\.planning-table-wrap \{[^}]*overflow-x: auto;/);
    expect(block).toMatch(/\.planning \{[^}]*min-width: 0;/);
    expect(block).toMatch(/\.planning-cards,\s*\.planning-cities \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 15rem\), 1fr\)\)/);
    for (const token of ["--paper: #eff3ee", "--surface: #fafcf9", "--teal: #0e4f54", "--aqua-soft: #d6ece8", "--focus: #0a6a75", "--crit-bg: #a63429"]) {
      expect(css).toContain(token);
    }
  });
});
