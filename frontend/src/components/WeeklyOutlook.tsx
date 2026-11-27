import type { ApiClient } from "../api/client";
import type { Meta, WardForecastResponse, WeeklyForecast } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { useRequest } from "../lib/useRequest";
import type { Selection } from "./Controls";
import { InfoButton } from "./InfoButton";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";

/*
 * Weekly Outlook: the selected ward's combined weeks +2..+4 forecast, shown week by week, from the backend's
 * include_weekly=true block. The selection (city, ward, issue week) is the dashboard's own; this view never keeps a
 * second copy. Values are the backend's: nothing is forecast, recomputed or smoothed here.
 */

interface Props {
  client: ApiClient;
  meta: Meta;
  selection: Selection;
}

export function WeeklyOutlook({ client, meta, selection }: Props) {
  const { t, lang, ward: wardName, city: cityName, date } = useI18n();
  const w = t.weekly;
  const ready = selection.ward !== "" && selection.date !== "";
  // Own request, keyed by ward + week: a new selection aborts the old request and never shows its data.
  const req = useRequest<WardForecastResponse>(ready ? `weekly:${selection.ward}:${selection.date}` : null, (signal) =>
    client.forecastWard(selection.ward, selection.date, false, signal, { includeWeekly: true }),
  );

  return (
    <section className="weekly" aria-labelledby="weekly-title" aria-busy={req.status === "loading"}>
      <div className="section-head">
        <h2 id="weekly-title">{ready ? w.title(wardName(selection.ward)) : w.titleNoWard}</h2>
        {ready && <p>{w.where(cityName(selection.city), date(selection.date))}</p>}
        <p>{w.lead}</p>
      </div>
      <p className="weekly-replay">
        <strong>{t.notLive}</strong> {lang === "bn" ? t.notice : meta.notice} {w.replay}
      </p>

      {!ready && <EmptyPanel title={selection.ward === "" ? w.noWardTitle : w.noWeekTitle} body={selection.ward === "" ? w.noWardBody : w.noWeekBody} />}
      {ready && req.status === "loading" && <LoadingPanel label={w.loading} />}
      {ready && req.status === "error" && req.error && <ErrorPanel error={req.error} baseUrl={client.baseUrl} onRetry={req.reload} />}
      {ready && req.status === "success" && req.data && (
        req.data.forecast.weekly ? (
          <WeeklyBody total={req.data.forecast.predicted_cases_3wk} weekly={req.data.forecast.weekly} />
        ) : (
          <EmptyPanel title={w.missingTitle} body={w.missingBody} />
        )
      )}
    </section>
  );
}

const tenths = (x: number) => Math.round(x * 10);

function WeeklyBody({ total, weekly }: { total: number; weekly: WeeklyForecast }) {
  const { t, num, int, date } = useI18n();
  const w = t.weekly;
  const max = Math.max(...weekly.weeks.map((x) => x.predicted_cases));
  // Values are shown to one decimal; say so when the shown weeks do not add up to the shown total.
  const roundingGap = weekly.weeks.reduce((s, x) => s + tenths(x.predicted_cases), 0) !== tenths(total);
  const reason =
    weekly.fallback_reason === null
      ? null
      : weekly.fallback_reason === "companion_not_loaded"
        ? w.reasonNotLoaded
        : weekly.fallback_reason === "companion_unavailable"
          ? w.reasonUnavailable
          : weekly.fallback_reason === "companion_inference_failed"
            ? w.reasonFailed
            : w.reasonOther;

  return (
    <>
      <div className="weekly-total">
        <p className="weekly-total-label">{w.totalLabel}</p>
        <p className="weekly-total-num">
          {num(total)} <span className="weekly-unit">{w.casesUnit}</span>
        </p>
      </div>

      <ol className="weekly-weeks" aria-label={w.listLabel}>
        {weekly.weeks.map((x) => (
          <li key={x.horizon_week} className="weekly-week">
            <p className="weekly-week-label">{w.weekLabel(int(x.horizon_week))}</p>
            <p className="weekly-week-date">{w.weekOf(date(x.forecast_week))}</p>
            <p className="weekly-week-num">
              {num(x.predicted_cases)} <span className="weekly-unit">{w.casesUnit}</span>
            </p>
            <span className="weekly-bar" aria-hidden="true">
              <span className="weekly-bar-fill" style={{ width: `${max > 0 ? (x.predicted_cases / max) * 100 : 0}%` }} />
            </span>
          </li>
        ))}
      </ol>
      {roundingGap && <p className="weekly-note">{w.roundingNote}</p>}

      <div className={`weekly-source weekly-source-${weekly.source}`}>
        <div className="weekly-source-head">
          <h3>{w.sourceTitle}</h3>
          <InfoButton label={w.sourceInfoLabel} title={w.sourceTitle} description={w.sourceInfoBody} />
        </div>
        <p className="weekly-source-kind">{weekly.source === "companion" ? w.sourceCompanion : w.sourceEqual}</p>
        <p>{weekly.source === "companion" ? w.companionBody : w.equalBody}</p>
        {weekly.source === "equal_split" && reason && <p className="weekly-note">{w.reasonLabel} {reason}</p>}
      </div>
    </>
  );
}
