import {
  DISPATCH_SECTION_KEYS,
  INTERVENTION_SCENARIOS,
  TIER_ORDER,
  WEEKLY_SOURCES,
  type AllForecastsResponse,
  type AllocationCity,
  type AllocationResponse,
  type AllocationWard,
  type CrewSummary,
  type DispatchBriefResponse,
  type DispatchSection,
  type DispatchSectionKey,
  type Drivers,
  type Forecast,
  type HospitalRoutingResponse,
  type HospitalWeekSummary,
  type InterventionResponse,
  type InterventionScenario,
  type InterventionTotals,
  type InterventionWardScenario,
  type Meta,
  type Observed,
  type ReplayEnvelope,
  type ResourceSummary,
  type RiskTier,
  type RoiAlternative,
  type RoiComparison,
  type UnitsImpact,
  type WardForecastResponse,
  type WardResourceAllocation,
  type WeeklyCompanionMeta,
  type WeeklyForecast,
} from "./types";

export class ShapeError extends Error {
  constructor(where: string) {
    super(`Unexpected response shape: ${where}`);
    this.name = "ShapeError";
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, where: string): Obj {
  if (!isObj(v)) throw new ShapeError(where);
  return v;
}
function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw new ShapeError(where);
  return v;
}
function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ShapeError(where);
  return v;
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new ShapeError(where);
  return v;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError(where);
  return v;
}
function tier(v: unknown, where: string): RiskTier {
  if (typeof v !== "string" || !(TIER_ORDER as readonly string[]).includes(v)) throw new ShapeError(where);
  return v as RiskTier;
}

// ---------------------------------------------------------------- shared helpers (Phase 2)
/** Finite and >= 0 (planning figures are never negative). */
function nonNeg(v: unknown, where: string): number {
  const n = num(v, where);
  if (n < 0) throw new ShapeError(where);
  return n;
}
/** Non-negative integer (planning units, counts, crews). */
function count(v: unknown, where: string): number {
  const n = nonNeg(v, where);
  if (!Number.isInteger(n)) throw new ShapeError(where);
  return n;
}
function posInt(v: unknown, where: string): number {
  const n = count(v, where);
  if (n < 1) throw new ShapeError(where);
  return n;
}
/** A value that must be present but may be null. `undefined` (missing key) is rejected. */
function nullable<T>(v: unknown, where: string, parse: (x: unknown, w: string) => T): T | null {
  if (v === null) return null;
  return parse(v, where);
}
/** Nullable percentage in [0, max]. */
function pct(v: unknown, where: string, max = 100): number | null {
  return nullable(v, where, (x, w) => {
    const n = nonNeg(x, w);
    if (n > max) throw new ShapeError(w);
    return n;
  });
}
/** Required (non-null) percentage in [0, 100]. */
function percent(v: unknown, where: string): number {
  const n = pct(v, where);
  if (n === null) throw new ShapeError(where);
  return n;
}
/** A share in [0, 1); `inclusive` allows exactly 1. */
function share(v: unknown, where: string, inclusive = false): number {
  const n = nonNeg(v, where);
  if (inclusive ? n > 1 : n >= 1) throw new ShapeError(where);
  return n;
}
function oneOf<T extends string>(v: unknown, values: readonly T[], where: string): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new ShapeError(where);
  return v as T;
}
function literal<T extends string | boolean>(v: unknown, expected: T, where: string): T {
  if (v !== expected) throw new ShapeError(where);
  return expected;
}
function strs(v: unknown, where: string): string[] {
  return arr(v, where).map((s, i) => str(s, `${where}[${i}]`));
}
/** ISO yyyy-mm-dd that is a real calendar date. */
function isoDate(v: unknown, where: string): string {
  const s = str(v, where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ShapeError(where);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new ShapeError(where);
  return s;
}
/** Exactly three items (weeks t+2, t+3, t+4). */
function three<T>(v: unknown, where: string, parse: (x: unknown, w: string) => T): T[] {
  const a = arr(v, where);
  if (a.length !== 3) throw new ShapeError(`${where} must have 3 entries`);
  return a.map((x, i) => parse(x, `${where}[${i}]`));
}
/** horizon_week values 2, 3, 4 in order. */
function horizon(v: unknown, index: number, where: string): number {
  if (v !== index + 2) throw new ShapeError(where);
  return index + 2;
}
function countRecord(v: unknown, where: string): Record<string, number> {
  const o = obj(v, where);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, count(x, `${where}.${k}`)]));
}
function check(cond: boolean, where: string): void {
  if (!cond) throw new ShapeError(where);
}

function drivers(v: unknown): Drivers | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, "drivers");
  return {
    baseline: num(o.baseline, "drivers.baseline"),
    groups: arr(o.groups, "drivers.groups").map((g, i) => {
      const go = obj(g, `drivers.groups[${i}]`);
      return { group: str(go.group, "group"), contribution: num(go.contribution, "contribution") };
    }),
    note: typeof o.note === "string" ? o.note : "",
  };
}

function observed(v: unknown): Observed | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, "actual");
  const cases = o.actual_cases_3wk;
  const t = o.actual_risk_tier;
  return {
    available: bool(o.available, "actual.available"),
    actual_cases_3wk: cases === null || cases === undefined ? null : num(cases, "actual_cases_3wk"),
    actual_risk_tier: t === null || t === undefined ? null : tier(t, "actual_risk_tier"),
    note: typeof o.note === "string" ? o.note : "",
  };
}

// Same tolerance as the backend planner (demand.py _RECONCILE_TOLERANCE): weekly values must add up to the
// 3-week total. Float sums of three values are off by ~1e-15, far inside it.
const WEEKLY_RECONCILE_TOLERANCE = 1e-6;

function weekly(v: unknown, forecastWeeks: string[], total: number): WeeklyForecast {
  const o = obj(v, "weekly");
  const weeks = arr(o.weeks, "weekly.weeks");
  if (weeks.length !== 3) throw new ShapeError("weekly.weeks must have 3 entries");
  const values = weeks.map((w, i) => {
    const wo = obj(w, `weekly.weeks[${i}]`);
    const horizon = num(wo.horizon_week, `weekly.weeks[${i}].horizon_week`);
    if (horizon !== i + 2) throw new ShapeError(`weekly.weeks[${i}].horizon_week`);
    const week = isoDate(wo.forecast_week, `weekly.weeks[${i}].forecast_week`);
    if (week !== forecastWeeks[i]) throw new ShapeError(`weekly.weeks[${i}].forecast_week`);
    return { horizon_week: horizon, forecast_week: week, predicted_cases: nonNeg(wo.predicted_cases, `weekly.weeks[${i}].predicted_cases`) };
  });
  const sum = values.reduce((s, w) => s + w.predicted_cases, 0);
  if (Math.abs(sum - total) > WEEKLY_RECONCILE_TOLERANCE) throw new ShapeError("weekly values do not add up to predicted_cases_3wk");
  return {
    source: oneOf(o.source, WEEKLY_SOURCES, "weekly.source"),
    model_version: nullable(o.model_version, "weekly.model_version", str),
    fallback_reason: nullable(o.fallback_reason, "weekly.fallback_reason", str),
    reconciled_to: literal(o.reconciled_to, "predicted_cases_3wk", "weekly.reconciled_to"),
    weeks: values,
    note: typeof o.note === "string" ? o.note : "",
  };
}

