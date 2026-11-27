import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "./client";
import { parseAllForecasts, parseForecast, parseMeta, parseWardForecast, ShapeError } from "./validate";
import { allFor, makeForecast, makeMeta, oneFor } from "../test/fixtures";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());

describe("response parsing", () => {
  it("parses a meta response", () => {
    const m = parseMeta(makeMeta());
    expect(m.cities).toHaveLength(5);
    expect(m.early_alert.threshold).toBe(25);
    expect(m.valid_issue_weeks.last).toBe("2025-12-29");
  });

  it("parses a single-ward forecast including drivers and observed outcome", () => {
    const r = parseWardForecast(oneFor("DNCC_Ward_12", "2025-07-28"));
    expect(r.forecast.risk_tier).toBe("Critical");
    expect(r.forecast.early_alert).toBe(true);
    expect(r.forecast.drivers?.groups[0]?.group).toBe("Recent dengue cases");
    expect(r.forecast.actual?.actual_cases_3wk).toBe(33);
  });

  it("treats missing optional drivers and actual as null", () => {
    const raw = { ...makeForecast("CCC_Ward_01", "Chattogram", "2025-07-28", 2.2) } as Record<string, unknown>;
    delete raw.drivers;
    delete raw.actual;
    const f = parseForecast(raw);
    expect(f.drivers).toBeNull();
    expect(f.actual).toBeNull();
  });

  it("rejects malformed data", () => {
    expect(() => parseForecast({ ...makeForecast("A", "B", "2025-07-28", 1), risk_tier: "Severe" })).toThrow();
    expect(() => parseForecast({ ...makeForecast("A", "B", "2025-07-28", 1), predicted_cases_3wk: "12" })).toThrow();
    expect(() => parseMeta({ cities: [] })).toThrow();
  });
});

describe("api client", () => {
  it("requests read-only GET endpoints with the expected URLs", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (url.includes("/meta")) return json(makeMeta());
      if (url.includes("/forecast/")) return json(oneFor("DNCC_Ward_12", "2025-07-28"));
      return json(allFor("2025-07-28"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = createClient("http://127.0.0.1:8000/");
    await c.meta();
    await c.forecastWard("DNCC_Ward_12", "2025-07-28", true);
    await c.forecastAll("2025-07-28");
    const calls = fetchMock.mock.calls.map((a) => [a[0], (a[1] as RequestInit).method]);
    expect(calls).toEqual([
      ["http://127.0.0.1:8000/meta", "GET"],
      ["http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28&include_drivers=true", "GET"],
      ["http://127.0.0.1:8000/forecast?issue_date=2025-07-28&include_drivers=false", "GET"],
    ]);
  });

  it("maps the backend error envelope to ApiError with its code", async () => {
    vi.stubGlobal("fetch", () =>
      json({ error: { code: "model_unavailable", message: "The forecasting model is not available." } }, 503),
    );
    await expect(createClient("http://x").meta()).rejects.toMatchObject({
      kind: "http",
      status: 503,
      code: "model_unavailable",
    });
  });

  it("reports an unreachable backend as a network error", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(createClient("http://x").meta()).rejects.toMatchObject({ kind: "network" });
  });

  it("reports unexpected data as a shape error", async () => {
    vi.stubGlobal("fetch", () => json({ hello: "world" }));
    await expect(createClient("http://x").meta()).rejects.toMatchObject({ kind: "shape" });
  });

  it("times out", async () => {
    vi.stubGlobal(
      "fetch",
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))),
    );
    await expect(createClient("http://x", 20).meta()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("aborts when the caller cancels", async () => {
    vi.stubGlobal(
      "fetch",
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))),
    );
    const ctl = new AbortController();
    const p = createClient("http://x").meta(ctl.signal);
    ctl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------- Phase 2, Task 1: weekly split
const WEEKS = ["2025-08-11", "2025-08-18", "2025-08-25"];

function weeklyBlock(values: number[], over: Record<string, unknown> = {}) {
  return {
    source: "companion",
    model_version: "weekly-xgb-2to4w-1.0.0",
    fallback_reason: null,
    reconciled_to: "predicted_cases_3wk",
    weeks: values.map((v, i) => ({ horizon_week: i + 2, forecast_week: WEEKS[i], predicted_cases: v })),
    note: "Split of predicted_cases_3wk into weeks t+2, t+3 and t+4.",
    ...over,
  };
}

/** A copy without one key (to test missing required fields). */
function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const c = { ...o };
  delete c[key];
  return c;
}

