// Phase 2 API layer: typed planning endpoints and the dispatch brief (JSON, text, HTML).
// Payloads are small hand-built copies of the real backend shapes (backend/app/planning/scenario.py,
// dispatch.py). No test contacts a backend: fetch is always stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import clientSource from "./client.ts?raw";
import { createClient, dispositionFilename } from "./client";
import { parseAllocation, parseDispatchBrief, parseHospitalRouting, parseInterventionSimulation, ShapeError } from "./validate";

type Json = Record<string, unknown>;
const BASE = "http://127.0.0.1:8000";
const NOTICE = "Historical replay of a trained model on bundled data through 2025-12-29.";
const WEEKS = ["2025-08-11", "2025-08-18", "2025-08-25"];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const doc = (body: string, type: string, headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": type, ...headers } }));

afterEach(() => vi.unstubAllGlobals());

function env(over: Json = {}): Json {
  return { mode: "historical_replay", notice: NOTICE, issue_date: "2025-07-28", model_version: "dengue-xgb-2to4w-1.1.0", ...over };
}
const pct1 = (a: number, d: number) => (d === 0 ? null : Math.round((1000 * a) / d) / 10);

// ================================================================ /allocation fixture
function resSummary(demand: number, stock: number, allocated: number, short: number, below = 0): Json {
  return { demand, stock, allocated, deficit: demand - allocated, unallocated: stock - allocated, coverage_pct: pct1(allocated, demand), wards_with_deficit: short, wards_below_floor: below };
}
function crewSummary(demand: number, pool: number, assigned: number): Json {
  return { scenario_demand: demand, pool, assigned, scenario_deficit: demand - assigned, coverage_pct: pct1(assigned, demand), wards_with_scenario_deficit: demand > assigned ? 1 : 0, wards_below_floor: 0 };
}
function wardRes(demand: number, allocated: number): Json {
  const deficit = demand - allocated;
  return {
    demand, floor: Math.ceil(0.3 * demand), allocated, deficit, coverage_pct: pct1(allocated, demand),
    critical_deficit: deficit > 0, severity: deficit > 0 ? "partial" : "no_deficit", reason: demand === 0 ? "no_demand" : deficit > 0 ? "partial_priority" : "fulfilled",
  };
}
function wardCrew(demand: number, assigned: number): Json {
  const deficit = demand - assigned;
  return { scenario_demand: demand, floor: Math.ceil(0.3 * demand), assigned, scenario_deficit: deficit, coverage_pct: pct1(assigned, demand),
    scenario_crew_deficit: deficit > 0, severity: deficit > 0 ? "partial" : "no_deficit", reason: demand === 0 ? "no_demand" : deficit > 0 ? "partial_priority" : "fulfilled" };
}
function allocWard(id: string, city: string, rank: number, tier: string, s: [number, number], k: [number, number], c: [number, number]): Json {
  return {
    ward_id: id, city, priority_rank_in_city: rank,
    priority: { risk_tier: tier, early_alert: tier === "Critical", population_density_sqkm: 40000, predicted_cases_3wk: s[0] / 2.38485 },
    saline: wardRes(...s), kits: wardRes(...k), crews: wardCrew(...c),
    bed_plan: { peak_forecast_week: WEEKS[1], peak_horizon_week: 3, peak_week_expected_cases: 3.2, bed_planning_demand: 1, weekly_source: "companion" },
    exceeds_observed_range: false,
  };
}
function makeAllocation(): Json {
  return env({
    policy: { name: "minimum_coverage_then_risk_priority", description: "Deterministic, fairness-first greedy allocation." },
    parameters: {
      stock_pct: { saline: 75, kits: 75 }, min_coverage_pct: 30, total_crews: 2, rounding: "ROUND_HALF_UP",
      coefficients: { saline: "2.38485", kits: "1.16422", beds: "0.29844" }, coefficient_intervals: { saline: ["143/60", "105/44"] },
      crew_rule: { eligible_tiers: ["Medium", "High", "Critical"], density_per_crew_sqkm: 12000, max_crews_per_ward: 6, status: "hypothetical_scenario" },
      priority_key: ["risk_tier", "early_alert", "population_density_sqkm", "predicted_cases_3wk", "ward_id"],
    },
    weekly_source: "companion",
    assumptions: ["100% stock means 100% of forecast planning demand in each city, not verified municipal inventory."],
    limitations: ["Historical replay on data that appear simulated; not a live or official plan."],
    region: {
      saline: resSummary(20, 15, 15, 3), kits: resSummary(10, 7, 7, 3),
      crews: { ...crewSummary(3, 2, 2), total_crews: 2, unassigned: 0 },
      beds: { planning_demand: 3, capacity_and_routing: "not_computed" },
    },
    cities: [
      { city: "Gazipur", ward_count: 2, saline: resSummary(16, 12, 12, 2), kits: resSummary(8, 6, 6, 2), crews: crewSummary(2, 1, 1), beds: { planning_demand: 2, capacity_and_routing: "not_computed" } },
      { city: "Narayanganj", ward_count: 1, saline: resSummary(4, 3, 3, 1), kits: resSummary(2, 1, 1, 1), crews: crewSummary(1, 1, 1), beds: { planning_demand: 1, capacity_and_routing: "not_computed" } },
    ],
    wards: [
      allocWard("GCC_Ward_01", "Gazipur", 1, "Critical", [10, 8], [5, 4], [2, 1]),
      allocWard("GCC_Ward_02", "Gazipur", 2, "Low", [6, 4], [3, 2], [0, 0]),
      allocWard("NCC_Ward_01", "Narayanganj", 1, "High", [4, 3], [2, 1], [1, 1]),
    ],
  });
}

// ================================================================ /hospital-routing fixture
function hs(cap: number, demand: number, local: number, units: number, unmet = 0): Json {
  const occupied = Math.min(cap, demand);
  return {
    hypothetical_capacity: cap, bed_planning_demand: demand, locally_assigned: local, transfer_units: units,
    transfer_edges: units ? 1 : 0, sending_wards: units ? 1 : 0, receiving_wards: units ? 1 : 0,
    occupied_after_routing: occupied, unmet_after_routing: unmet, spare_after_routing: cap - occupied,
    wards_with_unmet: unmet ? 1 : 0, utilization_pct: pct1(occupied, cap), demand_to_capacity_pct: pct1(demand, cap), utilization_status: cap === 0 ? "no_capacity" : "ok",
  };
}
function hWardWeek(h: number, demand: number, local: number, out: number, inn: number, cap: number): Json {
  const occupied = local + inn;
  return { horizon_week: h, forecast_week: WEEKS[h - 2], bed_planning_demand: demand, locally_assigned: local, transferred_out: out, transferred_in: inn,
    unmet_after_routing: demand - local - out, occupied_after_routing: occupied, spare_after_routing: cap - occupied };
}
function makeHospital(): Json {
  const week = (h: number, gz: Json, ng: Json, transfers: Json[]) => {
    const g = gz as Record<string, number>;
    const n = ng as Record<string, number>;
    return {
      horizon_week: h, forecast_week: WEEKS[h - 2],
      region: hs(g.hypothetical_capacity! + n.hypothetical_capacity!, g.bed_planning_demand! + n.bed_planning_demand!, g.locally_assigned! + n.locally_assigned!, g.transfer_units! + n.transfer_units!),
      cities: [{ city: "Gazipur", ...gz }, { city: "Narayanganj", ...ng }],
      transfers,
    };
  };
  return env({
    issue_date: "2023-08-07",
    policy: { name: "within_city_overflow_routing", description: "Per forecast week and city ..." },
    parameters: {
      capacity_pct: 75, capacity_rule: "floor(capacity_pct x city_baseline / 100)", city_baseline_beds: { Gazipur: 5, Narayanganj: 3 },
      baseline_definition: "Mean over 2016-2023 ...", baseline_years: [2016, 2023], baseline_status: "hypothetical_retrospective_scenario",
      bed_coefficient: "0.29844", rounding: "ROUND_HALF_UP", units: "bed planning units per forecast week (not patients, admissions or occupied beds)",
      connectivity: "all ward pairs within a city; no cross-city transfers", sender_rule: "lowest served ratio", receiver_rule: "lowest occupancy ratio",
    },
    weekly_source: "companion",
    assumptions: ["Bed planning units are forecast-derived planning quantities, not patients, admissions or occupied beds."],
    limitations: ["No hospital locations, distances, travel times, specialties or real occupancy are available or used."],
    warnings: ["Issue week 2023-08-07 is before 2024: the capacity baseline was calibrated on 2016-2023 data (retrospective scenario)."],
    capacity: {
      cities: [{ city: "Gazipur", ward_count: 2, baseline: 5, hypothetical_capacity: 4 }, { city: "Narayanganj", ward_count: 1, baseline: 3, hypothetical_capacity: 2 }],
      region_hypothetical_capacity: 6,
    },
    weeks: [
      week(2, hs(4, 3, 3, 0), hs(2, 1, 1, 0), []),
      week(3, hs(4, 3, 3, 0), hs(2, 1, 1, 0), []),
      week(4, hs(4, 3, 2, 1), hs(2, 1, 1, 0), [{ city: "Gazipur", horizon_week: 4, forecast_week: WEEKS[2], from_ward: "GCC_Ward_01", to_ward: "GCC_Ward_02", units: 1 }]),
    ],
    headline_week_by_city: { Gazipur: { horizon_week: 4, forecast_week: WEEKS[2] }, Narayanganj: { horizon_week: 2, forecast_week: WEEKS[0] } },
    wards: [
      { ward_id: "GCC_Ward_01", city: "Gazipur", priority_rank_in_city: 1, risk_tier: "Critical", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 3,
        weeks: [hWardWeek(2, 2, 2, 0, 0, 2), hWardWeek(3, 2, 2, 0, 0, 2), hWardWeek(4, 3, 2, 1, 0, 2)] },
      { ward_id: "GCC_Ward_02", city: "Gazipur", priority_rank_in_city: 2, risk_tier: "Low", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 1,
        weeks: [hWardWeek(2, 1, 1, 0, 0, 2), hWardWeek(3, 1, 1, 0, 0, 2), hWardWeek(4, 0, 0, 0, 1, 2)] },
      { ward_id: "NCC_Ward_01", city: "Narayanganj", priority_rank_in_city: 1, risk_tier: "High", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 1,
        weeks: [hWardWeek(2, 1, 1, 0, 0, 2), hWardWeek(3, 1, 1, 0, 0, 2), hWardWeek(4, 1, 1, 0, 0, 2)] },
    ],
  });
}

// ================================================================ /intervention-simulation fixture
const M = { low: 0.15, base: 0.35, high: 0.55 } as const;
function totals(crews: number, baseline: number, avoided: number, city?: string): Json {
  return {
    ...(city ? { city } : {}),
    baseline_cases_3wk: baseline, scenario_adjusted_cases_3wk: baseline - avoided, projected_cases_avoided: avoided, assigned_crews: crews,
    projected_cases_avoided_per_assigned_crew: crews === 0 ? null : Math.round((1000 * avoided) / crews) / 1000,
    saline: { baseline_units: 48, scenario_adjusted_units: 46, projected_units_avoided: 2 },
    kits: { baseline_units: 24, scenario_adjusted_units: 23, projected_units_avoided: 1 },
    weekly_bed_planning_units: WEEKS.map((fw, i) => ({ horizon_week: i + 2, forecast_week: fw, baseline: 3, scenario_adjusted: 3, projected_units_avoided: 0 })),
    sum_of_ward_peak_bed_planning_reductions: 0,
  };
}
function wardScen(crews: number, m: number): Json {
  const r = crews ? m * 0.6 : 0;
  const avoided = crews ? 1.2 * m : 0;
  return {
    effective_reduction_by_week: [0.5 * r, 0.85 * r, r], scenario_adjusted_weekly_cases: [3, 3.5, 4], projected_cases_avoided: avoided,
    projected_cases_avoided_per_assigned_crew: crews ? avoided / crews : null,
    saline: { scenario_adjusted_units: 20, projected_units_avoided: 1 }, kits: { scenario_adjusted_units: 10, projected_units_avoided: 0 },
    weekly_bed_planning_units: { scenario_adjusted: [1, 1, 1], projected_units_avoided: [0, 0, 0] },
    peak_bed_planning_units: { scenario_adjusted: 1, projected_reduction: 0 },
  };
}
function intWard(id: string, city: string, rank: number, demand: number, assigned: number): Json {
  return {
    ward_id: id, city, priority_rank_in_city: rank, risk_tier: demand ? "High" : "Low", early_alert: false, population_density_sqkm: 30000,
    predicted_cases_3wk: 10.5, baseline_weekly_cases: [3, 3.5, 4],
    baseline_planning_units: { saline: 25, kits: 12, weekly_bed_planning_units: [1, 1, 1], peak_bed_planning_units: 1 },
    crews: { scenario_demand: demand, assigned, coverage: assigned / 2.5, next_crew_status: demand === 0 ? "ineligible" : assigned >= demand ? "at_cap" : "available",
      next_crew_projected_cases_avoided_base: demand === 0 || assigned >= demand ? null : 0.8 },
    scenarios: { low: wardScen(assigned, M.low), base: wardScen(assigned, M.base), high: wardScen(assigned, M.high) },
  };
}
function makeIntervention(totalCrews = 2): Json {
  const assigned = Math.min(totalCrews, 2);
  const gz = Math.min(assigned, 1);
  const ng = assigned - gz;
  // explicit values (not computed) so expectations never depend on float arithmetic
  const AVOIDED = { 0.15: [0.45, 0.3, 0.15], 0.35: [1.05, 0.7, 0.35], 0.55: [1.65, 1.1, 0.55] } as Record<number, number[]>;
  const scen = (m: number) => {
    const [r, g, n] = AVOIDED[m]!;
    return {
      max_reduction: m,
      region: totals(assigned, 31.5, assigned ? r! : 0),
      cities: [totals(gz, 21, gz ? g! : 0, "Gazipur"), totals(ng, 10.5, ng ? n! : 0, "Narayanganj")],
    };
  };
  return env({
    policy: {
      name: "assumed_effect_scenarios_on_ml_baseline", causal: false, effect_size_basis: "assumed_scenario_not_learned", crew_capacity_status: "hypothetical",
      crew_assignment_source: "task2_minimum_coverage_then_risk_priority", timing: "Effects are assumed to ramp across weeks t+2, t+3 and t+4.", description: "R = M x (1 - exp(-1.4 x coverage))",
    },
    parameters: {
      scenarios: { ...M }, saturation_k: 1.4, density_per_crew_sqkm: 12000, max_crews_per_ward: 6, ramp_by_horizon_week: { "2": 0.5, "3": 0.85, "4": 1.0 },
      total_crews: totalCrews, min_coverage_pct: 30, include_roi_alternative: false, coefficients: { saline: "2.38485" }, rounding: "ROUND_HALF_UP",
      roi_definition: "projected cases avoided over t+2..t+4 / assigned crews (not financial); null if 0 crews",
    },
    weekly_source: "companion",
    forecast_weeks: [...WEEKS],
    assumptions: ["Assumed: the low / base / high maximum reductions (15% / 35% / 55%)."],
    limitations: ["The simulator applies hypothetical effects to an ML-derived baseline. It does not estimate or establish causal effectiveness."],
    warnings: [],
    crews: { total_crews: totalCrews, scenario_demand: 3, assigned, unassigned: totalCrews - assigned, city_pools: { Gazipur: gz, Narayanganj: ng } },
    scenarios: { low: scen(M.low), base: scen(M.base), high: scen(M.high) },
    wards: [intWard("GCC_Ward_01", "Gazipur", 1, 2, gz), intWard("GCC_Ward_02", "Gazipur", 2, 0, 0), intWard("NCC_Ward_01", "Narayanganj", 1, 1, ng)],
    first_crew_ranking: [
      { rank: 1, ward_id: "GCC_Ward_01", city: "Gazipur", first_crew_projected_cases_avoided: 1.1, assigned_crews: gz },
      { rank: 2, ward_id: "NCC_Ward_01", city: "Narayanganj", first_crew_projected_cases_avoided: 0.9, assigned_crews: ng },
    ],
    roi_alternative: null,
  });
}
function withAlternative(): Json {
  const d = makeIntervention();
  (d.parameters as Json).include_roi_alternative = true;
  const cmp = (p: number) => ({ primary_projected_cases_avoided: p, alternative_projected_cases_avoided: p + 0.1, difference: 0.1, difference_pct: 2.5 });
  const byS = (p: number) => ({ region: cmp(p), cities: [{ city: "Gazipur", ...cmp(p) }, { city: "Narayanganj", ...cmp(p), difference_pct: null }] });
  d.roi_alternative = {
    status: "hypothetical_assumption_dependent", objective: "maximise total projected cases avoided (base scenario)", ranking_scenario: "base",
    city_pools: { Gazipur: 1, Narayanganj: 1 }, assigned_crews: 2,
    wards: [{ ward_id: "GCC_Ward_01", city: "Gazipur", primary_crews: 1, alternative_crews: 1 }, { ward_id: "NCC_Ward_01", city: "Narayanganj", primary_crews: 1, alternative_crews: 1 }],
    comparison: { low: byS(0.45), base: byS(1.05), high: byS(1.65) },
  };
  return d;
}

// ================================================================ /dispatch-brief fixture (JSON)
const SID = "DO-20250728-S60-F30-C40-H75-IBASE-WC";
function makeBrief(over: Json = {}): Json {
  return {
    mode: "historical_replay", notice: NOTICE, brief_version: "dispatch-brief-1.0",
    status: {
      draft: true, sent: false, authorised: false, simulated: true, historical_replay: true, human_verification_required: true, dispatch_capability: "none",
      labels: ["DRAFT / NOT SENT", "SIMULATED PLANNING SCENARIO", "HISTORICAL REPLAY", "HUMAN VERIFICATION REQUIRED"],
      statement: "Draft generated for planning review only. It has not been sent to anyone and authorises no action.",
    },
    scenario_id: SID, document_id: `${SID}.CITY-DHAKA-SOUTH.ALL.DETAILED`, scenario_fingerprint: "7d2093c8643fbe78",
    scope: { type: "city", city: "Dhaka South", ward_id: null, display_name: "Dhaka South", ward_count: 20 },
    audience: "all", variant: "detailed", intended_role: "City planning coordinator (role label only; no recipient or contact details)",
    scenario: {
      issue_week: "2025-07-28", forecast_weeks: [...WEEKS], horizon_weeks: [2, 3, 4], model_version: "dengue-xgb-2to4w-1.1.0", weekly_source: "companion",
      weekly_model_version: "weekly-xgb-2to4w-1.0.0", parameters: { stock_pct: 60, min_coverage_pct: 30, total_crews: 40, capacity_pct: 75, intervention_scenario: "base" }, notice: NOTICE,
    },
    sections_included: ["forecast_estimates", "resource_plan", "crew_scenario", "hospital_overflow", "intervention_scenario"],
    sections: {
      forecast_estimates: { label: "FORECAST-DERIVED ESTIMATES", ward_count: 20, predicted_cases_3wk_total: 446.96 },
      resource_plan: { label: "SUGGESTED ALLOCATION - HYPOTHETICAL STOCK SCENARIO", stock_pct: 60, saline: { demand: 1065, allocated: 639 } },
      crew_scenario: { label: "HYPOTHETICAL CREW SCENARIO", status: "hypothetical" },
      hospital_overflow: { label: "HYPOTHETICAL CAPACITY - SIMULATED WITHIN-CITY REASSIGNMENT", units: "bed planning units per forecast week (not patients, admissions or occupied beds)", capacity_status: "hypothetical_retrospective_scenario", simulated_transfers: [] },
      intervention_scenario: { label: "ASSUMED-EFFECT INTERVENTION SCENARIO - NOT CAUSAL", causal: false, selected_scenario: "base" },
    },
    verification_checklist: ["Draft reviewed, and any action decided, by the responsible coordinator role."],
    warnings: [], assumptions: ["Stock percentage, crew budget and bed capacity are hypothetical scenario inputs."],
    limitations: ["Nothing in this brief has been sent, carried out or authorised."],
    ...over,
  };
}
const SHORT_TEXT = `DRAFT/NOT SENT. SIMULATED PLANNING SCENARIO. HISTORICAL REPLAY.\n${SID}\nDhaka South: issue 2025-07-28.\nEstimates only. HUMAN VERIFICATION REQUIRED before any action.`;
const PRINT_HTML = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>DRAFT dispatch brief</title><style>body{color:#000}</style></head><body><header><p>DRAFT / NOT SENT | SIMULATED PLANNING SCENARIO</p></header><main><h1>Draft dispatch brief: Dhaka South</h1></main></body></html>\n`;

/** Sets a value at a dotted path on a deep copy and returns it. */
function patch(src: Json, path: string, value: unknown): Json {
  const d = clone(src);
  const keys = path.split(".");
  let cur: Record<string, unknown> = d;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return d;
}

// ================================================================ tests: allocation
describe("allocation parsing", () => {
  it("keeps the backend's values for regions, cities and wards", () => {
    const a = parseAllocation(makeAllocation());
    expect(a.mode).toBe("historical_replay");
    expect(a.parameters.stock_pct).toEqual({ saline: 75, kits: 75 });
    expect(a.region.saline).toMatchObject({ demand: 20, stock: 15, allocated: 15, deficit: 5, wards_with_deficit: 3 });
    expect(a.region.crews).toMatchObject({ total_crews: 2, assigned: 2, unassigned: 0, scenario_demand: 3 });
    expect(a.cities.map((c) => c.city)).toEqual(["Gazipur", "Narayanganj"]);
    const w = a.wards[0]!;
    expect(w.priority.risk_tier).toBe("Critical");
    expect(w.saline).toMatchObject({ demand: 10, allocated: 8, deficit: 2, critical_deficit: true, reason: "partial_priority" });
    expect(w.crews).toMatchObject({ scenario_demand: 2, assigned: 1, scenario_crew_deficit: true });
    expect(a.wards[1]!.crews.coverage_pct).toBeNull(); // no crew demand -> null coverage, kept as null
    expect(a.limitations[0]).toContain("not a live or official plan");
    expect(a.parameters.crew_rule.status).toBe("hypothetical_scenario");
  });

  it.each([
    ["negative demand", "wards.0.saline.demand", -1],
    ["fractional units", "wards.0.saline.allocated", 7.5],
    ["NaN quantity", "region.kits.stock", Number.NaN],
    ["infinite quantity", "cities.0.saline.stock", Number.POSITIVE_INFINITY],
    ["numeric string", "wards.0.kits.demand", "5"],
    ["unknown risk tier", "wards.1.priority.risk_tier", "Severe"],
    ["unknown severity", "wards.0.saline.severity", "awful"],
    ["unknown reason", "wards.0.crews.reason", "luck"],
    ["deficit does not balance", "wards.0.saline.deficit", 1],
    ["critical flag contradicts deficit", "wards.0.kits.critical_deficit", false],
    ["crews above the ward cap", "wards.0.crews.scenario_demand", 7],
    ["more crews than demand", "wards.2.crews.assigned", 2],
    ["crew flag contradicts deficit", "wards.0.crews.scenario_crew_deficit", false],
    ["coverage above 100%", "wards.0.saline.coverage_pct", 101],
    ["ward in an unknown city", "wards.2.city", "Atlantis"],
    ["ward count mismatch", "cities.0.ward_count", 3],
    ["region crews do not balance", "region.crews.unassigned", 1],
    ["missing region", "region", undefined],
    ["missing wards", "wards", undefined],
    ["wrong mode", "mode", "live"],
    ["bad issue date", "issue_date", "2025-02-30"],
    ["unknown weekly source", "weekly_source", "magic"],
    ["peak week outside t+2..t+4", "wards.0.bed_plan.peak_horizon_week", 5],
  ])("rejects malformed allocation data: %s", (_label, path, value) => {
    const bad = patch(makeAllocation(), path, value);
    expect(() => parseAllocation(bad)).toThrow(ShapeError);
  });

  it("rejects duplicate wards", () => {
    const d = makeAllocation();
    (d.wards as Json[]).push(clone((d.wards as Json[])[2]!));
    (d.cities as Json[])[1]!.ward_count = 2;
    expect(() => parseAllocation(d)).toThrow(ShapeError);
  });
});

// ================================================================ tests: hospital routing
describe("hospital routing parsing", () => {
  it("keeps week-specific routing, simulated transfers, headline weeks and warnings", () => {
    const h = parseHospitalRouting(makeHospital());
    expect(h.parameters.units).toContain("not patients");
    expect(h.parameters.baseline_status).toBe("hypothetical_retrospective_scenario");
    expect(h.capacity.region_hypothetical_capacity).toBe(6);
    expect(h.weeks.map((w) => w.horizon_week)).toEqual([2, 3, 4]);
    expect(h.weeks[2]!.transfers).toEqual([{ city: "Gazipur", horizon_week: 4, forecast_week: "2025-08-25", from_ward: "GCC_Ward_01", to_ward: "GCC_Ward_02", units: 1 }]);
    expect(h.weeks[2]!.cities[0]).toMatchObject({ city: "Gazipur", transfer_units: 1, locally_assigned: 2, unmet_after_routing: 0 });
    expect(h.headline_week_by_city.Gazipur).toEqual({ horizon_week: 4, forecast_week: "2025-08-25" });
    expect(h.wards[0]!.weeks[2]).toMatchObject({ transferred_out: 1, unmet_after_routing: 0 });
    expect(h.warnings[0]).toContain("retrospective");
  });

  const TRANSFER = "weeks.2.transfers.0";
  it.each([
    ["zero transfer units", `${TRANSFER}.units`, 0],
    ["negative transfer units", `${TRANSFER}.units`, -1],
    ["fractional transfer units", `${TRANSFER}.units`, 0.5],
    ["transfer to another city", `${TRANSFER}.to_ward`, "NCC_Ward_01"],
    ["transfer to itself", `${TRANSFER}.to_ward`, "GCC_Ward_01"],
    ["transfer to an unknown ward", `${TRANSFER}.from_ward`, "XYZ_Ward_99"],
    ["transfer in the wrong week", `${TRANSFER}.horizon_week`, 3],
    ["city transfer total does not match records", "weeks.2.cities.0.transfer_units", 2],
    ["missing capacity metadata", "capacity", undefined],
    ["missing capacity cities", "capacity.cities", undefined],
    ["malformed city row", "weeks.0.cities.1", "Narayanganj"],
    ["unknown utilization status", "weeks.0.region.utilization_status", "full"],
    ["capacity does not balance", "weeks.0.cities.0.spare_after_routing", 9],
    ["ward with two weeks", "wards.0.weeks", [hWardWeek(2, 2, 2, 0, 0, 2), hWardWeek(3, 2, 2, 0, 0, 2)]],
    ["malformed ward record", "wards.1", ["GCC_Ward_02"]],
    ["missing headline for a city", "headline_week_by_city.Narayanganj", undefined],
    ["headline week not routed", "headline_week_by_city.Gazipur.forecast_week", "2025-09-01"],
    ["warnings not a list", "warnings", "retrospective"],
  ])("rejects malformed routing data: %s", (_label, path, value) => {
    const bad = patch(makeHospital(), path, value);
    expect(() => parseHospitalRouting(bad)).toThrow(ShapeError);
  });
});

// ================================================================ tests: intervention simulation
describe("intervention simulation parsing", () => {
  it("keeps low/base/high scenarios, assumptions and causal=false", () => {
    const s = parseInterventionSimulation(makeIntervention());
    expect(s.policy.causal).toBe(false);
    expect(s.policy.effect_size_basis).toBe("assumed_scenario_not_learned");
    expect(Object.keys(s.scenarios)).toEqual(["low", "base", "high"]);
    expect(s.parameters.scenarios).toEqual({ low: 0.15, base: 0.35, high: 0.55 });
    expect(s.parameters.ramp_by_horizon_week).toEqual({ "2": 0.5, "3": 0.85, "4": 1 });
    expect(s.scenarios.base.region).toMatchObject({ baseline_cases_3wk: 31.5, projected_cases_avoided: 1.05, assigned_crews: 2 });
    expect(s.scenarios.base.region.projected_cases_avoided_per_assigned_crew).toBe(0.525);
    expect(s.wards[1]!.crews.next_crew_status).toBe("ineligible");
    expect(s.wards[1]!.scenarios.high.projected_cases_avoided_per_assigned_crew).toBeNull();
    expect(s.first_crew_ranking.map((r) => r.rank)).toEqual([1, 2]);
    expect(s.roi_alternative).toBeNull();
    expect(s.limitations[0]).toContain("does not estimate or establish causal effectiveness");
  });

  it("keeps ROI as null when no crews are assigned", () => {
    const s = parseInterventionSimulation(makeIntervention(0));
    expect(s.crews.assigned).toBe(0);
    for (const k of ["low", "base", "high"] as const) {
      expect(s.scenarios[k].region.projected_cases_avoided_per_assigned_crew).toBeNull();
      expect(s.scenarios[k].region.projected_cases_avoided).toBe(0);
    }
  });

  it("parses the optional ROI alternative only when requested", () => {
    const s = parseInterventionSimulation(withAlternative());
    expect(s.roi_alternative?.status).toBe("hypothetical_assumption_dependent");
    expect(s.roi_alternative?.comparison.base.region.difference).toBe(0.1);
    expect(s.roi_alternative?.comparison.low.cities[1]!.difference_pct).toBeNull();
    expect(() => parseInterventionSimulation(patch(withAlternative(), "roi_alternative", null))).toThrow(ShapeError);
    expect(() => parseInterventionSimulation(patch(withAlternative(), "parameters.include_roi_alternative", false))).toThrow(ShapeError);
    expect(() => parseInterventionSimulation(patch(withAlternative(), "roi_alternative.city_pools.Gazipur", 5))).toThrow(ShapeError);
  });

  it.each([
    ["causal true", "policy.causal", true],
    ["causal missing", "policy.causal", undefined],
    ["causal as string", "policy.causal", "false"],
    ["extra scenario", "scenarios.extreme", clone(makeIntervention().scenarios as Json).high],
    ["missing high scenario", "scenarios.high", undefined],
    ["assumed effect of 100%", "parameters.scenarios.high", 1],
    ["negative assumed effect", "parameters.scenarios.low", -0.1],
    ["scenario effects out of order", "parameters.scenarios.low", 0.5],
    ["max_reduction differs from parameters", "scenarios.base.max_reduction", 0.3],
    ["ramp above 1", "parameters.ramp_by_horizon_week.4", 1.2],
    ["ramp missing a week", "parameters.ramp_by_horizon_week.3", undefined],
    ["zero saturation", "parameters.saturation_k", 0],
    ["ROI 0 instead of null with no crews", "wards.1.scenarios.base.projected_cases_avoided_per_assigned_crew", 0],
    ["ROI null with crews assigned", "scenarios.base.region.projected_cases_avoided_per_assigned_crew", null],
    ["negative projected avoided cases", "scenarios.low.cities.0.projected_cases_avoided", -1],
    ["avoided cases above baseline", "scenarios.high.region.projected_cases_avoided", 40],
    ["units do not balance", "scenarios.base.region.saline.projected_units_avoided", 5],
    ["reduction of 100% or more", "wards.0.scenarios.base.effective_reduction_by_week", [0.1, 0.2, 1]],
    ["two weekly values", "wards.0.baseline_weekly_cases", [3, 3.5]],
    ["weekly bed units for two weeks", "scenarios.base.region.weekly_bed_planning_units", []],
    ["crews above demand", "wards.0.crews.assigned", 3],
    ["unknown next-crew status", "wards.0.crews.next_crew_status", "maybe"],
    ["ranking out of sequence", "first_crew_ranking.1.rank", 3],
    ["crew budget does not balance", "crews.unassigned", 4],
    ["alternative present but not requested", "roi_alternative", { status: "x" }],
    ["city missing from a scenario", "scenarios.low.cities", []],
  ])("rejects malformed simulation data: %s", (_label, path, value) => {
    const bad = patch(makeIntervention(), path, value);
    expect(() => parseInterventionSimulation(bad)).toThrow(ShapeError);
  });
});

// ================================================================ tests: dispatch brief JSON
describe("dispatch brief parsing (JSON)", () => {
  it("keeps the draft / not-sent status, identifiers, scope and sections", () => {
    const b = parseDispatchBrief(makeBrief());
    expect(b.status).toMatchObject({ draft: true, sent: false, authorised: false, simulated: true, historical_replay: true, human_verification_required: true, dispatch_capability: "none" });
    expect(b.status.labels).toContain("DRAFT / NOT SENT");
    expect(b.scenario_id).toBe(SID);
    expect(b.scope).toEqual({ type: "city", city: "Dhaka South", ward_id: null, display_name: "Dhaka South", ward_count: 20 });
    expect(b.scenario.parameters).toEqual({ stock_pct: 60, min_coverage_pct: 30, total_crews: 40, capacity_pct: 75, intervention_scenario: "base" });
    expect(b.sections_included).toHaveLength(5);
    expect(b.sections.intervention_scenario?.causal).toBe(false);
    expect(b.sections.resource_plan?.saline).toEqual({ demand: 1065, allocated: 639 }); // other planning fields kept as sent
  });

  it("accepts a ward-scope brief with only the hospital sections", () => {
    const b = parseDispatchBrief(
      makeBrief({
        scope: { type: "ward", city: "Dhaka South", ward_id: "DSCC_Ward_04", display_name: "DSCC Ward 04" },
        document_id: `${SID}.WARD-DSCC-WARD-04.HOSPITAL.SHORT`, audience: "hospital", variant: "short",
        sections_included: ["forecast_estimates", "hospital_overflow"],
        sections: { forecast_estimates: (makeBrief().sections as Json).forecast_estimates, hospital_overflow: (makeBrief().sections as Json).hospital_overflow },
      }),
    );
    expect(b.scope.ward_id).toBe("DSCC_Ward_04");
    expect(b.scope.ward_count).toBeUndefined();
    expect(Object.keys(b.sections)).toEqual(["forecast_estimates", "hospital_overflow"]);
  });

  it.each([
    ["marked as sent", "status.sent", true],
    ["marked as authorised", "status.authorised", true],
    ["not a draft", "status.draft", false],
    ["not simulated", "status.simulated", false],
    ["not historical replay", "status.historical_replay", false],
    ["no human verification", "status.human_verification_required", false],
    ["claims a dispatch capability", "status.dispatch_capability", "sms"],
    ["draft label missing", "status.labels", ["SIMULATED PLANNING SCENARIO"]],
    ["malformed scenario id", "scenario_id", "DO-2025-07-28"],
    ["scenario id for another issue week", "scenario_id", "DO-20250804-S60-F30-C40-H75-IBASE-WC"],
    ["document id of another scenario", "document_id", "DO-20250728-S99-F30-C40-H75-IBASE-WC.CITY-DHAKA-SOUTH.ALL.DETAILED"],
    ["document id with unsafe characters", "document_id", `${SID}.CITY-<script>`],
    ["bad fingerprint", "scenario_fingerprint", "xyz"],
    ["city scope with a ward id", "scope.ward_id", "DSCC_Ward_04"],
    ["unknown scope", "scope.type", "region"],
    ["unknown audience", "audience", "press"],
    ["unknown intervention scenario", "scenario.parameters.intervention_scenario", "extreme"],
    ["unknown section", "sections_included", ["forecast_estimates", "send_queue"]],
    ["sections do not match the list", "sections.crew_scenario", undefined],
    ["intervention section claims causality", "sections.intervention_scenario.causal", true],
    ["hospital units not marked as planning units", "sections.hospital_overflow.units", "beds"],
    ["section with a wrong label", "sections.resource_plan.label", "DISPATCHED SUPPLIES"],
    ["empty verification checklist", "verification_checklist", []],
    ["wrong horizon weeks", "scenario.horizon_weeks", [1, 2, 3]],
    ["wrong mode", "mode", "live"],
  ])("rejects an unsafe or malformed brief: %s", (_label, path, value) => {
    const bad = patch(makeBrief(), path, value);
    expect(() => parseDispatchBrief(bad)).toThrow(ShapeError);
  });

  it("rejects a ward-scope brief without a ward id", () => {
    expect(() => parseDispatchBrief(makeBrief({ scope: { type: "ward", city: "Dhaka South", ward_id: null, display_name: "x" } }))).toThrow(ShapeError);
  });
});

// ================================================================ tests: client requests
describe("planning client requests", () => {
  it("sends only the parameters that were given, as read-only GET requests", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (url.includes("/allocation")) return json(makeAllocation());
      if (url.includes("/hospital-routing")) return json(makeHospital());
      return json(makeIntervention());
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = createClient(`${BASE}/`);
    await c.allocation();
    await c.allocation({ issue_date: "2025-07-28", stock_pct: 60, min_coverage_pct: 30, total_crews: 40 });
    await c.allocation({ stock_pct: 70, stock_pct_saline: 50, stock_pct_kits: 90 });
    await c.hospitalRouting({ issue_date: "2023-08-07", capacity_pct: 75 });
    await c.interventionSimulation({ total_crews: 0, include_roi_alternative: false });
    await c.interventionSimulation({ issue_date: "2025-07-28", total_crews: 60, min_coverage_pct: 30 });
    expect(fetchMock.mock.calls.map((a) => [a[0], (a[1] as RequestInit).method, new Headers((a[1] as RequestInit).headers).get("accept")])).toEqual([
      [`${BASE}/allocation`, "GET", "application/json"],
      [`${BASE}/allocation?issue_date=2025-07-28&stock_pct=60&min_coverage_pct=30&total_crews=40`, "GET", "application/json"],
      [`${BASE}/allocation?stock_pct=70&stock_pct_saline=50&stock_pct_kits=90`, "GET", "application/json"],
      [`${BASE}/hospital-routing?issue_date=2023-08-07&capacity_pct=75`, "GET", "application/json"],
      [`${BASE}/intervention-simulation?total_crews=0&include_roi_alternative=false`, "GET", "application/json"],
      [`${BASE}/intervention-simulation?issue_date=2025-07-28&total_crews=60&min_coverage_pct=30`, "GET", "application/json"],
    ]);
  });

  it("encodes query values safely", async () => {
    const fetchMock = vi.fn((url: string) => {
      void url;
      return json({ error: { code: "invalid_date", message: "Invalid date." } }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);
    await createClient(BASE).allocation({ issue_date: "2025-07-28&total_crews=9999#x" }).catch(() => undefined);
    await createClient(BASE).dispatchBrief({ scope: "ward", ward_id: "DSCC_Ward_04/../x?y" }).catch(() => undefined);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/allocation?issue_date=2025-07-28%26total_crews%3D9999%23x`);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/dispatch-brief?scope=ward&ward_id=DSCC_Ward_04%2F..%2Fx%3Fy&format=json`);
  });

  it("refuses non-finite query numbers without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createClient(BASE).allocation({ stock_pct: Number.NaN })).rejects.toThrow(TypeError);
    await expect(createClient(BASE).hospitalRouting({ capacity_pct: Number.POSITIVE_INFINITY })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns malformed planning responses into shape errors", async () => {
    vi.stubGlobal("fetch", () => json(patch(makeIntervention(), "policy.causal", true)));
    await expect(createClient(BASE).interventionSimulation()).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => json(patch(makeHospital(), "weeks.2.transfers.0.to_ward", "NCC_Ward_01")));
    await expect(createClient(BASE).hospitalRouting()).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("not json", { status: 200 })));
    await expect(createClient(BASE).allocation()).rejects.toMatchObject({ kind: "shape" });
  });

  it("maps the backend error envelope for planning endpoints", async () => {
    vi.stubGlobal("fetch", () => json({ error: { code: "validation_error", message: "Request validation failed.", details: [] } }, 422));
    await expect(createClient(BASE).allocation({ stock_pct: 10 })).rejects.toMatchObject({ kind: "http", status: 422, code: "validation_error" });
    vi.stubGlobal("fetch", () => json({ error: { code: "planning_data_invalid", message: "The forecast data could not be converted into a resource plan." } }, 500));
    await expect(createClient(BASE).hospitalRouting()).rejects.toMatchObject({ kind: "http", status: 500, code: "planning_data_invalid" });
  });

  it("reports network failure, timeout and caller abort for the new methods", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(createClient(BASE).hospitalRouting()).rejects.toMatchObject({ kind: "network" });
    // like real fetch: rejects at once for an already-aborted signal, otherwise when it is aborted
    const hang = (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        if (init.signal?.aborted) rej(new DOMException("a", "AbortError"));
        init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")));
      });
    vi.stubGlobal("fetch", hang);
    await expect(createClient(BASE, 20).dispatchDocument({ scope: "city", city: "Dhaka South" }, "text")).rejects.toMatchObject({ kind: "timeout" });
    const ctl = new AbortController();
    const p = createClient(BASE).allocation({}, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
    const pre = new AbortController();
    pre.abort();
    await expect(createClient(BASE).interventionSimulation({}, pre.signal)).rejects.toMatchObject({ kind: "aborted" });
  });
});

