// TEST FIXTURES ONLY. These shape-match the backend responses so tests run offline; the app
// itself never ships fabricated data.
import type { ApiClient } from "../api/client";
import type { AllForecastsResponse, Forecast, Meta, RiskTier, WardForecastResponse } from "../api/types";

export const NOTICE =
  "Historical replay of a trained model on bundled data through 2025-12-29. These are model estimates, not verified real-world warnings or live predictions.";

export const CITY_WARDS: Record<string, string[]> = {
  Chattogram: ["CCC_Ward_01", "CCC_Ward_02"],
  "Dhaka North": ["DNCC_Ward_11", "DNCC_Ward_12", "DNCC_Ward_13"],
  "Dhaka South": ["DSCC_Ward_01"],
  Gazipur: ["GCC_Ward_01"],
  Narayanganj: ["NCC_Ward_01"],
};

export function makeMeta(): Meta {
  const cities = Object.entries(CITY_WARDS).map(([city, wards]) => ({ city, ward_count: wards.length, wards }));
  const wards = cities.flatMap((c) => c.wards.map((w) => ({ ward_id: w, city: c.city })));
  return {
    mode: "historical_replay",
    notice: NOTICE,
    model_version: "dengue-xgb-2to4w-1.1.0",
    cities,
    wards,
    ward_count: wards.length,
    valid_issue_weeks: {
      first: "2016-02-01",
      last: "2025-12-29",
      weekday: "Monday",
      actuals_available_until_issue_week: "2025-12-01",
    },
    horizon_weeks: [2, 3, 4],
    risk_tiers: { labels: ["Low", "Medium", "High", "Critical"], edges: [4.5, 14.5, 30.5], rule: "rule" },
    early_alert: { threshold: 25, rule: "predicted_cases_3wk > 25" },
  };
}

export function tierFor(p: number): RiskTier {
  return p < 4.5 ? "Low" : p < 14.5 ? "Medium" : p < 30.5 ? "High" : "Critical";
}

export function makeForecast(
  wardId: string,
  city: string,
  issue: string,
  predicted: number,
  over: Partial<Forecast> = {},
): Forecast {
  return {
    ward_id: wardId,
    city,
    issue_week: issue,
    horizon_weeks: [2, 3, 4],
    forecast_weeks: ["2025-08-11", "2025-08-18", "2025-08-25"],
    predicted_cases_3wk: predicted,
    risk_tier: tierFor(predicted),
    early_alert: predicted > 25,
    raw_model_output: predicted,
    model_version: "dengue-xgb-2to4w-1.1.0",
    data_source: "bundled_historical_data",
    warnings: [],
    drivers: {
      baseline: 9.5,
      groups: [
        { group: "Recent dengue cases", contribution: 12.3 },
        { group: "Rainfall (previous 1-4 weeks)", contribution: -3.4 },
        { group: "Humidity", contribution: 1.1 },
      ],
      note: "Additive model attributions (XGBoost TreeSHAP) of the raw model output; they describe how the model reached its number, not causes of dengue.",
    },
    actual: {
      available: true,
      actual_cases_3wk: 33,
      actual_risk_tier: "Critical",
      note: "Observed outcome from the historical data, for comparison only; not an input to the forecast.",
    },
    ...over,
  };
}

/** Predicted cases per ward: deterministic spread over all four tiers. */
export const PREDICTED: Record<string, number> = {
  CCC_Ward_01: 2.2, // Low
  CCC_Ward_02: 8.4, // Medium
  DNCC_Ward_11: 18.0, // High
  DNCC_Ward_12: 31.2, // Critical, early alert
  DNCC_Ward_13: 26.5, // High, early alert
  DSCC_Ward_01: 12.0, // Medium
  GCC_Ward_01: 3.0, // Low
  NCC_Ward_01: 40.0, // Critical, early alert
};

export function allFor(issue: string, shift = 0): AllForecastsResponse {
  const meta = makeMeta();
  const forecasts = meta.wards.map((w) =>
    makeForecast(w.ward_id, w.city, issue, (PREDICTED[w.ward_id] ?? 1) + shift),
  );
  return { mode: "historical_replay", notice: NOTICE, issue_date: issue, count: forecasts.length, forecasts };
}

export function oneFor(wardId: string, issue: string, over: Partial<Forecast> = {}): WardForecastResponse {
  const city = makeMeta().wards.find((w) => w.ward_id === wardId)?.city ?? "Dhaka North";
  return {
    mode: "historical_replay",
    notice: NOTICE,
    forecast: makeForecast(wardId, city, issue, PREDICTED[wardId] ?? 1, over),
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Immediately-resolving fake client; override pieces per test. */
export function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "http://test.invalid",
    meta: () => Promise.resolve(makeMeta()),
    forecastWard: (ward, date) => Promise.resolve(oneFor(ward, date)),
    forecastAll: (date) => Promise.resolve(allFor(date)),
    ...over,
  };
}