/** A forecast for 31.2 cases with a weekly block (or the given replacement for it). */
function withWeekly(weekly: unknown) {
  return { ...makeForecast("DNCC_Ward_12", "Dhaka North", "2025-07-28", 31.2), weekly };
}

describe("weekly forecast block", () => {
  it("keeps a valid companion split instead of dropping it", () => {
    const f = parseForecast(withWeekly(weeklyBlock([9.1, 10.6, 11.5])));
    expect(f.weekly?.source).toBe("companion");
    expect(f.weekly?.model_version).toBe("weekly-xgb-2to4w-1.0.0");
    expect(f.weekly?.fallback_reason).toBeNull();
    expect(f.weekly?.weeks.map((w) => [w.horizon_week, w.forecast_week, w.predicted_cases])).toEqual([
      [2, "2025-08-11", 9.1],
      [3, "2025-08-18", 10.6],
      [4, "2025-08-25", 11.5],
    ]);
    // the 3-week total, tier and alert are untouched
    expect(f.predicted_cases_3wk).toBe(31.2);
    expect(f.risk_tier).toBe("Critical");
  });

  it("keeps an equal-split fallback with its reason", () => {
    const t = 31.2;
    const f = parseForecast(
      withWeekly(weeklyBlock([t / 3, t / 3, t - 2 * (t / 3)], { source: "equal_split", model_version: null, fallback_reason: "companion_unavailable" })),
    );
    expect(f.weekly?.source).toBe("equal_split");
    expect(f.weekly?.model_version).toBeNull();
    expect(f.weekly?.fallback_reason).toBe("companion_unavailable");
  });

  it("leaves forecasts without a weekly block exactly as before", () => {
    const f = parseForecast(makeForecast("CCC_Ward_01", "Chattogram", "2025-07-28", 2.2));
    expect("weekly" in f).toBe(false);
    expect(parseWardForecast(oneFor("DNCC_Ward_12", "2025-07-28")).forecast).toEqual(oneFor("DNCC_Ward_12", "2025-07-28").forecast);
  });

  it("parses weekly blocks inside the all-wards response", () => {
    const all = allFor("2025-07-28");
    const forecasts = all.forecasts.map((f) => ({ ...f, weekly: weeklyBlock([f.predicted_cases_3wk / 2, f.predicted_cases_3wk / 4, f.predicted_cases_3wk / 4]) }));
    const r = parseAllForecasts({ ...all, forecasts });
    expect(r.forecasts.every((f) => f.weekly?.weeks.length === 3)).toBe(true);
  });

  it("accepts float rounding within the backend tolerance and rejects real mismatches", () => {
    expect(() => parseForecast(withWeekly(weeklyBlock([9.1, 10.6, 11.5 + 5e-7])))).not.toThrow();
    expect(() => parseForecast(withWeekly(weeklyBlock([9.1, 10.6, 11.6])))).toThrow(ShapeError);
    expect(() => parseForecast(withWeekly(weeklyBlock([0, 0, 0])))).toThrow(ShapeError);
  });

  it.each([
    ["two weeks", weeklyBlock([15.6, 15.6])],
    ["four weeks", { ...weeklyBlock([7.8, 7.8, 7.8]), weeks: [...weeklyBlock([7.8, 7.8, 7.8]).weeks, { horizon_week: 5, forecast_week: "2025-09-01", predicted_cases: 7.8 }] }],
    ["negative value", weeklyBlock([-1, 20.6, 11.6])],
    ["string value", { ...weeklyBlock([9.1, 10.6, 11.5]), weeks: weeklyBlock([9.1, 10.6, 11.5]).weeks.map((w, i) => (i === 0 ? { ...w, predicted_cases: "9.1" } : w)) }],
    ["infinite value", weeklyBlock([Number.POSITIVE_INFINITY, 10.6, 11.5])],
    ["missing value", { ...weeklyBlock([9.1, 10.6, 11.5]), weeks: weeklyBlock([9.1, 10.6, 11.5]).weeks.map((w, i) => (i === 1 ? { horizon_week: 3, forecast_week: WEEKS[1] } : w)) }],
    ["wrong horizon order", { ...weeklyBlock([9.1, 10.6, 11.5]), weeks: weeklyBlock([9.1, 10.6, 11.5]).weeks.map((w, i) => ({ ...w, horizon_week: 4 - i })) }],
    ["week date not matching forecast_weeks", { ...weeklyBlock([9.1, 10.6, 11.5]), weeks: weeklyBlock([9.1, 10.6, 11.5]).weeks.map((w, i) => (i === 2 ? { ...w, forecast_week: "2025-09-01" } : w)) }],
    ["unknown source", weeklyBlock([9.1, 10.6, 11.5], { source: "guess" })],
    ["missing fallback_reason key", omit(weeklyBlock([9.1, 10.6, 11.5]), "fallback_reason")],
    ["wrong reconciliation target", weeklyBlock([9.1, 10.6, 11.5], { reconciled_to: "something_else" })],
    ["missing weeks", weeklyBlock([9.1, 10.6, 11.5], { weeks: undefined })],
    ["null block", null],
    ["array instead of object", [9.1, 10.6, 11.5]],
  ])("rejects a malformed weekly block: %s", (_label, weekly) => {
    const bad = withWeekly(weekly);
    expect(() => parseForecast(bad)).toThrow(ShapeError);
  });
});

