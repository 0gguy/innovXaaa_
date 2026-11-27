// Shared planning-scenario model and pure query builders. No rendering, no network.
import { describe, expect, it } from "vitest";
import { buildAllocationQuery, buildDispatchQuery, buildHospitalRoutingQuery, buildInterventionQuery } from "./queries";
import {
  createScenario,
  isDefault,
  issueDateError,
  NUMERIC_FIELDS,
  NUMERIC_SPECS,
  parseField,
  readScenario,
  scenarioReducer,
  type NumericField,
  type ScenarioAction,
  type ScenarioState,
} from "./scenario";

const WEEKS = { first: "2016-02-01", last: "2025-12-01" };

function run(state: ScenarioState, ...actions: ScenarioAction[]): ScenarioState {
  return actions.reduce(scenarioReducer, state);
}
const set = (field: NumericField, text: string): ScenarioAction => ({ type: "setText", field, text });

async function readRepoFile(path: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
  return fs.readFileSync(path, "utf8");
}

// ---------------------------------------------------------------- A. defaults pinned to the backend source
describe("verified backend contract", () => {
  it("starts from the backend defaults", () => {
    const s = createScenario();
    expect(s.issueDate).toBeNull();
    expect(readScenario(s)).toEqual({
      values: { stockPct: 100, stockPctSaline: null, stockPctKits: null, minCoveragePct: 30, totalCrews: 60, capacityPct: 100 },
      errors: {},
    });
    expect(s.includeRoiAlternative).toBe(false);
    expect(s.interventionScenario).toBe("base");
    for (const f of NUMERIC_FIELDS) expect(isDefault(s, f), f).toBe(true);
  });

  it("matches the limits and defaults in backend/app/planning/parameters.py and main.py", async () => {
    const params = await readRepoFile("../backend/app/planning/parameters.py");
    const main = await readRepoFile("../backend/app/main.py");
    const triple = (name: string) => {
      const m = new RegExp(`${name}_MIN, ${name}_MAX, ${name}_DEFAULT = (\\d+), (\\d+), (\\d+)`).exec(params);
      expect(m, name).not.toBeNull();
      return m!.slice(1).map(Number);
    };
    expect(triple("STOCK_PCT")).toEqual([NUMERIC_SPECS.stockPct.min, NUMERIC_SPECS.stockPct.max, NUMERIC_SPECS.stockPct.default]);
    expect(triple("MIN_COVERAGE_PCT")).toEqual([NUMERIC_SPECS.minCoveragePct.min, NUMERIC_SPECS.minCoveragePct.max, NUMERIC_SPECS.minCoveragePct.default]);
    expect(triple("CAPACITY_PCT")).toEqual([NUMERIC_SPECS.capacityPct.min, NUMERIC_SPECS.capacityPct.max, NUMERIC_SPECS.capacityPct.default]);
    expect(Number(/TOTAL_CREWS_DEFAULT = (\d+)/.exec(params)?.[1])).toBe(NUMERIC_SPECS.totalCrews.default);
    expect(Number(/TOTAL_CREWS_MAX = ([\d_]+)/.exec(params)?.[1]?.replace(/_/g, ""))).toBe(NUMERIC_SPECS.totalCrews.max);
    expect(main).toMatch(/total_crews: int = Query\(PP\.TOTAL_CREWS_DEFAULT, ge=0, le=PP\.TOTAL_CREWS_MAX\)/);
    // overrides: optional, same bounds as stock_pct, None -> inherit
    expect(main).toMatch(/stock_pct_saline: int \| None = Query\(None, ge=PP\.STOCK_PCT_MIN, le=PP\.STOCK_PCT_MAX\)/);
    expect(main).toMatch(/stock_pct_kits: int \| None = Query\(None, ge=PP\.STOCK_PCT_MIN, le=PP\.STOCK_PCT_MAX\)/);
    expect(NUMERIC_SPECS.stockPctSaline).toEqual({ min: 30, max: 100, default: null });
    expect(NUMERIC_SPECS.stockPctKits).toEqual({ min: 30, max: 100, default: null });
    expect(main).toMatch(/include_roi_alternative: bool = False/);
    expect(main).toMatch(/intervention_scenario: Literal\["low", "base", "high"\] = "base"/);
  });
});