function weeklyCompanion(v: unknown): WeeklyCompanionMeta {
  const o = obj(v, "weekly_companion");
  const out: WeeklyCompanionMeta = {
    available: bool(o.available, "weekly_companion.available"),
    source: oneOf(o.source, WEEKLY_SOURCES, "weekly_companion.source"),
    model_version: nullable(o.model_version, "weekly_companion.model_version", str),
    fallback_reason: nullable(o.fallback_reason, "weekly_companion.fallback_reason", str),
    horizon_weeks: arr(o.horizon_weeks, "weekly_companion.horizon_weeks").map((n) => num(n, "weekly_companion.horizon_weeks[]")),
    reconciled_to: str(o.reconciled_to, "weekly_companion.reconciled_to"),
  };
  if (out.available !== (out.source === "companion")) throw new ShapeError("weekly_companion.available does not match source");
  return out;
}

export function parseForecast(v: unknown): Forecast {
  const o = obj(v, "forecast");
  const base = {
    ward_id: str(o.ward_id, "ward_id"),
    city: str(o.city, "city"),
    issue_week: str(o.issue_week, "issue_week"),
    horizon_weeks: arr(o.horizon_weeks, "horizon_weeks").map((n) => num(n, "horizon_weeks[]")),
    forecast_weeks: arr(o.forecast_weeks, "forecast_weeks").map((s) => str(s, "forecast_weeks[]")),
    predicted_cases_3wk: num(o.predicted_cases_3wk, "predicted_cases_3wk"),
    risk_tier: tier(o.risk_tier, "risk_tier"),
    early_alert: bool(o.early_alert, "early_alert"),
    raw_model_output: num(o.raw_model_output, "raw_model_output"),
    model_version: str(o.model_version, "model_version"),
    data_source: str(o.data_source, "data_source"),
    warnings: arr(o.warnings ?? [], "warnings").map((s) => str(s, "warnings[]")),
    drivers: drivers(o.drivers),
    actual: observed(o.actual),
  };
  // The weekly block is optional (only with include_weekly=true); when present it must be valid, never dropped.
  if (o.weekly === undefined) return base;
  return { ...base, weekly: weekly(o.weekly, base.forecast_weeks, base.predicted_cases_3wk) };
}

export function parseMeta(v: unknown): Meta {
  const o = obj(v, "meta");
  const weeks = obj(o.valid_issue_weeks, "valid_issue_weeks");
  const tiers = obj(o.risk_tiers, "risk_tiers");
  const alert = obj(o.early_alert, "early_alert");
  const meta: Meta = {
    mode: str(o.mode, "mode"),
    notice: str(o.notice, "notice"),
    model_version: str(o.model_version, "model_version"),
    cities: arr(o.cities, "cities").map((c, i) => {
      const co = obj(c, `cities[${i}]`);
      return {
        city: str(co.city, "city"),
        ward_count: num(co.ward_count, "ward_count"),
        wards: arr(co.wards, "wards").map((w) => str(w, "wards[]")),
      };
    }),
    wards: arr(o.wards, "wards").map((w, i) => {
      const wo = obj(w, `wards[${i}]`);
      return { ward_id: str(wo.ward_id, "ward_id"), city: str(wo.city, "city") };
    }),
    ward_count: num(o.ward_count, "ward_count"),
    valid_issue_weeks: {
      first: str(weeks.first, "first"),
      last: str(weeks.last, "last"),
      weekday: str(weeks.weekday, "weekday"),
      actuals_available_until_issue_week: str(
        weeks.actuals_available_until_issue_week,
        "actuals_available_until_issue_week",
      ),
    },
    horizon_weeks: arr(o.horizon_weeks, "horizon_weeks").map((n) => num(n, "horizon_weeks[]")),
    risk_tiers: {
      labels: arr(tiers.labels, "labels").map((t) => tier(t, "labels[]")),
      edges: arr(tiers.edges, "edges").map((n) => num(n, "edges[]")),
      rule: str(tiers.rule, "rule"),
    },
    early_alert: { threshold: num(alert.threshold, "threshold"), rule: str(alert.rule, "rule") },
  };
  // Optional: older /meta responses do not have it; when present it must be valid.
  if (o.weekly_companion === undefined) return meta;
  return { ...meta, weekly_companion: weeklyCompanion(o.weekly_companion) };
}

export function parseWardForecast(v: unknown): WardForecastResponse {
  const o = obj(v, "response");
  return { mode: str(o.mode, "mode"), notice: str(o.notice, "notice"), forecast: parseForecast(o.forecast) };
}

export function parseAllForecasts(v: unknown): AllForecastsResponse {
  const o = obj(v, "response");
  return {
    mode: str(o.mode, "mode"),
    notice: str(o.notice, "notice"),
    issue_date: str(o.issue_date, "issue_date"),
    count: num(o.count, "count"),
    forecasts: arr(o.forecasts, "forecasts").map(parseForecast),
  };
}

// ================================================================ Phase 2 planning responses
// The parsers keep the backend's own field names and values (no rounding, no recalculation). They check
// types, ranges, enums and a few cheap invariants the backend guarantees, and reject anything else.

function envelope(o: Obj): ReplayEnvelope {
  return {
    mode: literal(o.mode, "historical_replay", "mode"),
    notice: str(o.notice, "notice"),
    issue_date: isoDate(o.issue_date, "issue_date"),
    model_version: str(o.model_version, "model_version"),
  };
}

function policy(v: unknown, where: string) {
  const o = obj(v, where);
  return { name: str(o.name, `${where}.name`), description: str(o.description, `${where}.description`) };
}

/** Unique ward ids with a known city; returns ward -> city. */
function wardCities(wards: { ward_id: string; city: string }[], cities: Set<string>, where: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of wards) {
    check(!map.has(w.ward_id), `${where}: duplicate ward ${w.ward_id}`);
    check(cities.has(w.city), `${where}: ward ${w.ward_id} has an unknown city`);
    map.set(w.ward_id, w.city);
  }
  return map;
}

function uniqueCities(rows: { city: string }[], where: string): Set<string> {
  const set = new Set(rows.map((r) => r.city));
  check(rows.length > 0 && set.size === rows.length, `${where}: cities must be non-empty and unique`);
  return set;
}

// ---------------------------------------------------------------- Task 2: /allocation
const SEVERITIES = ["no_deficit", "below_floor", "partial"] as const;
const REASONS = ["no_demand", "fulfilled", "below_floor", "floor_only", "partial_priority", "not_reached"] as const;

