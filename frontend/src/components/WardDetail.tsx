import type { Forecast, Meta, WardForecastResponse } from "../api/types";
import type { RequestState } from "../lib/useRequest";
import { addDays, formatDate, formatDayMonth } from "../lib/dates";
import { cases, wardLabel } from "../lib/format";
import { DriversChart } from "./DriversChart";
import { ErrorPanel, LoadingPanel } from "./StatusPanel";
import { TierChip } from "./TierChip";

interface Props {
  request: RequestState<WardForecastResponse>;
  meta: Meta;
  baseUrl: string;
}

export function WardDetail({ request, meta, baseUrl }: Props) {
  return (
    <section className="detail" aria-labelledby="detail-title" aria-busy={request.status === "loading"}>
      {request.status === "error" && request.error && (
        <>
          <h2 id="detail-title">Ward forecast</h2>
          <ErrorPanel error={request.error} baseUrl={baseUrl} onRetry={request.reload} />
        </>
      )}
      {(request.status === "loading" || request.status === "idle") && (
        <>
          <h2 id="detail-title">Ward forecast</h2>
          <LoadingPanel label="Loading this ward's forecast…" />
        </>
      )}
      {request.status === "success" && request.data && (
        <DetailBody forecast={request.data.forecast} meta={meta} />
      )}
    </section>
  );
}

function HorizonStrip({ forecast }: { forecast: Forecast }) {
  const t = forecast.issue_week;
  const cells = [
    { key: "t", label: "Issue week", date: t, inWindow: false },
    { key: "1", label: "Week +1", date: addDays(t, 7), inWindow: false },
    ...forecast.horizon_weeks.map((h, i) => ({
      key: String(h),
      label: `Week +${h}`,
      date: forecast.forecast_weeks[i] ?? addDays(t, 7 * h),
      inWindow: true,
    })),
  ];
  return (
    <div className="horizon" role="group" aria-label="Forecast window">
      <ol className="horizon-cells">
        {cells.map((c) => (
          <li key={c.key} className={c.inWindow ? "in-window" : undefined}>
            <span className="h-label">{c.label}</span>
            <span className="h-date">{formatDayMonth(c.date)}</span>
          </li>
        ))}
      </ol>
      <p className="horizon-caption">
        <span className="horizon-bracket" aria-hidden="true" />
        One combined total for weeks +2 to +4, not three separate weekly forecasts.
      </p>
    </div>
  );
}

function DetailBody({ forecast, meta }: { forecast: Forecast; meta: Meta }) {
  const threshold = meta.early_alert.threshold;
  const obs = forecast.actual;
  return (
    <>
      <header className="detail-head">
        <h2 id="detail-title">{wardLabel(forecast.ward_id)}</h2>
        <p className="detail-where">
          {forecast.city}, issue week of {formatDate(forecast.issue_week)}
        </p>
      </header>

      <p className="statement">
        The model estimates <span className="statement-num">{cases(forecast.predicted_cases_3wk)}</span> dengue cases
        in total across weeks +2 to +4 after the issue week.
      </p>

      <dl className="facts">
        <div className="fact">
          <dt>Risk tier</dt>
          <dd>
            <TierChip tier={forecast.risk_tier} />
            <span className="fact-note">A provisional, model-defined category. It is not a declared outbreak.</span>
          </dd>
        </div>
        <div className="fact">
          <dt>Early alert</dt>
          <dd>
            <strong className={forecast.early_alert ? "alert-on" : "alert-off"}>
              {forecast.early_alert ? "Raised" : "Not raised"}
            </strong>
            <span className="fact-note">
              Raised when predicted combined cases are above {threshold}. This estimate is{" "}
              {cases(forecast.predicted_cases_3wk)}.
            </span>
          </dd>
        </div>
      </dl>

      <HorizonStrip forecast={forecast} />

      <div className="observed">
        <h3>Observed later (historical comparison)</h3>
        {obs && obs.available && obs.actual_cases_3wk !== null ? (
          <p>
            <strong className="observed-num">{obs.actual_cases_3wk}</strong> cases were recorded in the same three
            weeks
            {obs.actual_risk_tier && (
              <>
                , which falls in the <TierChip tier={obs.actual_risk_tier} className="tier-inline" /> tier
              </>
            )}
            . {obs.note}
          </p>
        ) : (
          <p>
            No observed total is available for this week. Observed cases exist only for issue weeks up to{" "}
            {formatDate(meta.valid_issue_weeks.actuals_available_until_issue_week)}. Observed outcomes are never an
            input to the forecast.
          </p>
        )}
      </div>

      {forecast.warnings.length > 0 && (
        <ul className="warnings" aria-label="Model input warnings">
          {forecast.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <DriversChart drivers={forecast.drivers} />
    </>
  );
}
