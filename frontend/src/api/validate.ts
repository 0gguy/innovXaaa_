import {
  TIER_ORDER,
  type AllForecastsResponse,
  type Drivers,
  type Forecast,
  type Meta,
  type Observed,
  type RiskTier,
  type WardForecastResponse,
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

export function parseForecast(v: unknown): Forecast {
  const o = obj(v, "forecast");
  return {
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
}

export function parseMeta(v: unknown): Meta {
  const o = obj(v, "meta");
  const weeks = obj(o.valid_issue_weeks, "valid_issue_weeks");
  const tiers = obj(o.risk_tiers, "risk_tiers");
  const alert = obj(o.early_alert, "early_alert");
  return {
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