// ---------------------------------------------------------------- parsing: bounds, wholes, drafts, no clamping
describe("parsing numeric boxes", () => {
  it("E. accepts exactly the backend ranges, inclusive, and rejects one past each end", () => {
    for (const f of NUMERIC_FIELDS) {
      const { min, max } = NUMERIC_SPECS[f];
      expect(parseField(f, String(min)), `${f} min`).toEqual({ ok: true, value: min });
      expect(parseField(f, String(max)), `${f} max`).toEqual({ ok: true, value: max });
      expect(parseField(f, String(min - 1)), `${f} below`).toEqual({ ok: false, error: "outOfRange" });
      expect(parseField(f, String(max + 1)), `${f} above`).toEqual({ ok: false, error: "outOfRange" });
    }
    expect(parseField("minCoveragePct", "-1")).toEqual({ ok: false, error: "outOfRange" });
    expect(parseField("totalCrews", "-5")).toEqual({ ok: false, error: "outOfRange" });
  });

  it("D. takes whole crews only and never rounds", () => {
    expect(parseField("totalCrews", "12")).toEqual({ ok: true, value: 12 });
    expect(parseField("totalCrews", "12.5")).toEqual({ ok: false, error: "notWhole" });
    expect(parseField("totalCrews", "0.4")).toEqual({ ok: false, error: "notWhole" });
    expect(parseField("stockPct", "50.5")).toEqual({ ok: false, error: "notWhole" });
  });

  it("G. treats empty, non-numeric and exotic notations as drafts with an error, never as NaN or Infinity", () => {
    expect(parseField("stockPct", "")).toEqual({ ok: false, error: "required" });
    expect(parseField("totalCrews", "   ")).toEqual({ ok: false, error: "required" });
    for (const raw of ["abc", "1e3", "0x10", "Infinity", "NaN", "5%", "1,000", "--5", "."]) {
      expect(parseField("totalCrews", raw), raw).toEqual({ ok: false, error: "notNumber" });
    }
    expect(parseField("totalCrews", "999999999999999999999999")).toEqual({ ok: false, error: "outOfRange" });
    expect(parseField("stockPct", " 050 ")).toEqual({ ok: true, value: 50 });
    expect(parseField("stockPct", "৫০")).toEqual({ ok: true, value: 50 }); // Bangla digits, same value
  });

  it("G/J. keeps an invalid entry exactly as typed and never clamps it", () => {
    const s = run(createScenario(), set("stockPct", "150"), { type: "normalize", field: "stockPct" });
    expect(s.text.stockPct).toBe("150");
    expect(readScenario(s).errors).toEqual({ stockPct: "outOfRange" });
    expect(readScenario(s).values.stockPct).toBeUndefined();
    const t = run(createScenario(), set("totalCrews", "7.5"), { type: "normalize", field: "totalCrews" });
    expect(t.text.totalCrews).toBe("7.5");
  });

  it("tidies only a valid entry when the box is left", () => {
    const s = run(createScenario(), set("stockPct", " 080 "), { type: "normalize", field: "stockPct" });
    expect(s.text.stockPct).toBe("80");
    const b = run(createScenario(), set("capacityPct", "১২০"), { type: "normalize", field: "capacityPct" });
    expect(b.text.capacityPct).toBe("120");
  });
});

