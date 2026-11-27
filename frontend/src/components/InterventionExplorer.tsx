import type { InterventionQuery, InterventionResponse, InterventionScenario, Meta } from "../api/types";
import { INTERVENTION_SCENARIOS } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { buildInterventionQuery } from "../scenario/queries";
import type { Selection } from "./Controls";
import { InfoButton } from "./InfoButton";
import { ApplyRow, BackendNotes, BackendWarnings, PlanningHead } from "./PlanningParts";
import { ScenarioControls } from "./ScenarioControls";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";
import { usePlanning } from "./usePlanning";

/*
 * Intervention Explorer: the backend's GET /intervention-simulation. The endpoint returns all three ASSUMED effect
 * scenarios (low / base / high) at once, so there is no scenario selector here. "Projected cases avoided" is
 * scenario arithmetic on the forecast under an assumed effect size; it is not an observed or causal outcome.
 */

type Simulate = (query: InterventionQuery, signal: AbortSignal) => Promise<InterventionResponse>;

export function InterventionExplorer({ simulate, meta, selection, baseUrl }: { simulate: Simulate | null; meta: Meta; selection: Selection; baseUrl: string }) {
  const { t } = useI18n();
  const iv = t.intervention;
  const p = usePlanning<InterventionQuery, InterventionResponse>({
    name: "intervention",
    date: selection.date,
    weeks: meta.valid_issue_weeks,
    initialExtra: null,
    build: (s, _x, w) => buildInterventionQuery(s, w),
    run: simulate,
  });
  return (
    <section className="planning" aria-labelledby="intervention-title" aria-busy={p.req.status === "loading"}>
      <PlanningHead id="intervention-title" title={iv.title} date={selection.date} lead={iv.lead} hypothetical={iv.hypothetical} meta={meta} />
      <ScenarioControls scenario={p.scenario} groups={["crews", "intervention"]} />
      <p className="weekly-note">{iv.selectorNote}</p>
      <ApplyRow
        label={t.planning.apply}
        infoLabel={iv.applyInfoLabel}
        infoBody={iv.applyInfoBody}
        onApply={p.apply}
        disabled={!simulate || !selection.date}
        draftChanged={p.draftChanged}
        blocked={p.blocked}
      />
      {!simulate && <EmptyPanel title={t.planning.unavailableTitle} body={t.planning.unavailableBody} />}
      {simulate && !selection.date && <EmptyPanel title={t.planning.noWeekTitle} body={t.planning.noWeekBody} />}
      {p.req.status === "loading" && <LoadingPanel label={iv.loading} />}
      {p.req.status === "error" && p.req.error && <ErrorPanel error={p.req.error} baseUrl={baseUrl} onRetry={p.req.reload} />}
      {p.req.status === "success" && p.req.data && <InterventionResults data={p.req.data} />}
    </section>
  );
}