function resourceSummary(v: unknown, where: string): ResourceSummary {
  const o = obj(v, where);
  const s: ResourceSummary = {
    demand: count(o.demand, `${where}.demand`),
    stock: count(o.stock, `${where}.stock`),
    allocated: count(o.allocated, `${where}.allocated`),
    deficit: count(o.deficit, `${where}.deficit`),
    unallocated: count(o.unallocated, `${where}.unallocated`),
    coverage_pct: pct(o.coverage_pct, `${where}.coverage_pct`),
    wards_with_deficit: count(o.wards_with_deficit, `${where}.wards_with_deficit`),
    wards_below_floor: count(o.wards_below_floor, `${where}.wards_below_floor`),
  };
  check(s.deficit === s.demand - s.allocated && s.unallocated === s.stock - s.allocated, `${where}: totals do not balance`);
  return s;
}

function crewSummary(o: Obj, where: string): CrewSummary {
  const s: CrewSummary = {
    scenario_demand: count(o.scenario_demand, `${where}.scenario_demand`),
    pool: count(o.pool, `${where}.pool`),
    assigned: count(o.assigned, `${where}.assigned`),
    scenario_deficit: count(o.scenario_deficit, `${where}.scenario_deficit`),
    coverage_pct: pct(o.coverage_pct, `${where}.coverage_pct`),
    wards_with_scenario_deficit: count(o.wards_with_scenario_deficit, `${where}.wards_with_scenario_deficit`),
    wards_below_floor: count(o.wards_below_floor, `${where}.wards_below_floor`),
  };
  check(s.assigned <= s.pool && s.scenario_deficit === s.scenario_demand - s.assigned, `${where}: crews do not balance`);
  return s;
}

function bedSummary(v: unknown, where: string) {
  const o = obj(v, where);
  return { planning_demand: count(o.planning_demand, `${where}.planning_demand`), capacity_and_routing: str(o.capacity_and_routing, `${where}.capacity_and_routing`) };
}

function wardResource(v: unknown, where: string): WardResourceAllocation {
  const o = obj(v, where);
  const r: WardResourceAllocation = {
    demand: count(o.demand, `${where}.demand`),
    floor: count(o.floor, `${where}.floor`),
    allocated: count(o.allocated, `${where}.allocated`),
    deficit: count(o.deficit, `${where}.deficit`),
    coverage_pct: pct(o.coverage_pct, `${where}.coverage_pct`),
    critical_deficit: bool(o.critical_deficit, `${where}.critical_deficit`),
    severity: oneOf(o.severity, SEVERITIES, `${where}.severity`),
    reason: oneOf(o.reason, REASONS, `${where}.reason`),
  };
  check(r.allocated <= r.demand && r.deficit === r.demand - r.allocated, `${where}: allocation does not balance`);
  check(r.critical_deficit === r.deficit > 0, `${where}.critical_deficit`);
  return r;
}

function allocationWard(v: unknown, i: number, maxCrews: number): AllocationWard {
  const where = `wards[${i}]`;
  const o = obj(v, where);
  const p = obj(o.priority, `${where}.priority`);
  const c = obj(o.crews, `${where}.crews`);
  const b = obj(o.bed_plan, `${where}.bed_plan`);
  const crews = {
    scenario_demand: count(c.scenario_demand, `${where}.crews.scenario_demand`),
    floor: count(c.floor, `${where}.crews.floor`),
    assigned: count(c.assigned, `${where}.crews.assigned`),
    scenario_deficit: count(c.scenario_deficit, `${where}.crews.scenario_deficit`),
    coverage_pct: pct(c.coverage_pct, `${where}.crews.coverage_pct`),
    scenario_crew_deficit: bool(c.scenario_crew_deficit, `${where}.crews.scenario_crew_deficit`),
    severity: oneOf(c.severity, SEVERITIES, `${where}.crews.severity`),
    reason: oneOf(c.reason, REASONS, `${where}.crews.reason`),
  };
  check(crews.scenario_demand <= maxCrews && crews.assigned <= crews.scenario_demand, `${where}.crews: assignment out of range`);
  check(crews.scenario_deficit === crews.scenario_demand - crews.assigned, `${where}.crews: deficit does not balance`);
  check(crews.scenario_crew_deficit === crews.scenario_deficit > 0, `${where}.crews.scenario_crew_deficit`);
  const peak = count(b.peak_horizon_week, `${where}.bed_plan.peak_horizon_week`);
  check(peak >= 2 && peak <= 4, `${where}.bed_plan.peak_horizon_week`);
  return {
    ward_id: str(o.ward_id, `${where}.ward_id`),
    city: str(o.city, `${where}.city`),
    priority_rank_in_city: posInt(o.priority_rank_in_city, `${where}.priority_rank_in_city`),
    priority: {
      risk_tier: tier(p.risk_tier, `${where}.priority.risk_tier`),
      early_alert: bool(p.early_alert, `${where}.priority.early_alert`),
      population_density_sqkm: nonNeg(p.population_density_sqkm, `${where}.priority.population_density_sqkm`),
      predicted_cases_3wk: nonNeg(p.predicted_cases_3wk, `${where}.priority.predicted_cases_3wk`),
    },
    saline: wardResource(o.saline, `${where}.saline`),
    kits: wardResource(o.kits, `${where}.kits`),
    crews,
    bed_plan: {
      peak_forecast_week: isoDate(b.peak_forecast_week, `${where}.bed_plan.peak_forecast_week`),
      peak_horizon_week: peak,
      peak_week_expected_cases: nonNeg(b.peak_week_expected_cases, `${where}.bed_plan.peak_week_expected_cases`),
      bed_planning_demand: count(b.bed_planning_demand, `${where}.bed_plan.bed_planning_demand`),
      weekly_source: oneOf(b.weekly_source, WEEKLY_SOURCES, `${where}.bed_plan.weekly_source`),
    },
    exceeds_observed_range: bool(o.exceeds_observed_range, `${where}.exceeds_observed_range`),
  };
}