// ---------------------------------------------------------------- B/C. optional overrides
describe("saline and kit overrides", () => {
  it("B. distinguishes an explicit override from the inherited general stock", () => {
    const s = run(createScenario(), set("stockPct", "70"), set("stockPctSaline", "55"));
    expect(readScenario(s).values).toMatchObject({ stockPct: 70, stockPctSaline: 55, stockPctKits: null });
    const q = buildAllocationQuery(s, WEEKS);
    expect(q).toEqual({ ok: true, query: { stock_pct: 70, stock_pct_saline: 55 } });
  });

  it("C. keeps 'absent' (empty box) apart from an explicit value, including one equal to the general stock", () => {
    const empty = createScenario();
    expect(readScenario(empty).values.stockPctKits).toBeNull();
    expect(buildAllocationQuery(empty, WEEKS)).toEqual({ ok: true, query: {} });
    const same = run(createScenario(), set("stockPctKits", "100"));
    expect(buildAllocationQuery(same, WEEKS)).toEqual({ ok: true, query: { stock_pct_kits: 100 } }); // explicit, sent
  });

  it("C. never reads zero as 'absent': 0 is an explicit value, and below the backend minimum of 30 it is an error", () => {
    const s = run(createScenario(), set("stockPctSaline", "0"));
    expect(readScenario(s).errors).toEqual({ stockPctSaline: "outOfRange" });
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: false, errors: { stockPctSaline: "outOfRange" } });
  });

  it("clearing an override returns it to inheriting the general stock", () => {
    const s = run(createScenario(), set("stockPctSaline", "40"), { type: "resetField", field: "stockPctSaline" });
    expect(s.text.stockPctSaline).toBe("");
    expect(readScenario(s).values.stockPctSaline).toBeNull();
  });
});

// ---------------------------------------------------------------- F. issue date
describe("planning issue date", () => {
  it("accepts a Monday inside the valid range and rejects everything else", () => {
    expect(issueDateError("2025-07-28", WEEKS)).toBeNull();
    expect(issueDateError("2016-02-01", WEEKS)).toBeNull();
    expect(issueDateError("2025-12-01", WEEKS)).toBeNull();
    expect(issueDateError("2025-07-29", WEEKS)).toBe("notMonday");
    expect(issueDateError("2025-12-08", WEEKS)).toBe("unavailable");
    expect(issueDateError("2016-01-25", WEEKS)).toBe("unavailable");
    for (const bad of ["2025-02-30", "2025-13-01", "28/07/2025", "2025-7-28", "", "2025-07-28T00:00"]) {
      expect(issueDateError(bad, WEEKS), bad).toBe("invalidDate");
    }
  });

  it("is never changed automatically; null means the backend picks the last valid week", () => {
    const s = createScenario();
    expect(buildHospitalRoutingQuery(s, WEEKS)).toEqual({ ok: true, query: {} });
    const chosen = run(s, { type: "setIssueDate", issueDate: "2025-07-28" });
    expect(buildHospitalRoutingQuery(chosen, WEEKS)).toEqual({ ok: true, query: { issue_date: "2025-07-28" } });
    const later = run(chosen, set("capacityPct", "80"), { type: "resetAssumptions" });
    expect(later.issueDate).toBe("2025-07-28");
  });

  it("can start from the Phase 1 week (same YYYY-MM-DD Monday format, no conversion)", () => {
    const s = createScenario({ issueDate: "2025-07-28" });
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: true, query: { issue_date: "2025-07-28" } });
  });

  it("refuses to build a query for an invalid week", () => {
    const s = createScenario({ issueDate: "2025-07-29" });
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: false, errors: { issueDate: "notMonday" } });
  });
});

