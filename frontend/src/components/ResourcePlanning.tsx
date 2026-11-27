import { useState } from "react";
import type { AllocationQuery, AllocationResponse, AllocationSeverity, AllocationWard, Meta, ResourceSummary } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { useRequest } from "../lib/useRequest";
import { buildAllocationQuery } from "../scenario/queries";
import { useScenario, type ScenarioState } from "../scenario/scenario";
import type { Selection } from "./Controls";
import { InfoButton } from "./InfoButton";
import { ScenarioControls } from "./ScenarioControls";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";
import { TierChip } from "./TierChip";

/*
 * Resource Planning: shows the backend's GET /allocation plan for the selected issue week under hypothetical stock and
 * crew assumptions. Nothing is allocated, ranked or totalled here: every figure is the backend's.
 *
 * Request policy (deterministic):
 *  - On opening, one request with the default assumptions and the selected issue week.
 *  - Editing a box changes only the DRAFT; nothing is requested until "Apply scenario".
 *  - "Apply scenario" validates the draft (buildAllocationQuery) and, if valid, makes the draft the APPLIED scenario.
 *  - The issue week always follows the dashboard's selection: a new week re-requests with the APPLIED assumptions.
 *  - Results are labelled with the parameters the backend echoes back, never with the draft.
 */

type Allocate = (query: AllocationQuery, signal: AbortSignal) => Promise<AllocationResponse>;

interface Props {
  allocate: Allocate | null;
  meta: Meta;
  selection: Selection;
  baseUrl: string;
}

export function ResourcePlanning({ allocate, meta, selection, baseUrl }: Props) {
  const { t, lang, date } = useI18n();
  const r = t.resources;
  const weeks = meta.valid_issue_weeks;
  const scenario = useScenario({ issueDate: selection.date || null });
  // The dashboard's week is authoritative: keep the scenario's planning week in step (render-phase sync, no effect).
  if (selection.date && scenario.state.issueDate !== selection.date) scenario.setIssueDate(selection.date);

  // The applied assumptions start as the defaults; applyCount makes a repeated Apply a fresh request.
  const [applied, setApplied] = useState<{ state: ScenarioState; count: number }>(() => ({ state: scenario.state, count: 0 }));
  const [blocked, setBlocked] = useState(false);

  const withWeek = (s: ScenarioState): ScenarioState => ({ ...s, issueDate: selection.date || null });
  const appliedQuery = buildAllocationQuery(withWeek(applied.state), weeks);
  const draftQuery = buildAllocationQuery(withWeek(scenario.state), weeks);
  const key = allocate && selection.date && appliedQuery.ok ? `alloc:${JSON.stringify(appliedQuery.query)}#${applied.count}` : null;
  const req = useRequest<AllocationResponse>(key, (signal) =>
    allocate && appliedQuery.ok ? allocate(appliedQuery.query, signal) : Promise.reject(new Error("unreachable")),
  );
  const draftChanged = !draftQuery.ok || JSON.stringify(draftQuery.query) !== (appliedQuery.ok ? JSON.stringify(appliedQuery.query) : "");

  const apply = () => {
    if (!draftQuery.ok) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setApplied((prev) => ({ state: scenario.state, count: prev.count + 1 }));
  };

  return (
    <section className="planning" aria-labelledby="resources-title" aria-busy={req.status === "loading"}>
      <div className="section-head">
        <h2 id="resources-title">{r.title}</h2>
        <p>{selection.date ? r.where(date(selection.date)) : r.noWeekBody}</p>
        <p>{r.lead}</p>
      </div>
      <p className="weekly-replay">
        <strong>{t.notLive}</strong> {lang === "bn" ? t.notice : meta.notice} {r.hypothetical}
      </p>

      <ScenarioControls scenario={scenario} groups={["supplies", "crews"]} />

      <div className="planning-apply">
        <div className="action-with-info">
          <button type="button" className="btn" onClick={apply} disabled={!allocate || !selection.date}>
            {r.apply}
          </button>
          <InfoButton label={r.applyInfoLabel} title={r.apply} description={r.applyInfoBody} />
        </div>
        <p className="planning-draft" role="status" aria-live="polite">
          {blocked && !draftQuery.ok ? r.blocked : draftChanged ? r.draftChanged : ""}
        </p>
      </div>

      {!allocate && <EmptyPanel title={r.unavailableTitle} body={r.unavailableBody} />}
      {allocate && !selection.date && <EmptyPanel title={r.noWeekTitle} body={r.noWeekBody} />}
      {allocate && selection.date && !appliedQuery.ok && <EmptyPanel title={r.invalidAppliedTitle} body={r.invalidAppliedBody} />}
      {req.status === "loading" && <LoadingPanel label={r.loading} />}
      {req.status === "error" && req.error && <ErrorPanel error={req.error} baseUrl={baseUrl} onRetry={req.reload} />}
      {req.status === "success" && req.data && <AllocationResults data={req.data} />}
    </section>
  );
}

