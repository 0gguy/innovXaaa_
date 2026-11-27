import type { HospitalRoutingQuery, HospitalRoutingResponse, HospitalWeekSummary, Meta } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { buildHospitalRoutingQuery } from "../scenario/queries";
import type { Selection } from "./Controls";
import { InfoButton } from "./InfoButton";
import { ApplyRow, BackendNotes, BackendWarnings, PlanningHead } from "./PlanningParts";
import { ScenarioControls } from "./ScenarioControls";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";
import { usePlanning } from "./usePlanning";

/*
 * Hospital Planning: the backend's GET /hospital-routing result for the selected issue week under a hypothetical
 * bed capacity. Units are BED PLANNING UNITS derived from the forecast (not patients or real beds). Overflow is a
 * SIMULATED reassignment between wards of the same city; there are no hospital names, places or travel times.
 */

type Route = (query: HospitalRoutingQuery, signal: AbortSignal) => Promise<HospitalRoutingResponse>;
const MAX_TRANSFERS = 15;

export function HospitalPlanning({ route, meta, selection, baseUrl }: { route: Route | null; meta: Meta; selection: Selection; baseUrl: string }) {
  const { t } = useI18n();
  const h = t.hospital;
  const p = usePlanning<HospitalRoutingQuery, HospitalRoutingResponse>({
    name: "hospital",
    date: selection.date,
    weeks: meta.valid_issue_weeks,
    initialExtra: null,
    build: (s, _x, w) => buildHospitalRoutingQuery(s, w),
    run: route,
  });
  return (
    <section className="planning" aria-labelledby="hospital-title" aria-busy={p.req.status === "loading"}>
      <PlanningHead id="hospital-title" title={h.title} date={selection.date} lead={h.lead} hypothetical={h.hypothetical} meta={meta} />
      <ScenarioControls scenario={p.scenario} groups={["hospital"]} />
      <ApplyRow
        label={t.planning.apply}
        infoLabel={h.applyInfoLabel}
        infoBody={h.applyInfoBody}
        onApply={p.apply}
        disabled={!route || !selection.date}
        draftChanged={p.draftChanged}
        blocked={p.blocked}
      />
      {!route && <EmptyPanel title={t.planning.unavailableTitle} body={t.planning.unavailableBody} />}
      {route && !selection.date && <EmptyPanel title={t.planning.noWeekTitle} body={t.planning.noWeekBody} />}
      {p.req.status === "loading" && <LoadingPanel label={h.loading} />}
      {p.req.status === "error" && p.req.error && <ErrorPanel error={p.req.error} baseUrl={baseUrl} onRetry={p.req.reload} />}
      {p.req.status === "success" && p.req.data && <HospitalResults data={p.req.data} />}
    </section>
  );
}

function Pct({ value }: { value: number | null }) {
  const { t, num } = useI18n();
  return <>{value === null ? t.hospital.noCapacity : `${num(value)}%`}</>;
}

