import { useMemo, useReducer } from "react";
import type { InterventionScenario } from "../api/types";
import { INTERVENTION_SCENARIOS } from "../api/types";

/*
 * Shared planning-scenario state for the future Phase 2 views (Weekly Outlook, Resource Planning, Hospital Planning,
 * Intervention Explorer, Dispatch Brief).
 *
 * Three layers are kept apart:
 *   1. CONTROL STATE (this file): what the user typed, kept as text so an empty or half-typed field is a draft,
 *      never a silently corrected number.
 *   2. QUERY PARAMETERS (queries.ts): built only from valid state, per endpoint, omitting what was not changed.
 *   3. BACKEND RESULTS: read-only, fetched later by feature views. Nothing here makes a request or computes a plan.
 *
 * Limits and defaults mirror backend/app/planning/parameters.py and the FastAPI Query() bounds in backend/app/main.py.
 * All planning parameters are integers on the backend; decimals are rejected, not rounded.
 */

// ---------------------------------------------------------------- verified backend contract
export type NumericField = "stockPct" | "stockPctSaline" | "stockPctKits" | "minCoveragePct" | "totalCrews" | "capacityPct";

export interface NumericSpec {
  min: number;
  max: number;
  /** Backend default. null = optional override that inherits another value when absent. */
  default: number | null;
}

export const NUMERIC_SPECS: Readonly<Record<NumericField, NumericSpec>> = {
  stockPct: { min: 30, max: 100, default: 100 }, // STOCK_PCT_MIN/MAX/DEFAULT
  stockPctSaline: { min: 30, max: 100, default: null }, // None -> inherits stock_pct (scenario.py build_plan)
  stockPctKits: { min: 30, max: 100, default: null }, // None -> inherits stock_pct
  minCoveragePct: { min: 0, max: 50, default: 30 }, // MIN_COVERAGE_PCT_MIN/MAX/DEFAULT
  totalCrews: { min: 0, max: 10_000, default: 60 }, // ge=0, TOTAL_CREWS_MAX, TOTAL_CREWS_DEFAULT
  capacityPct: { min: 25, max: 200, default: 100 }, // CAPACITY_PCT_MIN/MAX/DEFAULT
};

export const NUMERIC_FIELDS = Object.keys(NUMERIC_SPECS) as NumericField[];
export const OVERRIDE_FIELDS: readonly NumericField[] = ["stockPctSaline", "stockPctKits"];

export const DEFAULT_INTERVENTION_SCENARIO: InterventionScenario = "base"; // dispatch-brief default
export const DEFAULT_INCLUDE_ROI_ALTERNATIVE = false; // intervention-simulation default

// ---------------------------------------------------------------- state
export interface ScenarioState {
  /**
   * Planning issue week ("YYYY-MM-DD", a Monday) or null. null means "not chosen": the backend then uses the last
   * valid issue week. It is never changed automatically by this module.
   */
  issueDate: string | null;
  /** Exactly what is in each numeric box. "" in an override box means "same as the general stock". */
  text: Readonly<Record<NumericField, string>>;
  includeRoiAlternative: boolean;
  interventionScenario: InterventionScenario;
}

export type FieldErrorCode = "required" | "notNumber" | "notWhole" | "outOfRange";
export type IssueDateErrorCode = "invalidDate" | "notMonday" | "unavailable";

export interface IssueWeeks {
  first: string;
  last: string;
}

function defaultText(field: NumericField): string {
  const d = NUMERIC_SPECS[field].default;
  return d === null ? "" : String(d);
}

export function createScenario(init: { issueDate?: string | null } = {}): ScenarioState {
  return {
    issueDate: init.issueDate ?? null,
    text: Object.fromEntries(NUMERIC_FIELDS.map((f) => [f, defaultText(f)])) as Record<NumericField, string>,
    includeRoiAlternative: DEFAULT_INCLUDE_ROI_ALTERNATIVE,
    interventionScenario: DEFAULT_INTERVENTION_SCENARIO,
  };
}

// ---------------------------------------------------------------- parsing (pure, no clamping, no rounding)
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Bangla digits typed by the user are read as the same digits; the value never changes. */
function asciiDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

export type Parsed = { ok: true; value: number | null } | { ok: false; error: FieldErrorCode };

/**
 * Reads one numeric box. Accepts plain decimal notation only ("1e3", "0x10", "Infinity" are not numbers here).
 * Empty: null for an override (inherit), "required" otherwise. Decimals and out-of-range values are errors:
 * the user's text is kept as typed and is never clamped or rounded.
 */
export function parseField(field: NumericField, raw: string): Parsed {
  const s = asciiDigits(raw).trim();
  const spec = NUMERIC_SPECS[field];
  if (s === "") return spec.default === null ? { ok: true, value: null } : { ok: false, error: "required" };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, error: "notNumber" };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: "notNumber" };
  if (!Number.isInteger(n)) return { ok: false, error: "notWhole" };
  if (n < spec.min || n > spec.max) return { ok: false, error: "outOfRange" };
  return { ok: true, value: n === 0 ? 0 : n }; // never -0
}

