import type {
  AllocationQuery,
  DispatchAudience,
  DispatchQuery,
  DispatchScope,
  DispatchVariant,
  HospitalRoutingQuery,
  InterventionQuery,
} from "../api/types";
import {
  DEFAULT_INTERVENTION_SCENARIO,
  issueDateError,
  NUMERIC_SPECS,
  parseField,
  type FieldErrorCode,
  type IssueDateErrorCode,
  type IssueWeeks,
  type NumericField,
  type ScenarioState,
} from "./scenario";

/*
 * Pure mapping from VALID scenario state to the committed F1B query types. No requests, no planning maths.
 *
 * Omission rule: a parameter is sent only when the user's value differs from the backend default (or, for an override,
 * when one was entered). The backend default then applies unchanged, and explicit zeros are always sent because no
 * check here relies on truthiness. Invalid input for any field the endpoint uses rejects the whole query.
 */

export type QueryField = NumericField | "issueDate" | "scope" | "city" | "wardId";
export type QueryErrorCode = FieldErrorCode | IssueDateErrorCode | "missingCity" | "missingWard" | "invalidWard" | "invalidCity";

export type QueryResult<Q> = { ok: true; query: Q } | { ok: false; errors: Partial<Record<QueryField, QueryErrorCode>> };

interface Collector {
  errors: Partial<Record<QueryField, QueryErrorCode>>;
}

/** The parsed value, or undefined when it equals the backend default (so it is omitted). Errors are collected. */
function changed(state: ScenarioState, field: NumericField, c: Collector): number | undefined {
  const p = parseField(field, state.text[field]);
  if (!p.ok) {
    c.errors[field] = p.error;
    return undefined;
  }
  if (p.value === null) return undefined; // override left empty: inherit
  return p.value === NUMERIC_SPECS[field].default ? undefined : p.value;
}

function issue(state: ScenarioState, weeks: IssueWeeks, c: Collector): string | undefined {
  if (state.issueDate === null) return undefined; // backend: last valid issue week
  const e = issueDateError(state.issueDate, weeks);
  if (e) {
    c.errors.issueDate = e;
    return undefined;
  }
  return state.issueDate;
}

/** Drops undefined keys so the result is deterministic and minimal (the client also skips them). */
function compact<Q extends object>(q: Q): Q {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as Q;
}

function finish<Q extends object>(c: Collector, q: Q): QueryResult<Q> {
  return Object.keys(c.errors).length ? { ok: false, errors: c.errors } : { ok: true, query: compact(q) };
}

/** GET /allocation: stock, optional saline/kit overrides, minimum coverage, crews. */
export function buildAllocationQuery(state: ScenarioState, weeks: IssueWeeks): QueryResult<AllocationQuery> {
  const c: Collector = { errors: {} };
  return finish(c, {
    issue_date: issue(state, weeks, c),
    stock_pct: changed(state, "stockPct", c),
    stock_pct_saline: changed(state, "stockPctSaline", c),
    stock_pct_kits: changed(state, "stockPctKits", c),
    min_coverage_pct: changed(state, "minCoveragePct", c),
    total_crews: changed(state, "totalCrews", c),
  });
}

/** GET /hospital-routing: hypothetical capacity only. */
export function buildHospitalRoutingQuery(state: ScenarioState, weeks: IssueWeeks): QueryResult<HospitalRoutingQuery> {
  const c: Collector = { errors: {} };
  return finish(c, { issue_date: issue(state, weeks, c), capacity_pct: changed(state, "capacityPct", c) });
}

/** GET /intervention-simulation: crews, coverage floor, optional ROI alternative. All three scenarios come back. */
export function buildInterventionQuery(state: ScenarioState, weeks: IssueWeeks): QueryResult<InterventionQuery> {
  const c: Collector = { errors: {} };
  return finish(c, {
    issue_date: issue(state, weeks, c),
    total_crews: changed(state, "totalCrews", c),
    min_coverage_pct: changed(state, "minCoveragePct", c),
    include_roi_alternative: state.includeRoiAlternative ? true : undefined,
  });
}

/** Dispatch presentation and selection: deliberately NOT part of the shared scenario state. */
export interface DispatchOptions {
  scope: DispatchScope;
  city?: string;
  wardId?: string;
  audience?: DispatchAudience;
  variant?: DispatchVariant;
  download?: boolean;
}

const WARD_ID = /^[A-Za-z0-9_]{1,40}$/; // backend: max_length=40, pattern ^[A-Za-z0-9_]+$

/**
 * GET /dispatch-brief. Carries the shared scenario fields the endpoint accepts. The endpoint has NO saline/kit
 * overrides: if either is set, `notCarried` lists it so a view can say the brief uses the general stock instead.
 */
export function buildDispatchQuery(
  state: ScenarioState,
  weeks: IssueWeeks,
  options: DispatchOptions,
): QueryResult<DispatchQuery> & { notCarried: NumericField[] } {
  const c: Collector = { errors: {} };
  const city = options.city?.trim() || undefined;
  const wardId = options.wardId?.trim() || undefined;
  if (city !== undefined && city.length > 40) c.errors.city = "invalidCity";
  if (options.scope === "city" && city === undefined) c.errors.city = "missingCity";
  if (options.scope === "ward" && wardId === undefined) c.errors.wardId = "missingWard";
  if (wardId !== undefined && !WARD_ID.test(wardId)) c.errors.wardId = "invalidWard";
  const notCarried = (["stockPctSaline", "stockPctKits"] as const).filter((f) => {
    const p = parseField(f, state.text[f]);
    return !p.ok || p.value !== null;
  });
  const result = finish(c, {
    scope: options.scope,
    city,
    ward_id: wardId,
    issue_date: issue(state, weeks, c),
    audience: options.audience,
    variant: options.variant,
    stock_pct: changed(state, "stockPct", c),
    min_coverage_pct: changed(state, "minCoveragePct", c),
    total_crews: changed(state, "totalCrews", c),
    capacity_pct: changed(state, "capacityPct", c),
    intervention_scenario: state.interventionScenario === DEFAULT_INTERVENTION_SCENARIO ? undefined : state.interventionScenario,
    download: options.download ? true : undefined,
  } satisfies DispatchQuery);
  return { ...result, notCarried };
}
