// Planning-endpoint FIXTURES for the hospital, intervention and dispatch views. Shapes are copied from the API-layer
// tests (src/api/phase2.test.ts, themselves hand-built from backend/app/planning) and every JSON answer is passed
// through the real strict parser, so a fixture that drifted from the contract fails loudly.
import type {
  DispatchDocument,
  DispatchDocumentFormat,
  DispatchQuery,
  HospitalRoutingQuery,
  HospitalRoutingResponse,
  InterventionQuery,
  InterventionResponse,
} from "../api/types";
import { parseHospitalRouting, parseInterventionSimulation } from "../api/validate";
import { NOTICE } from "./fixtures";

type Json = Record<string, unknown>;
const WEEKS = ["2025-08-11", "2025-08-18", "2025-08-25"];
const pct1 = (a: number, d: number) => (d === 0 ? null : Math.round((1000 * a) / d) / 10);
const env = (issue: string): Json => ({ mode: "historical_replay", notice: NOTICE, issue_date: issue, model_version: "dengue-xgb-2to4w-1.1.0" });

// ---------------------------------------------------------------- /hospital-routing
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
/** Echoes capacity_pct and issue_date like the backend; figures are fixed fixture values. */
export function makeHospital(q: HospitalRoutingQuery = {}, issue = "2025-07-28"): HospitalRoutingResponse {
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
  return parseHospitalRouting({
    ...env(q.issue_date ?? issue),
    policy: { name: "within_city_overflow_routing", description: "Per forecast week and city, overflow is reassigned within the city." },
    parameters: {
      capacity_pct: q.capacity_pct ?? 100, capacity_rule: "floor(capacity_pct x city_baseline / 100)", city_baseline_beds: { Gazipur: 5, Narayanganj: 3 },
      baseline_definition: "Mean over 2016-2023 ...", baseline_years: [2016, 2023], baseline_status: "hypothetical_retrospective_scenario",
      bed_coefficient: "0.29844", rounding: "ROUND_HALF_UP", units: "bed planning units per forecast week (not patients, admissions or occupied beds)",
      connectivity: "all ward pairs within a city; no cross-city transfers", sender_rule: "lowest served ratio", receiver_rule: "lowest occupancy ratio",
    },
    weekly_source: "companion",
    assumptions: ["Bed planning units are forecast-derived planning quantities, not patients, admissions or occupied beds."],
    limitations: ["No hospital locations, distances, travel times, specialties or real occupancy are available or used."],
    warnings: ["Capacity baseline calibrated on 2016-2023 data (retrospective scenario)."],
    capacity: {
      cities: [{ city: "Gazipur", ward_count: 2, baseline: 5, hypothetical_capacity: 4 }, { city: "Narayanganj", ward_count: 1, baseline: 3, hypothetical_capacity: 2 }],
      region_hypothetical_capacity: 6,
    },
    weeks: [
      week(2, hs(4, 3, 3, 0), hs(2, 1, 1, 0), []),
      week(3, hs(4, 3, 3, 0), hs(2, 1, 1, 0), []),
      week(4, hs(4, 5, 2, 1, 2), hs(2, 1, 1, 0), [{ city: "Gazipur", horizon_week: 4, forecast_week: WEEKS[2], from_ward: "GCC_Ward_01", to_ward: "GCC_Ward_02", units: 1 }]),
    ],
    headline_week_by_city: { Gazipur: { horizon_week: 4, forecast_week: WEEKS[2] }, Narayanganj: { horizon_week: 2, forecast_week: WEEKS[0] } },
    wards: [
      { ward_id: "GCC_Ward_01", city: "Gazipur", priority_rank_in_city: 1, risk_tier: "Critical", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 5,
        weeks: [hWardWeek(2, 2, 2, 0, 0, 2), hWardWeek(3, 2, 2, 0, 0, 2), hWardWeek(4, 5, 2, 1, 0, 2)] },
      { ward_id: "GCC_Ward_02", city: "Gazipur", priority_rank_in_city: 2, risk_tier: "Low", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 1,
        weeks: [hWardWeek(2, 1, 1, 0, 0, 2), hWardWeek(3, 1, 1, 0, 0, 2), hWardWeek(4, 0, 0, 0, 1, 2)] },
      { ward_id: "NCC_Ward_01", city: "Narayanganj", priority_rank_in_city: 1, risk_tier: "High", hypothetical_capacity: 2, max_weekly_bed_planning_demand: 1,
        weeks: [hWardWeek(2, 1, 1, 0, 0, 2), hWardWeek(3, 1, 1, 0, 0, 2), hWardWeek(4, 1, 1, 0, 0, 2)] },
    ],
  });
}

