import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "./client";
import { parseForecast, parseMeta, parseWardForecast } from "./validate";
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
