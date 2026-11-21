import type { Forecast, Meta, RiskTier, WardForecastResponse } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { addDays } from "../lib/dates";
import type { RequestState } from "../lib/useRequest";
import { DriversChart } from "./DriversChart";
import { ErrorPanel, LoadingPanel } from "./StatusPanel";
import { TierChip } from "./TierChip";

interface Props {
  request: RequestState<WardForecastResponse>;
  meta: Meta;
  baseUrl: string;
}

export function WardDetail({ request, meta, baseUrl }: Props) {
  const { t } = useI18n();
  return (
    <section className="detail" aria-labelledby="detail-title" aria-busy={request.status === "loading"}>
      {request.status === "error" && request.error && (
        <>
          <h2 id="detail-title">{t.detailTitleFallback}</h2>
          <ErrorPanel error={request.error} baseUrl={baseUrl} onRetry={request.reload} />
        </>
      )}
      {(request.status === "loading" || request.status === "idle") && (
        <>
          <h2 id="detail-title">{t.detailTitleFallback}</h2>
          <LoadingPanel label={t.loadingWard} />
        </>
      )}
      {request.status === "success" && request.data && <DetailBody forecast={request.data.forecast} meta={meta} />}
    </section>
  );
}

function HorizonStrip({ forecast }: { forecast: Forecast }) {
  const { t, dayMonth, int } = useI18n();
  const w = forecast.issue_week;
  const cells = [
    { key: "t", label: t.horizonIssue, date: w, inWindow: false },
    { key: "1", label: t.horizonWeek(int(1)), date: addDays(w, 7), inWindow: false },
    ...forecast.horizon_weeks.map((h, i) => ({
      key: String(h),
      label: t.horizonWeek(int(h)),
      date: forecast.forecast_weeks[i] ?? addDays(w, 7 * h),
      inWindow: true,
    })),
  ];
  return (
    <div className="horizon" role="group" aria-label={t.horizonGroup}>
      <ol className="horizon-cells">
        {cells.map((c) => (
          <li key={c.key} className={c.inWindow ? "in-window" : undefined}>
            <span className="h-label">{c.label}</span>
            <span className="h-date">{dayMonth(c.date)}</span>
          </li>
        ))}
      </ol>
      <p className="horizon-caption">
        <span className="horizon-bracket" aria-hidden="true" />
        {t.horizonCaption}
      </p>
    </div>
  );
}

const TIERS: RiskTier[] = ["Low", "Medium", "High", "Critical"];

function TierRuler({ current, edges }: { current: RiskTier; edges: number[] }) {
  const { t, num } = useI18n();
  const e = edges.map((x) => num(x));
  return (
    <ol className="ruler" aria-label={t.tierFactTitle}>
      {TIERS.map((tier) => (
        <li
          key={tier}
          className={`ruler-seg tier-${tier.toLowerCase()}${tier === current ? " is-current" : ""}`}
          aria-current={tier === current ? "true" : undefined}
        >
          <span className="ruler-name">{t.tier[tier]}</span>
          <span className="ruler-range">{t.tierRange(tier, e)}</span>
        </li>
      ))}
    </ol>
  );
}