export function parseAllocation(v: unknown): AllocationResponse {
  const o = obj(v, "allocation");
  const prm = obj(o.parameters, "parameters");
  const stock = obj(prm.stock_pct, "parameters.stock_pct");
  const rule = obj(prm.crew_rule, "parameters.crew_rule");
  const coef = obj(prm.coefficients, "parameters.coefficients");
  const region = obj(o.region, "region");
  const rc = obj(region.crews, "region.crews");
  const maxCrews = posInt(rule.max_crews_per_ward, "parameters.crew_rule.max_crews_per_ward");
  const cities: AllocationCity[] = arr(o.cities, "cities").map((c, i) => {
    const co = obj(c, `cities[${i}]`);
    return {
      city: str(co.city, `cities[${i}].city`),
      ward_count: posInt(co.ward_count, `cities[${i}].ward_count`),
      saline: resourceSummary(co.saline, `cities[${i}].saline`),
      kits: resourceSummary(co.kits, `cities[${i}].kits`),
      crews: crewSummary(obj(co.crews, `cities[${i}].crews`), `cities[${i}].crews`),
      beds: bedSummary(co.beds, `cities[${i}].beds`),
    };
  });
  const citySet = uniqueCities(cities, "cities");
  const wards = arr(o.wards, "wards").map((w, i) => allocationWard(w, i, maxCrews));
  wardCities(wards, citySet, "wards");
  for (const c of cities) check(wards.filter((w) => w.city === c.city).length === c.ward_count, `cities.${c.city}.ward_count`);
  const regionCrews = {
    ...crewSummary(rc, "region.crews"),
    total_crews: count(rc.total_crews, "region.crews.total_crews"),
    unassigned: count(rc.unassigned, "region.crews.unassigned"),
  };
  check(regionCrews.assigned + regionCrews.unassigned === regionCrews.total_crews, "region.crews: budget does not balance");
  return {
    ...envelope(o),
    policy: policy(o.policy, "policy"),
    parameters: {
      stock_pct: { saline: percent(stock.saline, "parameters.stock_pct.saline"), kits: percent(stock.kits, "parameters.stock_pct.kits") },
      min_coverage_pct: percent(prm.min_coverage_pct, "parameters.min_coverage_pct"),
      total_crews: count(prm.total_crews, "parameters.total_crews"),
      rounding: str(prm.rounding, "parameters.rounding"),
      coefficients: Object.fromEntries(Object.entries(coef).map(([k, x]) => [k, str(x, `parameters.coefficients.${k}`)])),
      crew_rule: {
        eligible_tiers: arr(rule.eligible_tiers, "parameters.crew_rule.eligible_tiers").map((t) => tier(t, "eligible_tiers[]")),
        density_per_crew_sqkm: nonNeg(rule.density_per_crew_sqkm, "parameters.crew_rule.density_per_crew_sqkm"),
        max_crews_per_ward: maxCrews,
        status: str(rule.status, "parameters.crew_rule.status"),
      },
      priority_key: strs(prm.priority_key, "parameters.priority_key"),
    },
    weekly_source: oneOf(o.weekly_source, WEEKLY_SOURCES, "weekly_source"),
    assumptions: strs(o.assumptions, "assumptions"),
    limitations: strs(o.limitations, "limitations"),
    region: {
      saline: resourceSummary(region.saline, "region.saline"),
      kits: resourceSummary(region.kits, "region.kits"),
      crews: regionCrews,
      beds: bedSummary(region.beds, "region.beds"),
    },
    cities,
    wards,
  };
}

// ---------------------------------------------------------------- Task 3: /hospital-routing
function hospitalSummary(o: Obj, where: string): HospitalWeekSummary {
  const s: HospitalWeekSummary = {
    hypothetical_capacity: count(o.hypothetical_capacity, `${where}.hypothetical_capacity`),
    bed_planning_demand: count(o.bed_planning_demand, `${where}.bed_planning_demand`),
    locally_assigned: count(o.locally_assigned, `${where}.locally_assigned`),
    transfer_units: count(o.transfer_units, `${where}.transfer_units`),
    transfer_edges: count(o.transfer_edges, `${where}.transfer_edges`),
    sending_wards: count(o.sending_wards, `${where}.sending_wards`),
    receiving_wards: count(o.receiving_wards, `${where}.receiving_wards`),
    occupied_after_routing: count(o.occupied_after_routing, `${where}.occupied_after_routing`),
    unmet_after_routing: count(o.unmet_after_routing, `${where}.unmet_after_routing`),
    spare_after_routing: count(o.spare_after_routing, `${where}.spare_after_routing`),
    wards_with_unmet: count(o.wards_with_unmet, `${where}.wards_with_unmet`),
    utilization_pct: pct(o.utilization_pct, `${where}.utilization_pct`),
    demand_to_capacity_pct: pct(o.demand_to_capacity_pct, `${where}.demand_to_capacity_pct`, Number.MAX_VALUE),
    utilization_status: oneOf(o.utilization_status, ["ok", "no_capacity"] as const, `${where}.utilization_status`),
  };
  check(s.occupied_after_routing + s.spare_after_routing === s.hypothetical_capacity, `${where}: capacity does not balance`);
  check(s.unmet_after_routing <= s.bed_planning_demand, `${where}: unmet exceeds demand`);
  return s;
}

