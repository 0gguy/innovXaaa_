// Types mirror the actual FastAPI responses (backend/app/main.py) and the ML result
// object (ml/predict.py Forecaster._result). Classification stays in the backend.

export type RiskTier = "Low" | "Medium" | "High" | "Critical";
export const TIER_ORDER: readonly RiskTier[] = ["Low", "Medium", "High", "Critical"];

export interface CityMeta {
  city: string;
  ward_count: number;
  wards: string[];
}

export interface WardMeta {
  ward_id: string;
  city: string;
}

export interface Meta {
  mode: string;
  notice: string;
  model_version: string;
  cities: CityMeta[];
  wards: WardMeta[];
  ward_count: number;
  valid_issue_weeks: {
    first: string;
    last: string;
    weekday: string;
    actuals_available_until_issue_week: string;
  };
  horizon_weeks: number[];
  risk_tiers: { labels: RiskTier[]; edges: number[]; rule: string };
  early_alert: { threshold: number; rule: string };
}

export interface DriverGroup {
  group: string;
  contribution: number;
}

export interface Drivers {
  baseline: number;
  groups: DriverGroup[];
  note: string;
}

export interface Observed {
  available: boolean;
  actual_cases_3wk: number | null;
  actual_risk_tier: RiskTier | null;
  note: string;
}

export interface Forecast {
  ward_id: string;
  city: string;
  issue_week: string;
  horizon_weeks: number[];
  forecast_weeks: string[];
  predicted_cases_3wk: number;
  risk_tier: RiskTier;
  early_alert: boolean;
  raw_model_output: number;
  model_version: string;
  data_source: string;
  warnings: string[];
  drivers: Drivers | null; // null when drivers were not requested or not reproducible
  actual: Observed | null; // observed outcome, for historical comparison only
}

export interface WardForecastResponse {
  mode: string;
  notice: string;
  forecast: Forecast;
}

export interface AllForecastsResponse {
  mode: string;
  notice: string;
  issue_date: string;
  count: number;
  forecasts: Forecast[];
}