function DetailBody({ forecast, meta }: { forecast: Forecast; meta: Meta }) {
  const { t, lang, num, int, date, dayMonth, city, ward } = useI18n();
  const thr = meta.early_alert.threshold;
  const obs = forecast.actual;
  const est = num(forecast.predicted_cases_3wk);
  const [w2, w3, w4] = forecast.forecast_weeks;
  const observed = obs && obs.available && obs.actual_cases_3wk !== null ? obs : null;
  const obsCases = observed?.actual_cases_3wk ?? 0;
  const diff = forecast.predicted_cases_3wk - obsCases;
  const diffText =
    Math.abs(diff) < 0.05
      ? t.compareDiffSame
      : diff > 0
        ? t.compareDiffOver(num(Math.abs(diff)))
        : t.compareDiffUnder(num(Math.abs(diff)));

  return (
    <>
      <header className="detail-head">
        <h2 id="detail-title">{ward(forecast.ward_id)}</h2>
        <p className="detail-where">{t.where(city(forecast.city), date(forecast.issue_week))}</p>
      </header>

      <div className="result">
        <p className="result-label">{t.resultLabel}</p>
        <p className="result-num">{est}</p>
        <p className="result-sub">{t.resultSub}</p>
        {w2 && w3 && w4 && <p className="result-weeks">{t.periodLine(dayMonth(w2), dayMonth(w3), dayMonth(w4))}</p>}
      </div>

      <p className="statement">{t.statement(est)}</p>

      <dl className="facts">
        <div className="fact">
          <dt>{t.tierFactTitle}</dt>
          <dd>
            <span className="fact-line">
              <TierChip tier={forecast.risk_tier} />
              <span className="fact-strong">{t.tierMeaning[forecast.risk_tier]}</span>
            </span>
            <TierRuler current={forecast.risk_tier} edges={meta.risk_tiers.edges} />
            <span className="fact-note">{t.tierFactNote}</span>
          </dd>
        </div>
        <div className={`fact fact-alert${forecast.early_alert ? " is-raised" : ""}`}>
          <dt>{t.alertFactTitle}</dt>
          <dd>
            <strong className={forecast.early_alert ? "alert-on" : "alert-off"}>
              {forecast.early_alert && (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="bell">
                  <path
                    d="M8 1.8a3.6 3.6 0 0 0-3.6 3.6c0 3.2-1.4 4-1.4 4.9h10c0-.9-1.4-1.7-1.4-4.9A3.6 3.6 0 0 0 8 1.8ZM6.6 12.2a1.5 1.5 0 0 0 2.8 0"
                    fill="currentColor"
                  />
                </svg>
              )}
              {forecast.early_alert ? t.alertRaised : t.alertNotRaised}
            </strong>
            <span className="fact-note">
              {forecast.early_alert ? t.alertFactRaised(num(thr, 0), est) : t.alertFactNot(num(thr, 0), est)}{" "}
              {t.alertFactHow}
            </span>
          </dd>
        </div>
      </dl>

      <HorizonStrip forecast={forecast} />

      <div className="observed">
        <h3>{t.observedHeading}</h3>
        {observed ? (
          <>
            <div className="compare">
              <div className="compare-col">
                <span className="compare-label">{t.compareForecast}</span>
                <span className="compare-num">{est}</span>
                <TierChip tier={forecast.risk_tier} />
                <span className="compare-sub">{t.compareForecastSub}</span>
              </div>
              <div className="compare-col compare-col-obs">
                <span className="compare-label">{t.compareObserved}</span>
                <span className="compare-num">{int(obsCases)}</span>
                {observed.actual_risk_tier && <TierChip tier={observed.actual_risk_tier} />}
                <span className="compare-sub">{t.compareObservedSub}</span>
              </div>
            </div>
            <p>
              {t.observedText(int(obsCases))}
              {observed.actual_risk_tier && (
                <>
                  , {t.observedTier} <TierChip tier={observed.actual_risk_tier} className="tier-inline" /> {t.observedTierEnd}
                </>
              )}
              . {lang === "bn" ? t.observedNote : observed.note}
            </p>
            <p className="compare-diff">{diffText}</p>
          </>
        ) : (
          <p>{t.observedNone(date(meta.valid_issue_weeks.actuals_available_until_issue_week))}</p>
        )}
      </div>

      {forecast.warnings.length > 0 && (
        <ul className="warnings" aria-label={t.warningsLabel}>
          {forecast.warnings.map((w) => (
            <li key={w} lang={lang === "bn" ? "en" : undefined}>
              {w}
            </li>
          ))}
        </ul>
      )}

      <DriversChart drivers={forecast.drivers} predicted={forecast.predicted_cases_3wk} raw={forecast.raw_model_output} />
    </>
  );
}