// ---------------------------------------------------------------- results (presentation only)
function AllocationResults({ data }: { data: AllocationResponse }) {
  const { t, int, date, city: cityName } = useI18n();
  const r = t.resources;
  const p = data.parameters;
  if (data.wards.length === 0 || data.cities.length === 0) return <EmptyPanel title={r.emptyTitle} body={r.emptyBody} />;
  return (
    <div className="planning-results">
      <p className="planning-applied" data-testid="applied-parameters">
        {r.appliedLine(date(data.issue_date), int(p.stock_pct.saline), int(p.stock_pct.kits), int(p.min_coverage_pct), int(p.total_crews))}
      </p>

      <section className="planning-block" aria-labelledby="region-title">
        <div className="planning-block-head">
          <h3 id="region-title">{r.regionTitle}</h3>
          <InfoButton label={r.unitsInfoLabel} title={r.unitsTitle} description={r.unitsInfoBody} />
        </div>
        <div className="planning-cards">
          <ResourceCard title={r.saline} unit={r.salineUnit} s={data.region.saline} />
          <ResourceCard title={r.kits} unit={r.kitsUnit} s={data.region.kits} />
          <CrewCard
            demand={data.region.crews.scenario_demand}
            pool={data.region.crews.total_crews}
            assigned={data.region.crews.assigned}
            deficit={data.region.crews.scenario_deficit}
            coverage={data.region.crews.coverage_pct}
          />
        </div>
        <p className="weekly-note">{r.bedsLine(int(data.region.beds.planning_demand))}</p>
      </section>

      <section className="planning-block" aria-labelledby="cities-title">
        <h3 id="cities-title">{r.citiesTitle}</h3>
        <ul className="planning-cities">
          {data.cities.map((c) => (
            <li key={c.city} className="planning-city">
              <h4>{cityName(c.city)}</h4>
              <p className="planning-city-meta">{r.wardCount(int(c.ward_count))}</p>
              <dl className="planning-dl">
                <CityRow label={r.saline} allocated={c.saline.allocated} demand={c.saline.demand} deficit={c.saline.deficit} />
                <CityRow label={r.kits} allocated={c.kits.allocated} demand={c.kits.demand} deficit={c.kits.deficit} />
                <CityRow label={r.crews} allocated={c.crews.assigned} demand={c.crews.scenario_demand} deficit={c.crews.scenario_deficit} />
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <WardTable wards={data.wards} />

      <details className="tech planning-details">
        <summary>{r.detailsSummary}</summary>
        <div lang="en">
          <p>{data.policy.description}</p>
          <h4>{r.assumptionsTitle}</h4>
          <ul className="planning-list">
            {data.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <h4>{r.limitationsTitle}</h4>
          <ul className="planning-list">
            {data.limitations.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <p className="weekly-note">{r.detailsLanguage}</p>
      </details>
    </div>
  );
}

function Pct({ value }: { value: number | null }) {
  const { t, num } = useI18n();
  return <>{value === null ? t.resources.noDemand : `${num(value)}%`}</>;
}

function ResourceCard({ title, unit, s }: { title: string; unit: string; s: ResourceSummary }) {
  const { t, int } = useI18n();
  const r = t.resources;
  return (
    <div className="planning-card">
      <h4>{title}</h4>
      <p className="planning-unit">{unit}</p>
      <dl className="planning-dl">
        <div><dt>{r.demand}</dt><dd>{int(s.demand)}</dd></div>
        <div><dt>{r.stock}</dt><dd>{int(s.stock)}</dd></div>
        <div><dt>{r.allocated}</dt><dd>{int(s.allocated)}</dd></div>
        <div className={s.deficit > 0 ? "is-short" : undefined}><dt>{r.deficit}</dt><dd>{int(s.deficit)}</dd></div>
        <div><dt>{r.coverage}</dt><dd><Pct value={s.coverage_pct} /></dd></div>
      </dl>
      <p className="planning-card-note">{r.wardsShort(int(s.wards_with_deficit), int(s.wards_below_floor))}</p>
    </div>
  );
}

function CrewCard(c: { demand: number; pool: number; assigned: number; deficit: number; coverage: number | null }) {
  const { t, int } = useI18n();
  const r = t.resources;
  return (
    <div className="planning-card">
      <h4>{r.crews}</h4>
      <p className="planning-unit">{r.crewsUnit}</p>
      <dl className="planning-dl">
        <div><dt>{r.crewDemand}</dt><dd>{int(c.demand)}</dd></div>
        <div><dt>{r.crewPool}</dt><dd>{int(c.pool)}</dd></div>
        <div><dt>{r.crewAssigned}</dt><dd>{int(c.assigned)}</dd></div>
        <div className={c.deficit > 0 ? "is-short" : undefined}><dt>{r.crewShort}</dt><dd>{int(c.deficit)}</dd></div>
        <div><dt>{r.coverage}</dt><dd><Pct value={c.coverage} /></dd></div>
      </dl>
    </div>
  );
}

function CityRow({ label, allocated, demand, deficit }: { label: string; allocated: number; demand: number; deficit: number }) {
  const { t, int } = useI18n();
  return (
    <div className={deficit > 0 ? "is-short" : undefined}>
      <dt>{label}</dt>
      <dd>{t.resources.ofDemand(int(allocated), int(demand), int(deficit))}</dd>
    </div>
  );
}

/** Worst of the three severities, for one plain label per ward (presentation only; the backend's codes are kept). */
function worst(w: AllocationWard): AllocationSeverity {
  const all = [w.saline.severity, w.kits.severity, w.crews.severity];
  return all.includes("below_floor") ? "below_floor" : all.includes("partial") ? "partial" : "no_deficit";
}

function WardTable({ wards }: { wards: AllocationWard[] }) {
  const { t, int, ward: wardName, city: cityName } = useI18n();
  const r = t.resources;
  return (
    <section className="planning-block" aria-labelledby="wards-title">
      <div className="planning-block-head">
        <h3 id="wards-title">{r.wardsTitle}</h3>
        <InfoButton label={r.priorityInfoLabel} title={r.priorityTitle} description={r.priorityInfoBody} />
      </div>
      <p className="weekly-note">{r.wardsOrder}</p>
      <div className="planning-table-wrap" role="region" aria-labelledby="wards-title" tabIndex={0}>
        <table className="planning-table">
          <caption className="sr-only">{r.wardsCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{r.thWard}</th>
              <th scope="col" className="num">{r.thRank}</th>
              <th scope="col">{r.thTier}</th>
              <th scope="col" className="num">{r.saline}</th>
              <th scope="col" className="num">{r.kits}</th>
              <th scope="col" className="num">{r.crews}</th>
              <th scope="col">{r.thStatus}</th>
            </tr>
          </thead>
          <tbody>
            {wards.map((w) => {
              const sev = worst(w);
              return (
                <tr key={w.ward_id} data-ward={w.ward_id}>
                  <th scope="row">
                    {wardName(w.ward_id)}
                    <span className="row-city">{cityName(w.city)}</span>
                  </th>
                  <td className="num">{int(w.priority_rank_in_city)}</td>
                  <td>
                    <TierChip tier={w.priority.risk_tier} />
                    {w.priority.early_alert && <span className="row-alert">{t.rowAlert}</span>}
                  </td>
                  <td className="num">{r.cell(int(w.saline.allocated), int(w.saline.demand))}</td>
                  <td className="num">{r.cell(int(w.kits.allocated), int(w.kits.demand))}</td>
                  <td className="num">{r.cell(int(w.crews.assigned), int(w.crews.scenario_demand))}</td>
                  <td>
                    <span className={`planning-status planning-status-${sev}`}>{sev === "below_floor" ? r.statusBelow : sev === "partial" ? r.statusShort : r.statusMet}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