describe("weekly companion metadata", () => {
  const companion = {
    available: true,
    source: "companion",
    model_version: "weekly-xgb-2to4w-1.0.0",
    fallback_reason: null,
    horizon_weeks: [2, 3, 4],
    reconciled_to: "predicted_cases_3wk",
  };

  it("keeps weekly_companion when the backend sends it", () => {
    const m = parseMeta({ ...makeMeta(), weekly_companion: companion });
    expect(m.weekly_companion).toEqual(companion);
  });

  it("keeps an unavailable companion with its fallback reason", () => {
    const fb = { ...companion, available: false, source: "equal_split", model_version: null, fallback_reason: "companion_unavailable" };
    expect(parseMeta({ ...makeMeta(), weekly_companion: fb }).weekly_companion?.fallback_reason).toBe("companion_unavailable");
  });

  it("still accepts older metadata without it", () => {
    const m = parseMeta(makeMeta());
    expect(m.weekly_companion).toBeUndefined();
    expect(m.cities).toHaveLength(5);
  });

  it.each([
    ["available but equal split", { ...companion, source: "equal_split" }],
    ["unavailable but companion", { ...companion, available: false }],
    ["unknown source", { ...companion, source: "other" }],
    ["available as string", { ...companion, available: "yes" }],
    ["missing model_version key", omit(companion, "model_version")],
    ["not an object", "companion"],
  ])("rejects malformed weekly_companion: %s", (_label, wc) => {
    const bad = { ...makeMeta(), weekly_companion: wc };
    expect(() => parseMeta(bad)).toThrow(ShapeError);
  });
});

describe("weekly requests stay opt-in", () => {
  it("adds include_weekly only when asked and keeps the original URLs otherwise", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/forecast/")) return json(oneFor("DNCC_Ward_12", "2025-07-28"));
      return json(allFor("2025-07-28"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = createClient("http://127.0.0.1:8000");
    await c.forecastWard("DNCC_Ward_12", "2025-07-28", true);
    await c.forecastWard("DNCC_Ward_12", "2025-07-28", false, undefined, { includeWeekly: true });
    await c.forecastAll("2025-07-28");
    await c.forecastAll("2025-07-28", undefined, { includeWeekly: true });
    expect(fetchMock.mock.calls.map((a) => a[0])).toEqual([
      "http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28&include_drivers=true",
      "http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28&include_drivers=false&include_weekly=true",
      "http://127.0.0.1:8000/forecast?issue_date=2025-07-28&include_drivers=false",
      "http://127.0.0.1:8000/forecast?issue_date=2025-07-28&include_drivers=false&include_weekly=true",
    ]);
  });

  it("rejects a response whose weekly block is malformed as a shape error", async () => {
    vi.stubGlobal("fetch", () => json({ mode: "historical_replay", notice: "n", forecast: withWeekly(weeklyBlock([1, 1, 1])) }));
    await expect(
      createClient("http://x").forecastWard("DNCC_Ward_12", "2025-07-28", false, undefined, { includeWeekly: true }),
    ).rejects.toMatchObject({ kind: "shape" });
  });
});