// ---------------------------------------------------------------- H/I. reset and unchanged updates
describe("updates and reset", () => {
  it("H. resets every assumption to the default without touching the issue week", () => {
    const start = createScenario({ issueDate: "2025-07-28" });
    const changed = run(
      start,
      set("stockPct", "45"),
      set("stockPctKits", "60"),
      set("totalCrews", "0"),
      set("capacityPct", "abc"),
      { type: "setIncludeRoiAlternative", value: true },
      { type: "setInterventionScenario", value: "high" },
    );
    const reset = run(changed, { type: "resetAssumptions" });
    expect(reset).toEqual(start);
  });

  it("I. resetting one field leaves every other field alone", () => {
    const s = run(createScenario(), set("stockPct", "45"), set("totalCrews", "12"), { type: "setInterventionScenario", value: "low" });
    const r = run(s, { type: "resetField", field: "stockPct" });
    expect(r.text.stockPct).toBe("100");
    expect(r.text.totalCrews).toBe("12");
    expect(r.interventionScenario).toBe("low");
    const r2 = run(s, { type: "resetField", field: "interventionScenario" });
    expect(r2.interventionScenario).toBe("base");
    expect(r2.text.stockPct).toBe("45");
  });

  it("returns the same object when nothing changes (no needless re-render)", () => {
    const s = createScenario();
    expect(scenarioReducer(s, set("stockPct", "100"))).toBe(s);
    expect(scenarioReducer(s, { type: "resetAssumptions" })).toBe(s);
    expect(scenarioReducer(s, { type: "resetField", field: "totalCrews" })).toBe(s);
    expect(scenarioReducer(s, { type: "setIncludeRoiAlternative", value: false })).toBe(s);
    expect(scenarioReducer(s, { type: "setInterventionScenario", value: "base" })).toBe(s);
    expect(scenarioReducer(s, { type: "setIssueDate", issueDate: null })).toBe(s);
    expect(scenarioReducer(s, { type: "normalize", field: "stockPct" })).toBe(s);
  });

  it("ignores an intervention scenario the backend does not accept", () => {
    const s = createScenario();
    expect(scenarioReducer(s, { type: "setInterventionScenario", value: "extreme" as never })).toBe(s);
  });
});