export function parseHospitalRouting(v: unknown): HospitalRoutingResponse {
  const o = obj(v, "hospital-routing");
  const prm = obj(o.parameters, "parameters");
  const cap = obj(o.capacity, "capacity");
  const capCities = arr(cap.cities, "capacity.cities").map((c, i) => {
    const co = obj(c, `capacity.cities[${i}]`);
    return {
      city: str(co.city, `capacity.cities[${i}].city`),
      ward_count: posInt(co.ward_count, `capacity.cities[${i}].ward_count`),
      baseline: count(co.baseline, `capacity.cities[${i}].baseline`),
      hypothetical_capacity: count(co.hypothetical_capacity, `capacity.cities[${i}].hypothetical_capacity`),
    };
  });
  const citySet = uniqueCities(capCities, "capacity.cities");
  const wards = arr(o.wards, "wards").map((w, i) => {
    const where = `wards[${i}]`;
    const wo = obj(w, where);
    return {
      ward_id: str(wo.ward_id, `${where}.ward_id`),
      city: str(wo.city, `${where}.city`),
      priority_rank_in_city: posInt(wo.priority_rank_in_city, `${where}.priority_rank_in_city`),
      risk_tier: tier(wo.risk_tier, `${where}.risk_tier`),
      hypothetical_capacity: count(wo.hypothetical_capacity, `${where}.hypothetical_capacity`),
      max_weekly_bed_planning_demand: count(wo.max_weekly_bed_planning_demand, `${where}.max_weekly_bed_planning_demand`),
      weeks: three(wo.weeks, `${where}.weeks`, (x, ww) => {
        const k = obj(x, ww);
        return {
          horizon_week: count(k.horizon_week, `${ww}.horizon_week`),
          forecast_week: isoDate(k.forecast_week, `${ww}.forecast_week`),
          bed_planning_demand: count(k.bed_planning_demand, `${ww}.bed_planning_demand`),
          locally_assigned: count(k.locally_assigned, `${ww}.locally_assigned`),
          transferred_out: count(k.transferred_out, `${ww}.transferred_out`),
          transferred_in: count(k.transferred_in, `${ww}.transferred_in`),
          unmet_after_routing: count(k.unmet_after_routing, `${ww}.unmet_after_routing`),
          occupied_after_routing: count(k.occupied_after_routing, `${ww}.occupied_after_routing`),
          spare_after_routing: count(k.spare_after_routing, `${ww}.spare_after_routing`),
        };
      }),
    };
  });
  const wardCity = wardCities(wards, citySet, "wards");
  wards.forEach((w, i) => w.weeks.forEach((k, j) => horizon(k.horizon_week, j, `wards[${i}].weeks[${j}].horizon_week`)));

  const weeks = three(o.weeks, "weeks", (x, where) => {
    const wo = obj(x, where);
    const cities = arr(wo.cities, `${where}.cities`).map((c, i) => {
      const co = obj(c, `${where}.cities[${i}]`);
      return { city: str(co.city, `${where}.cities[${i}].city`), ...hospitalSummary(co, `${where}.cities[${i}]`) };
    });
    const transfers = arr(wo.transfers, `${where}.transfers`).map((t, i) => {
      const tw = `${where}.transfers[${i}]`;
      const to = obj(t, tw);
      const tr = {
        city: str(to.city, `${tw}.city`),
        horizon_week: count(to.horizon_week, `${tw}.horizon_week`),
        forecast_week: isoDate(to.forecast_week, `${tw}.forecast_week`),
        from_ward: str(to.from_ward, `${tw}.from_ward`),
        to_ward: str(to.to_ward, `${tw}.to_ward`),
        units: posInt(to.units, `${tw}.units`),
      };
      // Simulated reassignments stay inside one city corporation and never loop back to the sender.
      check(tr.from_ward !== tr.to_ward, `${tw}: sender equals receiver`);
      check(wardCity.get(tr.from_ward) === tr.city && wardCity.get(tr.to_ward) === tr.city, `${tw}: transfer leaves its city`);
      return tr;
    });
    return {
      horizon_week: count(wo.horizon_week, `${where}.horizon_week`),
      forecast_week: isoDate(wo.forecast_week, `${where}.forecast_week`),
      region: hospitalSummary(obj(wo.region, `${where}.region`), `${where}.region`),
      cities,
      transfers,
    };
  });
  weeks.forEach((w, j) => {
    horizon(w.horizon_week, j, `weeks[${j}].horizon_week`);
    for (const t of w.transfers) check(t.horizon_week === w.horizon_week && t.forecast_week === w.forecast_week, `weeks[${j}]: transfer week`);
    for (const c of w.cities) {
      check(citySet.has(c.city), `weeks[${j}]: unknown city`);
      const units = w.transfers.filter((t) => t.city === c.city).reduce((s, t) => s + t.units, 0);
      check(units === c.transfer_units, `weeks[${j}].cities.${c.city}.transfer_units`);
    }
  });

  const headObj = obj(o.headline_week_by_city, "headline_week_by_city");
  const headline: Record<string, { horizon_week: number; forecast_week: string }> = {};
  for (const c of citySet) {
    const h = obj(headObj[c], `headline_week_by_city.${c}`);
    const hw = count(h.horizon_week, `headline_week_by_city.${c}.horizon_week`);
    const fw = isoDate(h.forecast_week, `headline_week_by_city.${c}.forecast_week`);
    check(weeks.some((w) => w.horizon_week === hw && w.forecast_week === fw), `headline_week_by_city.${c}`);
    headline[c] = { horizon_week: hw, forecast_week: fw };
  }

  return {
    ...envelope(o),
    policy: policy(o.policy, "policy"),
    parameters: {
      capacity_pct: count(prm.capacity_pct, "parameters.capacity_pct"),
      capacity_rule: str(prm.capacity_rule, "parameters.capacity_rule"),
      city_baseline_beds: countRecord(prm.city_baseline_beds, "parameters.city_baseline_beds"),
      baseline_definition: str(prm.baseline_definition, "parameters.baseline_definition"),
      baseline_years: arr(prm.baseline_years, "parameters.baseline_years").map((y) => posInt(y, "parameters.baseline_years[]")),
      baseline_status: str(prm.baseline_status, "parameters.baseline_status"),
      bed_coefficient: str(prm.bed_coefficient, "parameters.bed_coefficient"),
      rounding: str(prm.rounding, "parameters.rounding"),
      units: str(prm.units, "parameters.units"),
      connectivity: str(prm.connectivity, "parameters.connectivity"),
      sender_rule: str(prm.sender_rule, "parameters.sender_rule"),
      receiver_rule: str(prm.receiver_rule, "parameters.receiver_rule"),
    },
    weekly_source: oneOf(o.weekly_source, WEEKLY_SOURCES, "weekly_source"),
    assumptions: strs(o.assumptions, "assumptions"),
    limitations: strs(o.limitations, "limitations"),
    warnings: strs(o.warnings, "warnings"),
    capacity: { cities: capCities, region_hypothetical_capacity: count(cap.region_hypothetical_capacity, "capacity.region_hypothetical_capacity") },
    weeks,
    headline_week_by_city: headline,
    wards,
  };
}

// ---------------------------------------------------------------- Task 4: /intervention-simulation
function unitsImpact(v: unknown, where: string): UnitsImpact {
  const o = obj(v, where);
  const u = {
    baseline_units: count(o.baseline_units, `${where}.baseline_units`),
    scenario_adjusted_units: count(o.scenario_adjusted_units, `${where}.scenario_adjusted_units`),
    projected_units_avoided: count(o.projected_units_avoided, `${where}.projected_units_avoided`),
  };
  check(u.baseline_units - u.scenario_adjusted_units === u.projected_units_avoided, `${where}: units do not balance`);
  return u;
}

/** ROI is null exactly when no crews are assigned (no division by zero, never 0 or Infinity). */
function perCrew(v: unknown, crews: number, where: string): number | null {
  const r = nullable(v, where, nonNeg);
  check((r === null) === (crews === 0), `${where}: must be null exactly when no crews are assigned`);
  return r;
}

function interventionTotals(o: Obj, weeks: string[], where: string): InterventionTotals {
  const assigned = count(o.assigned_crews, `${where}.assigned_crews`);
  const t: InterventionTotals = {
    baseline_cases_3wk: nonNeg(o.baseline_cases_3wk, `${where}.baseline_cases_3wk`),
    scenario_adjusted_cases_3wk: nonNeg(o.scenario_adjusted_cases_3wk, `${where}.scenario_adjusted_cases_3wk`),
    projected_cases_avoided: nonNeg(o.projected_cases_avoided, `${where}.projected_cases_avoided`),
    assigned_crews: assigned,
    projected_cases_avoided_per_assigned_crew: perCrew(o.projected_cases_avoided_per_assigned_crew, assigned, `${where}.projected_cases_avoided_per_assigned_crew`),
    saline: unitsImpact(o.saline, `${where}.saline`),
    kits: unitsImpact(o.kits, `${where}.kits`),
    weekly_bed_planning_units: three(o.weekly_bed_planning_units, `${where}.weekly_bed_planning_units`, (x, w) => {
      const k = obj(x, w);
      return {
        horizon_week: count(k.horizon_week, `${w}.horizon_week`),
        forecast_week: isoDate(k.forecast_week, `${w}.forecast_week`),
        baseline: count(k.baseline, `${w}.baseline`),
        scenario_adjusted: count(k.scenario_adjusted, `${w}.scenario_adjusted`),
        projected_units_avoided: count(k.projected_units_avoided, `${w}.projected_units_avoided`),
      };
    }),
    sum_of_ward_peak_bed_planning_reductions: count(o.sum_of_ward_peak_bed_planning_reductions, `${where}.sum_of_ward_peak_bed_planning_reductions`),
  };
  t.weekly_bed_planning_units.forEach((k, j) => {
    horizon(k.horizon_week, j, `${where}.weekly_bed_planning_units[${j}].horizon_week`);
    check(k.forecast_week === weeks[j], `${where}.weekly_bed_planning_units[${j}].forecast_week`);
  });
  check(t.projected_cases_avoided <= t.baseline_cases_3wk + 1e-6, `${where}: avoided exceeds baseline`);
  return t;
}