// ================================================================ tests: dispatch client (JSON, text, HTML)
describe("dispatch brief client", () => {
  const Q = { scope: "city" as const, city: "Dhaka South", issue_date: "2025-07-28", stock_pct: 60, min_coverage_pct: 30, total_crews: 40, capacity_pct: 75, intervention_scenario: "base" as const };
  const QS = "scope=city&city=Dhaka+South&issue_date=2025-07-28&stock_pct=60&min_coverage_pct=30&total_crews=40&capacity_pct=75&intervention_scenario=base";

  it("requests and validates the JSON brief", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      void init;
      return json(makeBrief());
    });
    vi.stubGlobal("fetch", fetchMock);
    const b = await createClient(BASE).dispatchBrief(Q);
    expect(b.status.sent).toBe(false);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/dispatch-brief?${QS}&format=json`);
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("accept")).toBe("application/json");
  });

  it("returns plain text as an exact string, never parsed as JSON", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      void init;
      return doc(SHORT_TEXT, "text/plain; charset=utf-8");
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = await createClient(BASE).dispatchDocument({ ...Q, variant: "short" }, "text");
    expect(d).toEqual({ format: "text", body: SHORT_TEXT, contentType: "text/plain; charset=utf-8", filename: null });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/dispatch-brief?${QS}&variant=short&format=text`);
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("accept")).toBe("text/plain");
    // A text body that happens to look like JSON is still returned verbatim.
    const jsonLooking = `{"sent": true} DRAFT/NOT SENT`;
    vi.stubGlobal("fetch", () => doc(jsonLooking, "text/plain; charset=utf-8"));
    expect((await createClient(BASE).dispatchDocument(Q, "text")).body).toBe(jsonLooking);
  });

  it("returns printable HTML as an inert string and never inserts it into the page", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      void init;
      return doc(PRINT_HTML, "text/html; charset=utf-8");
    });
    vi.stubGlobal("fetch", fetchMock);
    const before = document.body.innerHTML;
    const d = await createClient(BASE).dispatchDocument(Q, "html");
    expect(d.format).toBe("html");
    expect(d.body).toBe(PRINT_HTML);
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("accept")).toBe("text/html");
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector("main h1")).toBeNull();
  });

  it("rejects a document with the wrong content type or without its draft label", async () => {
    vi.stubGlobal("fetch", () => json(makeBrief()));
    await expect(createClient(BASE).dispatchDocument(Q, "text")).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => doc(SHORT_TEXT, "text/plain; charset=utf-8"));
    await expect(createClient(BASE).dispatchDocument(Q, "html")).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => doc(PRINT_HTML, "text/html"));
    await expect(createClient(BASE).dispatchDocument(Q, "text")).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => doc("Plan ready. Send now.", "text/plain; charset=utf-8"));
    await expect(createClient(BASE).dispatchDocument(Q, "text")).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => doc("<html><body>Brief</body></html>", "text/html; charset=utf-8"));
    await expect(createClient(BASE).dispatchDocument(Q, "html")).rejects.toMatchObject({ kind: "shape" });
    await expect(createClient(BASE).dispatchDocument(Q, "json" as "text")).rejects.toThrow(TypeError);
  });

  it("rejects malformed or unsafe JSON briefs", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(createClient(BASE).dispatchBrief(Q)).rejects.toMatchObject({ kind: "shape" });
    vi.stubGlobal("fetch", () => json(patch(makeBrief(), "status.sent", true)));
    await expect(createClient(BASE).dispatchBrief(Q)).rejects.toMatchObject({ kind: "shape" });
  });

  it.each(["json", "text", "html"] as const)("maps HTTP errors to ApiError for format=%s", async (format) => {
    vi.stubGlobal("fetch", () => json({ error: { code: "unknown_ward", message: "Unknown ward_id." } }, 404));
    const c = createClient(BASE);
    const p = format === "json" ? c.dispatchBrief({ scope: "ward", ward_id: "XYZ_Ward_99" }) : c.dispatchDocument({ scope: "ward", ward_id: "XYZ_Ward_99" }, format);
    await expect(p).rejects.toMatchObject({ kind: "http", status: 404, code: "unknown_ward", message: "Unknown ward_id." });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })));
    const q = format === "json" ? c.dispatchBrief(Q) : c.dispatchDocument(Q, format);
    await expect(q).rejects.toMatchObject({ kind: "http", status: 502, message: "The backend returned HTTP 502." });
  });

  it("passes download=true and reads a safe file name only when the header is exposed", async () => {
    const fetchMock = vi.fn((url: string) => {
      void url;
      return doc(PRINT_HTML, "text/html; charset=utf-8", {
        "Content-Disposition": 'attachment; filename="dispatch_do-20250728-s60-f30-c40-h75-ibase-wc_city-dhaka-south_all_detailed.html"',
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = await createClient(BASE).dispatchDocument({ ...Q, download: true }, "html");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/dispatch-brief?${QS}&download=true&format=html`);
    expect(d.filename).toBe("dispatch_do-20250728-s60-f30-c40-h75-ibase-wc_city-dhaka-south_all_detailed.html");
    expect(dispositionFilename(null)).toBeNull();
    expect(dispositionFilename('attachment; filename="../../evil.html"')).toBeNull();
    expect(dispositionFilename('attachment; filename="a b.html"')).toBeNull();
    expect(dispositionFilename("attachment")).toBeNull();
  });

  it("never lets the caller override the format, and builds print URLs without a request", async () => {
    const fetchMock = vi.fn(() => json(makeBrief()));
    vi.stubGlobal("fetch", fetchMock);
    const c = createClient(BASE);
    expect(c.dispatchBriefUrl(Q, "html")).toBe(`${BASE}/dispatch-brief?${QS}&format=html`);
    expect(c.dispatchBriefUrl({ scope: "ward", ward_id: "DSCC_Ward_04", download: true }, "text")).toBe(
      `${BASE}/dispatch-brief?scope=ward&ward_id=DSCC_Ward_04&download=true&format=text`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await c.dispatchBrief({ ...Q, format: "html" } as typeof Q);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/&format=json$/);
  });

  it("only ever talks to the configured backend with GET, and has no sending or DOM-insertion path", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (url.includes("format=json")) return json(makeBrief());
      if (url.includes("format=text")) return doc(SHORT_TEXT, "text/plain; charset=utf-8");
      return doc(PRINT_HTML, "text/html; charset=utf-8");
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = createClient(BASE);
    await c.dispatchBrief(Q);
    await c.dispatchDocument(Q, "text");
    await c.dispatchDocument(Q, "html");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url.startsWith(`${BASE}/dispatch-brief?`)).toBe(true);
      expect((init as RequestInit).method).toBe("GET");
      expect((init as RequestInit).body).toBeUndefined();
    }
    for (const forbidden of [/innerHTML/, /dangerouslySetInnerHTML/, /insertAdjacentHTML/, /document\.write/, /\bPOST\b/, /wa\.me/, /sms:/, /mailto:/, /twilio/i, /whatsapp\.com/i]) {
      expect(clientSource).not.toMatch(forbidden);
    }
  });
});