export function issueDateError(date: string, weeks: IssueWeeks): IssueDateErrorCode | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return "invalidDate";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return "invalidDate";
  if (back.getUTCDay() !== 1) return "notMonday";
  if (date < weeks.first || date > weeks.last) return "unavailable"; // ISO dates compare as strings
  return null;
}

/** Valid values for every field that parses; fields with errors are reported, never guessed. */
export interface ScenarioValues {
  values: Partial<Record<NumericField, number | null>>;
  errors: Partial<Record<NumericField, FieldErrorCode>>;
}

export function readScenario(state: ScenarioState): ScenarioValues {
  const values: ScenarioValues["values"] = {};
  const errors: ScenarioValues["errors"] = {};
  for (const f of NUMERIC_FIELDS) {
    const p = parseField(f, state.text[f]);
    if (p.ok) values[f] = p.value;
    else errors[f] = p.error;
  }
  return { values, errors };
}

/** True when the field's current text means the backend default (an override box: empty = inherit). */
export function isDefault(state: ScenarioState, field: NumericField): boolean {
  const p = parseField(field, state.text[field]);
  return p.ok && p.value === NUMERIC_SPECS[field].default;
}

// ---------------------------------------------------------------- updates (pure reducer)
export type ScenarioAction =
  | { type: "setText"; field: NumericField; text: string }
  | { type: "normalize"; field: NumericField }
  | { type: "setIssueDate"; issueDate: string | null }
  | { type: "setIncludeRoiAlternative"; value: boolean }
  | { type: "setInterventionScenario"; value: InterventionScenario }
  | { type: "resetField"; field: NumericField | "includeRoiAlternative" | "interventionScenario" }
  | { type: "resetAssumptions" };

function withText(state: ScenarioState, field: NumericField, text: string): ScenarioState {
  if (state.text[field] === text) return state; // unchanged: same object, no re-render
  return { ...state, text: { ...state.text, [field]: text } };
}

export function scenarioReducer(state: ScenarioState, action: ScenarioAction): ScenarioState {
  switch (action.type) {
    case "setText":
      return withText(state, action.field, action.text);
    case "normalize": {
      // Only tidies a VALID entry (" 050 " -> "50", Bangla digits -> the same digits); invalid text stays as typed.
      const p = parseField(action.field, state.text[action.field]);
      if (!p.ok) return state;
      return withText(state, action.field, p.value === null ? "" : String(p.value));
    }
    case "setIssueDate":
      return state.issueDate === action.issueDate ? state : { ...state, issueDate: action.issueDate };
    case "setIncludeRoiAlternative":
      return state.includeRoiAlternative === action.value ? state : { ...state, includeRoiAlternative: action.value };
    case "setInterventionScenario":
      if (!INTERVENTION_SCENARIOS.includes(action.value)) return state;
      return state.interventionScenario === action.value ? state : { ...state, interventionScenario: action.value };
    case "resetField":
      if (action.field === "includeRoiAlternative")
        return scenarioReducer(state, { type: "setIncludeRoiAlternative", value: DEFAULT_INCLUDE_ROI_ALTERNATIVE });
      if (action.field === "interventionScenario")
        return scenarioReducer(state, { type: "setInterventionScenario", value: DEFAULT_INTERVENTION_SCENARIO });
      return withText(state, action.field, defaultText(action.field));
    case "resetAssumptions": {
      // Every planning assumption back to its backend default. The issue week is context, not an assumption: kept.
      const fresh = createScenario({ issueDate: state.issueDate });
      const same =
        NUMERIC_FIELDS.every((f) => state.text[f] === fresh.text[f]) &&
        state.includeRoiAlternative === fresh.includeRoiAlternative &&
        state.interventionScenario === fresh.interventionScenario;
      return same ? state : fresh;
    }
  }
}

// ---------------------------------------------------------------- hook (local React state, no provider, no I/O)
export interface ScenarioApi {
  state: ScenarioState;
  setText: (field: NumericField, text: string) => void;
  normalize: (field: NumericField) => void;
  setIssueDate: (issueDate: string | null) => void;
  setIncludeRoiAlternative: (value: boolean) => void;
  setInterventionScenario: (value: InterventionScenario) => void;
  resetField: (field: NumericField | "includeRoiAlternative" | "interventionScenario") => void;
  resetAssumptions: () => void;
}

export function useScenario(init: { issueDate?: string | null } = {}): ScenarioApi {
  const [state, dispatch] = useReducer(scenarioReducer, init, createScenario);
  const actions = useMemo(
    () => ({
      setText: (field: NumericField, text: string) => dispatch({ type: "setText", field, text }),
      normalize: (field: NumericField) => dispatch({ type: "normalize", field }),
      setIssueDate: (issueDate: string | null) => dispatch({ type: "setIssueDate", issueDate }),
      setIncludeRoiAlternative: (value: boolean) => dispatch({ type: "setIncludeRoiAlternative", value }),
      setInterventionScenario: (value: InterventionScenario) => dispatch({ type: "setInterventionScenario", value }),
      resetField: (field: NumericField | "includeRoiAlternative" | "interventionScenario") => dispatch({ type: "resetField", field }),
      resetAssumptions: () => dispatch({ type: "resetAssumptions" }),
    }),
    [],
  );
  return { state, ...actions };
}
