import { useState } from "react";
import { useRequest, type RequestState } from "../lib/useRequest";
import type { QueryResult } from "../scenario/queries";
import { useScenario, type IssueWeeks, type ScenarioApi, type ScenarioState } from "../scenario/scenario";

/*
 * Draft / applied / request lifecycle shared by the planning views (the same policy Resource Planning uses):
 *  - One request on mounting, with backend defaults and the dashboard's selected issue week.
 *  - Edits change only the DRAFT. "Apply" validates the draft with the view's pure query builder and, if valid,
 *    makes it the APPLIED scenario; an invalid draft is reported and nothing is requested.
 *  - The issue week (and any other value the caller derives from the dashboard selection) always follows the
 *    selection: a new week re-requests with the APPLIED assumptions.
 *  - useRequest aborts superseded requests, ignores late answers and aborts on unmount.
 * No planning maths here; every figure shown comes from the backend response.
 */

export interface Planning<Q, R, X> {
  scenario: ScenarioApi;
  draftExtra: X;
  setDraftExtra: (x: X) => void;
  appliedState: ScenarioState;
  appliedExtra: X;
  appliedQuery: QueryResult<Q>;
  draftQuery: QueryResult<Q>;
  draftChanged: boolean;
  blocked: boolean;
  apply: () => void;
  req: RequestState<R>;
}

export function usePlanning<Q extends object, R, X = null>(opts: {
  name: string;
  date: string;
  weeks: IssueWeeks;
  initialExtra: X;
  build: (state: ScenarioState, extra: X, weeks: IssueWeeks) => QueryResult<Q>;
  run: ((query: Q, signal: AbortSignal) => Promise<R>) | null;
}): Planning<Q, R, X> {
  const { name, date, weeks, build, run } = opts;
  const scenario = useScenario({ issueDate: date || null });
  // The dashboard's week is authoritative (render-phase sync, no effect).
  if (date && scenario.state.issueDate !== date) scenario.setIssueDate(date);
  const [draftExtra, setDraftExtra] = useState<X>(opts.initialExtra);
  const [applied, setApplied] = useState(() => ({ state: scenario.state, extra: opts.initialExtra, count: 0 }));
  const [blocked, setBlocked] = useState(false);

  const withWeek = (s: ScenarioState): ScenarioState => ({ ...s, issueDate: date || null });
  const appliedQuery = build(withWeek(applied.state), applied.extra, weeks);
  const draftQuery = build(withWeek(scenario.state), draftExtra, weeks);
  const key = run && date && appliedQuery.ok ? `${name}:${JSON.stringify(appliedQuery.query)}#${applied.count}` : null;
  const req = useRequest<R>(key, (signal) =>
    run && appliedQuery.ok ? run(appliedQuery.query, signal) : Promise.reject(new Error("unreachable")),
  );
  const draftChanged =
    !draftQuery.ok || JSON.stringify(draftQuery.query) !== (appliedQuery.ok ? JSON.stringify(appliedQuery.query) : "");

  const apply = () => {
    if (!draftQuery.ok) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setApplied((prev) => ({ state: scenario.state, extra: draftExtra, count: prev.count + 1 }));
  };

  return {
    scenario,
    draftExtra,
    setDraftExtra,
    appliedState: applied.state,
    appliedExtra: applied.extra,
    appliedQuery,
    draftQuery,
    draftChanged,
    blocked: blocked && !draftQuery.ok,
    apply,
    req,
  };
}