function wardScenario(v: unknown, crews: number, where: string): InterventionWardScenario {
  const o = obj(v, where);
  const sal = obj(o.saline, `${where}.saline`);
  const kit = obj(o.kits, `${where}.kits`);
  const wb = obj(o.weekly_bed_planning_units, `${where}.weekly_bed_planning_units`);
  const pb = obj(o.peak_bed_planning_units, `${where}.peak_bed_planning_units`);
  return {
    effective_reduction_by_week: three(o.effective_reduction_by_week, `${where}.effective_reduction_by_week`, (x, w) => share(x, w)),
    scenario_adjusted_weekly_cases: three(o.scenario_adjusted_weekly_cases, `${where}.scenario_adjusted_weekly_cases`, nonNeg),
    projected_cases_avoided: nonNeg(o.projected_cases_avoided, `${where}.projected_cases_avoided`),
    projected_cases_avoided_per_assigned_crew: perCrew(o.projected_cases_avoided_per_assigned_crew, crews, `${where}.projected_cases_avoided_per_assigned_crew`),
    saline: { scenario_adjusted_units: count(sal.scenario_adjusted_units, `${where}.saline.scenario_adjusted_units`), projected_units_avoided: count(sal.projected_units_avoided, `${where}.saline.projected_units_avoided`) },
    kits: { scenario_adjusted_units: count(kit.scenario_adjusted_units, `${where}.kits.scenario_adjusted_units`), projected_units_avoided: count(kit.projected_units_avoided, `${where}.kits.projected_units_avoided`) },
    weekly_bed_planning_units: {
      scenario_adjusted: three(wb.scenario_adjusted, `${where}.weekly_bed_planning_units.scenario_adjusted`, count),
      projected_units_avoided: three(wb.projected_units_avoided, `${where}.weekly_bed_planning_units.projected_units_avoided`, count),
    },
    peak_bed_planning_units: {
      scenario_adjusted: count(pb.scenario_adjusted, `${where}.peak_bed_planning_units.scenario_adjusted`),
      projected_reduction: count(pb.projected_reduction, `${where}.peak_bed_planning_units.projected_reduction`),
    },
  };
}

/** An object whose keys are exactly low, base and high. */
function byScenario<T>(v: unknown, where: string, parse: (x: unknown, s: InterventionScenario, w: string) => T): Record<InterventionScenario, T> {
  const o = obj(v, where);
  const keys = Object.keys(o).sort();
  check(keys.length === 3 && INTERVENTION_SCENARIOS.every((s) => keys.includes(s)), `${where}: scenarios must be exactly low, base and high`);
  return { low: parse(o.low, "low", `${where}.low`), base: parse(o.base, "base", `${where}.base`), high: parse(o.high, "high", `${where}.high`) };
}

function roiComparison(o: Obj, where: string): RoiComparison {
  return {
    primary_projected_cases_avoided: nonNeg(o.primary_projected_cases_avoided, `${where}.primary_projected_cases_avoided`),
    alternative_projected_cases_avoided: nonNeg(o.alternative_projected_cases_avoided, `${where}.alternative_projected_cases_avoided`),
    difference: num(o.difference, `${where}.difference`),
    difference_pct: nullable(o.difference_pct, `${where}.difference_pct`, num),
  };
}

function roiAlternative(v: unknown, citySet: Set<string>): RoiAlternative {
  const o = obj(v, "roi_alternative");
  const pools = countRecord(o.city_pools, "roi_alternative.city_pools");
  const assigned = count(o.assigned_crews, "roi_alternative.assigned_crews");
  const wards = arr(o.wards, "roi_alternative.wards").map((w, i) => {
    const wo = obj(w, `roi_alternative.wards[${i}]`);
    return {
      ward_id: str(wo.ward_id, `roi_alternative.wards[${i}].ward_id`),
      city: str(wo.city, `roi_alternative.wards[${i}].city`),
      primary_crews: count(wo.primary_crews, `roi_alternative.wards[${i}].primary_crews`),
      alternative_crews: count(wo.alternative_crews, `roi_alternative.wards[${i}].alternative_crews`),
    };
  });
  check(wards.every((w) => citySet.has(w.city)), "roi_alternative.wards: unknown city");
  check(Object.values(pools).reduce((s, n) => s + n, 0) === assigned, "roi_alternative: pools do not balance");
  return {
    status: str(o.status, "roi_alternative.status"),
    objective: str(o.objective, "roi_alternative.objective"),
    ranking_scenario: oneOf(o.ranking_scenario, INTERVENTION_SCENARIOS, "roi_alternative.ranking_scenario"),
    city_pools: pools,
    assigned_crews: assigned,
    wards,
    comparison: byScenario(o.comparison, "roi_alternative.comparison", (x, _s, w) => {
      const co = obj(x, w);
      return {
        region: roiComparison(obj(co.region, `${w}.region`), `${w}.region`),
        cities: arr(co.cities, `${w}.cities`).map((c, i) => {
          const cc = obj(c, `${w}.cities[${i}]`);
          return { city: str(cc.city, `${w}.cities[${i}].city`), ...roiComparison(cc, `${w}.cities[${i}]`) };
        }),
      };
    }),
  };
}