// ---------------------------------------------------------------- K-P. query builders
describe("query builders", () => {
  it("O. send nothing when every value is the backend default", () => {
    const s = createScenario();
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: true, query: {} });
    expect(buildHospitalRoutingQuery(s, WEEKS)).toEqual({ ok: true, query: {} });
    expect(buildInterventionQuery(s, WEEKS)).toEqual({ ok: true, query: {} });
    expect(buildDispatchQuery(s, WEEKS, { scope: "city", city: "Dhaka North" })).toEqual({
      ok: true,
      query: { scope: "city", city: "Dhaka North" },
      notCarried: [],
    });
  });

  it("K. allocation carries stock, overrides, coverage and crews only", () => {
    const s = run(
      createScenario({ issueDate: "2025-07-28" }),
      set("stockPct", "60"),
      set("stockPctSaline", "45"),
      set("stockPctKits", "90"),
      set("minCoveragePct", "20"),
      set("totalCrews", "80"),
      set("capacityPct", "150"),
      { type: "setIncludeRoiAlternative", value: true },
    );
    expect(buildAllocationQuery(s, WEEKS)).toEqual({
      ok: true,
      query: { issue_date: "2025-07-28", stock_pct: 60, stock_pct_saline: 45, stock_pct_kits: 90, min_coverage_pct: 20, total_crews: 80 },
    });
  });

  it("L. hospital routing carries capacity only, and ignores errors in fields it does not use", () => {
    const s = run(createScenario(), set("capacityPct", "75"), set("stockPct", "oops"));
    expect(buildHospitalRoutingQuery(s, WEEKS)).toEqual({ ok: true, query: { capacity_pct: 75 } });
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: false, errors: { stockPct: "notNumber" } });
  });

  it("M. intervention carries crews, coverage and the ROI flag (only when on)", () => {
    const s = run(createScenario(), set("totalCrews", "25"), { type: "setIncludeRoiAlternative", value: true }, { type: "setInterventionScenario", value: "high" });
    expect(buildInterventionQuery(s, WEEKS)).toEqual({ ok: true, query: { total_crews: 25, include_roi_alternative: true } });
  });

  it("N. dispatch carries the shared values it accepts plus its own selection and presentation options", () => {
    const s = run(
      createScenario({ issueDate: "2025-07-28" }),
      set("stockPct", "50"),
      set("capacityPct", "130"),
      set("totalCrews", "0"),
      { type: "setInterventionScenario", value: "low" },
    );
    expect(buildDispatchQuery(s, WEEKS, { scope: "ward", wardId: "DNCC_Ward_12", audience: "hospital", variant: "short", download: true })).toEqual({
      ok: true,
      query: {
        scope: "ward",
        ward_id: "DNCC_Ward_12",
        issue_date: "2025-07-28",
        audience: "hospital",
        variant: "short",
        stock_pct: 50,
        total_crews: 0,
        capacity_pct: 130,
        intervention_scenario: "low",
        download: true,
      },
      notCarried: [],
    });
  });

  it("N. dispatch reports saline/kit overrides it cannot carry instead of dropping them silently", () => {
    const s = run(createScenario(), set("stockPctSaline", "40"));
    const r = buildDispatchQuery(s, WEEKS, { scope: "city", city: "Gazipur" });
    expect(r.ok).toBe(true);
    expect(r.notCarried).toEqual(["stockPctSaline"]);
    if (r.ok) expect(r.query).not.toHaveProperty("stock_pct_saline");
  });

  it("N. dispatch enforces the backend's selection rules", () => {
    const s = createScenario();
    expect(buildDispatchQuery(s, WEEKS, { scope: "city" })).toMatchObject({ ok: false, errors: { city: "missingCity" } });
    expect(buildDispatchQuery(s, WEEKS, { scope: "ward", city: "Gazipur" })).toMatchObject({ ok: false, errors: { wardId: "missingWard" } });
    expect(buildDispatchQuery(s, WEEKS, { scope: "ward", wardId: "DNCC Ward 12" })).toMatchObject({ ok: false, errors: { wardId: "invalidWard" } });
    expect(buildDispatchQuery(s, WEEKS, { scope: "ward", wardId: "x".repeat(41) })).toMatchObject({ ok: false, errors: { wardId: "invalidWard" } });
    expect(buildDispatchQuery(s, WEEKS, { scope: "city", city: "x".repeat(41) })).toMatchObject({ ok: false, errors: { city: "invalidCity" } });
    // dispatch presentation options are not part of the shared state
    expect(Object.keys(s).sort()).toEqual(["includeRoiAlternative", "interventionScenario", "issueDate", "text"]);
  });

  it("P. always sends explicit zeros", () => {
    const s = run(createScenario(), set("totalCrews", "0"), set("minCoveragePct", "0"));
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: true, query: { min_coverage_pct: 0, total_crews: 0 } });
    expect(buildInterventionQuery(s, WEEKS)).toEqual({ ok: true, query: { total_crews: 0, min_coverage_pct: 0 } });
    const q = buildAllocationQuery(s, WEEKS);
    if (q.ok) expect(Object.is(q.query.total_crews, 0)).toBe(true); // not -0
    expect(buildAllocationQuery(run(createScenario(), set("totalCrews", "-0")), WEEKS)).toEqual({ ok: true, query: { total_crews: 0 } });
  });

  it("collects every error at once and never returns a partial query", () => {
    const s = run(createScenario({ issueDate: "nope" }), set("stockPct", ""), set("totalCrews", "2.5"));
    expect(buildAllocationQuery(s, WEEKS)).toEqual({ ok: false, errors: { issueDate: "invalidDate", stockPct: "required", totalCrews: "notWhole" } });
  });

  it("produces deterministic, finite, integer-only queries", () => {
    const s = run(createScenario({ issueDate: "2025-07-28" }), set("stockPct", "61"), set("totalCrews", "9"));
    const a = buildAllocationQuery(s, WEEKS);
    expect(buildAllocationQuery(s, WEEKS)).toEqual(a);
    expect(JSON.stringify(buildAllocationQuery(s, WEEKS))).toBe(JSON.stringify(a));
    if (a.ok) for (const v of Object.values(a.query)) if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
  });
});