// ---------------------------------------------------------------- /intervention-simulation
const M = { low: 0.15, base: 0.35, high: 0.55 } as const;
function totals(crews: number, baseline: number, avoided: number, city?: string): Json {
  return {
    ...(city ? { city } : {}),
    baseline_cases_3wk: baseline, scenario_adjusted_cases_3wk: Math.round((baseline - avoided) * 100) / 100, projected_cases_avoided: avoided, assigned_crews: crews,
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
/** Echoes total_crews / min_coverage_pct / include_roi_alternative; two crews are always assigned (fixture values). */
export function makeIntervention(q: InterventionQuery = {}, issue = "2025-07-28"): InterventionResponse {
  const totalCrews = q.total_crews ?? 60;
  const assigned = Math.min(totalCrews, 2);
  const gz = Math.min(assigned, 1);
  const ng = assigned - gz;
  const AVOIDED = { 0.15: [0.45, 0.3, 0.15], 0.35: [1.05, 0.7, 0.35], 0.55: [1.65, 1.1, 0.55] } as Record<number, number[]>;
  const scen = (m: number) => {
    const [r, g, n] = AVOIDED[m]!;
    return { max_reduction: m, region: totals(assigned, 31.5, assigned ? r! : 0), cities: [totals(gz, 21, gz ? g! : 0, "Gazipur"), totals(ng, 10.5, ng ? n! : 0, "Narayanganj")] };
  };
  const roi = q.include_roi_alternative === true;
  const cmp = (p: number) => ({ primary_projected_cases_avoided: p, alternative_projected_cases_avoided: Math.round((p + 0.1) * 100) / 100, difference: 0.1, difference_pct: 2.5 });
  const byS = (p: number) => ({ region: cmp(p), cities: [{ city: "Gazipur", ...cmp(p) }, { city: "Narayanganj", ...cmp(p), difference_pct: null }] });
  return parseInterventionSimulation({
    ...env(q.issue_date ?? issue),
    policy: {
      name: "assumed_effect_scenarios_on_ml_baseline", causal: false, effect_size_basis: "assumed_scenario_not_learned", crew_capacity_status: "hypothetical",
      crew_assignment_source: "task2_minimum_coverage_then_risk_priority", timing: "Effects are assumed to ramp across weeks t+2, t+3 and t+4.", description: "R = M x (1 - exp(-1.4 x coverage))",
    },
    parameters: {
      scenarios: { ...M }, saturation_k: 1.4, density_per_crew_sqkm: 12000, max_crews_per_ward: 6, ramp_by_horizon_week: { "2": 0.5, "3": 0.85, "4": 1.0 },
      total_crews: totalCrews, min_coverage_pct: q.min_coverage_pct ?? 30, include_roi_alternative: roi, coefficients: { saline: "2.38485" }, rounding: "ROUND_HALF_UP",
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
    roi_alternative: roi
      ? {
          status: "hypothetical_assumption_dependent", objective: "maximise total projected cases avoided (base scenario)", ranking_scenario: "base",
          city_pools: { Gazipur: 1, Narayanganj: 1 }, assigned_crews: 2,
          wards: [{ ward_id: "GCC_Ward_01", city: "Gazipur", primary_crews: 1, alternative_crews: 1 }, { ward_id: "NCC_Ward_01", city: "Narayanganj", primary_crews: 1, alternative_crews: 1 }],
          comparison: { low: byS(0.45), base: byS(1.05), high: byS(1.65) },
        }
      : null,
  });
}

// ---------------------------------------------------------------- /dispatch-brief?format=text
/** A plain-text draft that echoes the query, carrying the backend's DRAFT / NOT SENT marker. */
export function makeBriefText(q: DispatchQuery): string {
  const where = q.scope === "ward" ? `ward ${q.ward_id}` : `city ${q.city}`;
  return [
    "DRAFT / NOT SENT. SIMULATED PLANNING SCENARIO. HISTORICAL REPLAY.",
    `Draft dispatch brief for ${where}, issue week ${q.issue_date ?? "latest"}.`,
    `Audience ${q.audience ?? "all"}, variant ${q.variant ?? "detailed"}, stock ${q.stock_pct ?? 100}%, capacity ${q.capacity_pct ?? 100}%, scenario ${q.intervention_scenario ?? "base"}.`,
    "<script>alert('not run')</script>",
    "HUMAN VERIFICATION REQUIRED before any action.",
  ].join("\n");
}
export function makeBriefDocument(q: DispatchQuery, format: DispatchDocumentFormat = "text"): DispatchDocument {
  return { format, body: makeBriefText(q), contentType: format === "text" ? "text/plain" : "text/html", filename: null };
}