export function parseInterventionSimulation(v: unknown): InterventionResponse {
  const o = obj(v, "intervention-simulation");
  const pol = obj(o.policy, "policy");
  const prm = obj(o.parameters, "parameters");
  const crews = obj(o.crews, "crews");
  const forecastWeeks = three(o.forecast_weeks, "forecast_weeks", isoDate);
  const scenarioShares = byScenario(prm.scenarios, "parameters.scenarios", (x, _s, w) => share(x, w));
  check(scenarioShares.low <= scenarioShares.base && scenarioShares.base <= scenarioShares.high, "parameters.scenarios: low <= base <= high");
  const ramp = obj(prm.ramp_by_horizon_week, "parameters.ramp_by_horizon_week");
  const rampOut: Record<string, number> = {};
  for (const h of ["2", "3", "4"]) rampOut[h] = share(ramp[h], `parameters.ramp_by_horizon_week.${h}`, true);
  check(Object.keys(ramp).length === 3, "parameters.ramp_by_horizon_week: weeks 2, 3 and 4 only");
  const saturation = nonNeg(prm.saturation_k, "parameters.saturation_k");
  check(saturation > 0, "parameters.saturation_k");
  const maxCrews = posInt(prm.max_crews_per_ward, "parameters.max_crews_per_ward");
  const includeAlt = bool(prm.include_roi_alternative, "parameters.include_roi_alternative");

  const scenarios = byScenario(o.scenarios, "scenarios", (x, s, w) => {
    const so = obj(x, w);
    const m = share(so.max_reduction, `${w}.max_reduction`);
    check(m === scenarioShares[s], `${w}.max_reduction does not match parameters.scenarios`);
    return {
      max_reduction: m,
      region: interventionTotals(obj(so.region, `${w}.region`), forecastWeeks, `${w}.region`),
      cities: arr(so.cities, `${w}.cities`).map((c, i) => {
        const co = obj(c, `${w}.cities[${i}]`);
        return { city: str(co.city, `${w}.cities[${i}].city`), ...interventionTotals(co, forecastWeeks, `${w}.cities[${i}]`) };
      }),
    };
  });
  const citySet = uniqueCities(scenarios.base.cities, "scenarios.base.cities");
  for (const s of INTERVENTION_SCENARIOS) {
    const names = scenarios[s].cities.map((c) => c.city);
    check(names.length === citySet.size && names.every((c) => citySet.has(c)), `scenarios.${s}.cities`);
  }

  const wards = arr(o.wards, "wards").map((w, i) => {
    const where = `wards[${i}]`;
    const wo = obj(w, where);
    const bp = obj(wo.baseline_planning_units, `${where}.baseline_planning_units`);
    const cr = obj(wo.crews, `${where}.crews`);
    const assigned = count(cr.assigned, `${where}.crews.assigned`);
    const demand = count(cr.scenario_demand, `${where}.crews.scenario_demand`);
    check(demand <= maxCrews && assigned <= demand, `${where}.crews: assignment out of range`);
    return {
      ward_id: str(wo.ward_id, `${where}.ward_id`),
      city: str(wo.city, `${where}.city`),
      priority_rank_in_city: posInt(wo.priority_rank_in_city, `${where}.priority_rank_in_city`),
      risk_tier: tier(wo.risk_tier, `${where}.risk_tier`),
      early_alert: bool(wo.early_alert, `${where}.early_alert`),
      population_density_sqkm: nonNeg(wo.population_density_sqkm, `${where}.population_density_sqkm`),
      predicted_cases_3wk: nonNeg(wo.predicted_cases_3wk, `${where}.predicted_cases_3wk`),
      baseline_weekly_cases: three(wo.baseline_weekly_cases, `${where}.baseline_weekly_cases`, nonNeg),
      baseline_planning_units: {
        saline: count(bp.saline, `${where}.baseline_planning_units.saline`),
        kits: count(bp.kits, `${where}.baseline_planning_units.kits`),
        weekly_bed_planning_units: three(bp.weekly_bed_planning_units, `${where}.baseline_planning_units.weekly_bed_planning_units`, count),
        peak_bed_planning_units: count(bp.peak_bed_planning_units, `${where}.baseline_planning_units.peak_bed_planning_units`),
      },
      crews: {
        scenario_demand: demand,
        assigned,
        coverage: nonNeg(cr.coverage, `${where}.crews.coverage`),
        next_crew_status: oneOf(cr.next_crew_status, ["ineligible", "at_cap", "available"] as const, `${where}.crews.next_crew_status`),
        next_crew_projected_cases_avoided_base: nullable(cr.next_crew_projected_cases_avoided_base, `${where}.crews.next_crew_projected_cases_avoided_base`, nonNeg),
      },
      scenarios: byScenario(wo.scenarios, `${where}.scenarios`, (x, _s, ws) => wardScenario(x, assigned, ws)),
    };
  });
  wardCities(wards, citySet, "wards");

  const ranking = arr(o.first_crew_ranking, "first_crew_ranking").map((r, i) => {
    const ro = obj(r, `first_crew_ranking[${i}]`);
    const rank = posInt(ro.rank, `first_crew_ranking[${i}].rank`);
    check(rank === i + 1, `first_crew_ranking[${i}].rank`);
    return {
      rank,
      ward_id: str(ro.ward_id, `first_crew_ranking[${i}].ward_id`),
      city: str(ro.city, `first_crew_ranking[${i}].city`),
      first_crew_projected_cases_avoided: nonNeg(ro.first_crew_projected_cases_avoided, `first_crew_ranking[${i}].first_crew_projected_cases_avoided`),
      assigned_crews: count(ro.assigned_crews, `first_crew_ranking[${i}].assigned_crews`),
    };
  });

  const crewOut = {
    total_crews: count(crews.total_crews, "crews.total_crews"),
    scenario_demand: count(crews.scenario_demand, "crews.scenario_demand"),
    assigned: count(crews.assigned, "crews.assigned"),
    unassigned: count(crews.unassigned, "crews.unassigned"),
    city_pools: countRecord(crews.city_pools, "crews.city_pools"),
  };
  check(crewOut.assigned + crewOut.unassigned === crewOut.total_crews, "crews: budget does not balance");

  const alt = o.roi_alternative;
  check(includeAlt === (alt !== null && alt !== undefined), "roi_alternative must be present exactly when requested");

  return {
    ...envelope(o),
    policy: {
      name: str(pol.name, "policy.name"),
      // Effect sizes are assumptions. A response that claims causal effects is rejected, never shown.
      causal: literal(pol.causal, false, "policy.causal"),
      effect_size_basis: str(pol.effect_size_basis, "policy.effect_size_basis"),
      crew_capacity_status: str(pol.crew_capacity_status, "policy.crew_capacity_status"),
      crew_assignment_source: str(pol.crew_assignment_source, "policy.crew_assignment_source"),
      timing: str(pol.timing, "policy.timing"),
      description: str(pol.description, "policy.description"),
    },
    parameters: {
      scenarios: scenarioShares,
      saturation_k: saturation,
      density_per_crew_sqkm: nonNeg(prm.density_per_crew_sqkm, "parameters.density_per_crew_sqkm"),
      max_crews_per_ward: maxCrews,
      ramp_by_horizon_week: rampOut,
      total_crews: count(prm.total_crews, "parameters.total_crews"),
      min_coverage_pct: percent(prm.min_coverage_pct, "parameters.min_coverage_pct"),
      include_roi_alternative: includeAlt,
      roi_definition: str(prm.roi_definition, "parameters.roi_definition"),
    },
    weekly_source: oneOf(o.weekly_source, WEEKLY_SOURCES, "weekly_source"),
    forecast_weeks: forecastWeeks,
    assumptions: strs(o.assumptions, "assumptions"),
    limitations: strs(o.limitations, "limitations"),
    warnings: strs(o.warnings, "warnings"),
    crews: crewOut,
    scenarios,
    wards,
    first_crew_ranking: ranking,
    roi_alternative: includeAlt ? roiAlternative(alt, citySet) : null,
  };
}