function InterventionResults({ data }: { data: InterventionResponse }) {
  const { t, int, num, date, city: cityName } = useI18n();
  const iv = t.intervention;
  const name: Record<InterventionScenario, string> = { low: t.scenario.effectLow, base: t.scenario.effectBase, high: t.scenario.effectHigh };
  const S = INTERVENTION_SCENARIOS;
  const pct = (m: number) => `${num(m * 100)}%`;
  const opt = (v: number | null) => (v === null ? iv.none : num(v));
  const rows: { label: string; cell: (s: InterventionScenario) => string; strong?: boolean }[] = [
    { label: iv.rowMax, cell: (s) => pct(data.parameters.scenarios[s]) },
    { label: iv.rowBaseline, cell: (s) => num(data.scenarios[s].region.baseline_cases_3wk) },
    { label: iv.rowAdjusted, cell: (s) => num(data.scenarios[s].region.scenario_adjusted_cases_3wk) },
    { label: iv.rowAvoided, cell: (s) => num(data.scenarios[s].region.projected_cases_avoided), strong: true },
    { label: iv.rowPerCrew, cell: (s) => opt(data.scenarios[s].region.projected_cases_avoided_per_assigned_crew) },
    { label: iv.rowSaline, cell: (s) => int(data.scenarios[s].region.saline.projected_units_avoided) },
    { label: iv.rowKits, cell: (s) => int(data.scenarios[s].region.kits.projected_units_avoided) },
  ];
  if (data.wards.length === 0) return <EmptyPanel title={iv.emptyTitle} body={iv.emptyBody} />;
  return (
    <div className="planning-results">
      <p className="planning-applied" data-testid="applied-parameters">
        {iv.appliedLine(date(data.issue_date), int(data.parameters.total_crews), int(data.parameters.min_coverage_pct), data.parameters.include_roi_alternative ? iv.roiOn : iv.roiOff)}
      </p>
      <p className="weekly-note">{iv.crewsLine(int(data.crews.assigned), int(data.crews.total_crews), int(data.crews.scenario_demand), int(data.crews.unassigned))}</p>
      <BackendWarnings warnings={data.warnings} />

      <section className="planning-block" aria-labelledby="intervention-compare-title">
        <div className="planning-block-head">
          <h3 id="intervention-compare-title">{iv.compareTitle}</h3>
          <InfoButton label={iv.effectInfoLabel} title={iv.compareTitle} description={iv.effectInfoBody} />
        </div>
        <div className="planning-table-wrap" role="region" aria-labelledby="intervention-compare-title" tabIndex={0}>
          <table className="planning-table planning-compare">
            <caption className="sr-only">{iv.compareCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{iv.thMeasure}</th>
                {S.map((s) => (
                  <th key={s} scope="col" className="num">{name[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className={r.strong ? "is-key" : undefined}>
                  <th scope="row">{r.label}</th>
                  {S.map((s) => (
                    <td key={s} className="num">{r.cell(s)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="planning-block" aria-labelledby="intervention-cities-title">
        <h3 id="intervention-cities-title">{iv.citiesTitle}</h3>
        <ul className="planning-cities">
          {data.scenarios.base.cities.map((c) => (
            <li key={c.city} className="planning-city" data-city={c.city}>
              <h4>{cityName(c.city)}</h4>
              <p className="planning-city-meta">{iv.cityCrews(int(c.assigned_crews))}</p>
              <dl className="planning-dl">
                {S.map((s) => {
                  const row = data.scenarios[s].cities.find((x) => x.city === c.city);
                  return (
                    <div key={s}>
                      <dt>{iv.avoidedIn(name[s])}</dt>
                      <dd>{row ? num(row.projected_cases_avoided) : iv.none}</dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
      </section>

      {data.roi_alternative && (
        <section className="planning-block" aria-labelledby="intervention-roi-title">
          <div className="planning-block-head">
            <h3 id="intervention-roi-title">{iv.roiTitle}</h3>
            <InfoButton label={iv.roiInfoLabel} title={iv.roiTitle} description={iv.roiInfoBody} />
          </div>
          <ul className="planning-cities">
            {S.map((s) => {
              const c = data.roi_alternative!.comparison[s].region;
              return (
                <li key={s} className="planning-city" data-roi={s}>
                  <h4>{name[s]}</h4>
                  <dl className="planning-dl">
                    <div><dt>{iv.roiPrimary}</dt><dd>{num(c.primary_projected_cases_avoided)}</dd></div>
                    <div><dt>{iv.roiAlternative}</dt><dd>{num(c.alternative_projected_cases_avoided)}</dd></div>
                    <div><dt>{iv.roiDifference}</dt><dd>{num(c.difference)}</dd></div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <BackendNotes policy={`${data.policy.description} ${data.policy.timing}`} assumptions={data.assumptions} limitations={data.limitations}>
        <p>{data.parameters.roi_definition}</p>
      </BackendNotes>
    </div>
  );
}