function HospitalResults({ data }: { data: HospitalRoutingResponse }) {
  const { t, int, date, city: cityName, ward: wardName } = useI18n();
  const h = t.hospital;
  if (data.weeks.length === 0 || data.capacity.cities.length === 0) return <EmptyPanel title={h.emptyTitle} body={h.emptyBody} />;
  const transfers = data.weeks.flatMap((w) => w.transfers);
  return (
    <div className="planning-results">
      <p className="planning-applied" data-testid="applied-parameters">
        {h.appliedLine(date(data.issue_date), int(data.parameters.capacity_pct), int(data.capacity.region_hypothetical_capacity))}
      </p>
      <BackendWarnings warnings={data.warnings} />

      <section className="planning-block" aria-labelledby="hospital-weeks-title">
        <div className="planning-block-head">
          <h3 id="hospital-weeks-title">{h.weeksTitle}</h3>
          <InfoButton label={h.unitsInfoLabel} title={h.unitsTitle} description={h.unitsInfoBody} />
        </div>
        <div className="planning-table-wrap" role="region" aria-labelledby="hospital-weeks-title" tabIndex={0}>
          <table className="planning-table">
            <caption className="sr-only">{h.weeksCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{h.thWeek}</th>
                <th scope="col" className="num">{h.thDemand}</th>
                <th scope="col" className="num">{h.thCapacity}</th>
                <th scope="col" className="num">{h.thLocal}</th>
                <th scope="col" className="num">{h.thMoved}</th>
                <th scope="col" className="num">{h.thUnmet}</th>
                <th scope="col" className="num">{h.thUse}</th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <WeekRow key={w.horizon_week} label={h.weekLabel(int(w.horizon_week), date(w.forecast_week))} s={w.region} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="planning-block" aria-labelledby="hospital-cities-title">
        <h3 id="hospital-cities-title">{h.citiesTitle}</h3>
        <p className="weekly-note">{h.citiesNote}</p>
        <ul className="planning-cities">
          {data.capacity.cities.map((c) => {
            const head = data.headline_week_by_city[c.city];
            const week = data.weeks.find((w) => w.horizon_week === head?.horizon_week);
            const s = week?.cities.find((x) => x.city === c.city);
            return (
              <li key={c.city} className="planning-city" data-city={c.city}>
                <h4>{cityName(c.city)}</h4>
                <p className="planning-city-meta">{h.capacityLine(int(c.hypothetical_capacity), int(c.baseline))}</p>
                {s && head ? (
                  <dl className="planning-dl">
                    <div><dt>{h.peakWeek}</dt><dd>{h.weekLabel(int(head.horizon_week), date(head.forecast_week))}</dd></div>
                    <div><dt>{h.thDemand}</dt><dd>{int(s.bed_planning_demand)}</dd></div>
                    <div><dt>{h.thMoved}</dt><dd>{int(s.transfer_units)}</dd></div>
                    <div className={s.unmet_after_routing > 0 ? "is-short" : undefined}><dt>{h.thUnmet}</dt><dd>{int(s.unmet_after_routing)}</dd></div>
                    <div><dt>{h.thUse}</dt><dd><Pct value={s.utilization_pct} /></dd></div>
                  </dl>
                ) : (
                  <p className="planning-card-note">{h.noCityWeek}</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="planning-block" aria-labelledby="hospital-moves-title">
        <div className="planning-block-head">
          <h3 id="hospital-moves-title">{h.movesTitle}</h3>
          <InfoButton label={h.movesInfoLabel} title={h.movesTitle} description={h.movesInfoBody} />
        </div>
        {transfers.length === 0 ? (
          <p className="weekly-note">{h.noMoves}</p>
        ) : (
          <>
            <ul className="planning-list planning-moves">
              {transfers.slice(0, MAX_TRANSFERS).map((m, i) => (
                <li key={`${m.horizon_week}-${m.from_ward}-${m.to_ward}-${i}`}>
                  {h.moveLine(int(m.units), wardName(m.from_ward), wardName(m.to_ward), cityName(m.city), int(m.horizon_week))}
                </li>
              ))}
            </ul>
            {transfers.length > MAX_TRANSFERS && <p className="weekly-note">{h.moreMoves(int(transfers.length - MAX_TRANSFERS))}</p>}
          </>
        )}
      </section>

      <BackendNotes policy={data.policy.description} assumptions={data.assumptions} limitations={data.limitations}>
        <p>{data.parameters.units}</p>
      </BackendNotes>
    </div>
  );
}

function WeekRow({ label, s }: { label: string; s: HospitalWeekSummary }) {
  const { int } = useI18n();
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{int(s.bed_planning_demand)}</td>
      <td className="num">{int(s.hypothetical_capacity)}</td>
      <td className="num">{int(s.locally_assigned)}</td>
      <td className="num">{int(s.transfer_units)}</td>
      <td className={`num${s.unmet_after_routing > 0 ? " is-short-cell" : ""}`}>{int(s.unmet_after_routing)}</td>
      <td className="num"><Pct value={s.utilization_pct} /></td>
    </tr>
  );
}