// ---------------------------------------------------------------- Task 5: /dispatch-brief (JSON)
const SCENARIO_ID = /^DO-\d{8}-S\d{1,3}-F\d{1,3}-C\d{1,5}-H\d{1,3}-I(LOW|BASE|HIGH)-W[CE]$/;
const DRAFT_LABEL = "DRAFT / NOT SENT";
const SECTION_LABEL_PREFIX: Record<DispatchSectionKey, string> = {
  forecast_estimates: "FORECAST-DERIVED ESTIMATES",
  resource_plan: "SUGGESTED ALLOCATION",
  crew_scenario: "HYPOTHETICAL CREW SCENARIO",
  hospital_overflow: "HYPOTHETICAL CAPACITY",
  intervention_scenario: "ASSUMED-EFFECT INTERVENTION SCENARIO",
};

/** Validates the label and the safety fields of a section; other planning fields are kept as sent. */
function dispatchSection(v: unknown, key: DispatchSectionKey): DispatchSection {
  const o = obj(v, `sections.${key}`);
  const label = str(o.label, `sections.${key}.label`);
  check(label.startsWith(SECTION_LABEL_PREFIX[key]), `sections.${key}.label`);
  if (key === "intervention_scenario") literal(o.causal, false, "sections.intervention_scenario.causal");
  if (key === "hospital_overflow") {
    check(str(o.units, "sections.hospital_overflow.units").includes("not patients"), "sections.hospital_overflow.units");
    str(o.capacity_status, "sections.hospital_overflow.capacity_status");
  }
  return { ...o, label };
}

export function parseDispatchBrief(v: unknown): DispatchBriefResponse {
  const o = obj(v, "dispatch-brief");
  const st = obj(o.status, "status");
  const scope = obj(o.scope, "scope");
  const sc = obj(o.scenario, "scenario");
  const prm = obj(sc.parameters, "scenario.parameters");
  const sections = obj(o.sections, "sections");

  const labels = strs(st.labels, "status.labels");
  check(labels.includes(DRAFT_LABEL), "status.labels must include the draft label");
  // The safety flags are fixed values: any other value is rejected so the UI can never show a "sent" brief.
  const status = {
    draft: literal(st.draft, true, "status.draft"),
    sent: literal(st.sent, false, "status.sent"),
    authorised: literal(st.authorised, false, "status.authorised"),
    simulated: literal(st.simulated, true, "status.simulated"),
    historical_replay: literal(st.historical_replay, true, "status.historical_replay"),
    human_verification_required: literal(st.human_verification_required, true, "status.human_verification_required"),
    dispatch_capability: literal(st.dispatch_capability, "none", "status.dispatch_capability"),
    labels,
    statement: str(st.statement, "status.statement"),
  };

  const scenarioId = str(o.scenario_id, "scenario_id");
  check(SCENARIO_ID.test(scenarioId), "scenario_id");
  const documentId = str(o.document_id, "document_id");
  check(documentId.startsWith(`${scenarioId}.`) && /^[A-Z0-9.-]+$/.test(documentId), "document_id");
  const fingerprint = str(o.scenario_fingerprint, "scenario_fingerprint");
  check(/^[0-9a-f]{16}$/.test(fingerprint), "scenario_fingerprint");

  const type = oneOf(scope.type, ["city", "ward"] as const, "scope.type");
  const wardId = nullable(scope.ward_id, "scope.ward_id", str);
  check(type === "ward" ? wardId !== null : wardId === null, "scope.ward_id does not match scope.type");
  const issueWeek = isoDate(sc.issue_week, "scenario.issue_week");
  check(scenarioId.startsWith(`DO-${issueWeek.replace(/-/g, "")}-`), "scenario_id does not match the issue week");

  const included = arr(o.sections_included, "sections_included").map((k) => oneOf(k, DISPATCH_SECTION_KEYS, "sections_included[]"));
  check(included.length > 0 && included[0] === "forecast_estimates", "sections_included must start with forecast_estimates");
  const keys = Object.keys(sections);
  check(keys.length === included.length && included.every((k) => keys.includes(k)), "sections do not match sections_included");
  const parsedSections: Partial<Record<DispatchSectionKey, DispatchSection>> = {};
  for (const k of included) parsedSections[k] = dispatchSection(sections[k], k);

  const checklist = strs(o.verification_checklist, "verification_checklist");
  check(checklist.length > 0, "verification_checklist must not be empty");

  return {
    mode: literal(o.mode, "historical_replay", "mode"),
    notice: str(o.notice, "notice"),
    brief_version: str(o.brief_version, "brief_version"),
    status,
    scenario_id: scenarioId,
    document_id: documentId,
    scenario_fingerprint: fingerprint,
    scope: {
      type,
      city: str(scope.city, "scope.city"),
      ward_id: wardId,
      display_name: str(scope.display_name, "scope.display_name"),
      ...(scope.ward_count === undefined ? {} : { ward_count: posInt(scope.ward_count, "scope.ward_count") }),
    },
    audience: oneOf(o.audience, ["resource", "hospital", "all"] as const, "audience"),
    variant: oneOf(o.variant, ["short", "detailed"] as const, "variant"),
    intended_role: str(o.intended_role, "intended_role"),
    scenario: {
      issue_week: issueWeek,
      forecast_weeks: three(sc.forecast_weeks, "scenario.forecast_weeks", isoDate),
      horizon_weeks: three(sc.horizon_weeks, "scenario.horizon_weeks", count).map((h, j) => horizon(h, j, `scenario.horizon_weeks[${j}]`)),
      model_version: str(sc.model_version, "scenario.model_version"),
      weekly_source: oneOf(sc.weekly_source, WEEKLY_SOURCES, "scenario.weekly_source"),
      weekly_model_version: nullable(sc.weekly_model_version, "scenario.weekly_model_version", str),
      parameters: {
        stock_pct: count(prm.stock_pct, "scenario.parameters.stock_pct"),
        min_coverage_pct: count(prm.min_coverage_pct, "scenario.parameters.min_coverage_pct"),
        total_crews: count(prm.total_crews, "scenario.parameters.total_crews"),
        capacity_pct: count(prm.capacity_pct, "scenario.parameters.capacity_pct"),
        intervention_scenario: oneOf(prm.intervention_scenario, INTERVENTION_SCENARIOS, "scenario.parameters.intervention_scenario"),
      },
      notice: str(sc.notice, "scenario.notice"),
    },
    sections_included: included,
    sections: parsedSections,
    verification_checklist: checklist,
    warnings: strs(o.warnings, "warnings"),
    assumptions: strs(o.assumptions, "assumptions"),
    limitations: strs(o.limitations, "limitations"),
  };
}
