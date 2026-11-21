import type { Forecast, Meta } from "../api/types";
import { TIER_ORDER } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { TierChip } from "./TierChip";

interface Props {
  forecasts: Forecast[];
  meta: Meta;
  issueDate: string;
  selectedWard: string;
  onSelectWard: (id: string) => void;
}

const BAR_W = 44; // px per ward column: wide enough for a 12px value and a two-digit ward number

function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="bell">
      <path
        d="M8 1.8a3.6 3.6 0 0 0-3.6 3.6c0 3.2-1.4 4-1.4 4.9h10c0-.9-1.4-1.7-1.4-4.9A3.6 3.6 0 0 0 8 1.8ZM6.6 12.2a1.5 1.5 0 0 0 2.8 0"
        fill="currentColor"
      />
    </svg>
  );
}

/** One shared Y scale for all five charts: the next multiple of 10 above the largest forecast and the alert line. */
export function sharedScale(forecasts: Forecast[], threshold: number): { max: number; ticks: number[] } {
  const top = Math.max(threshold, ...forecasts.map((f) => f.predicted_cases_3wk));
  const max = Math.max(10, Math.ceil(top / 10) * 10);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += 10) ticks.push(v);
  return { max, ticks };
}

/**
 * Five vertical bar charts (one per city corporation), one bar per ward, drawn with plain HTML/CSS.
 * Bars are real buttons so keyboard, screen readers and touch all work; heights use the unrounded forecast.
 */
export function WardCharts({ forecasts, meta, issueDate, selectedWard, onSelectWard }: Props) {
  const { t, int, num, city: cityName, ward, wardNo, date } = useI18n();
  const byWard = new Map(forecasts.map((f) => [f.ward_id, f]));
  const thr = meta.early_alert.threshold;
  const { max, ticks } = sharedScale(forecasts, thr);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  const edges = meta.risk_tiers.edges.map((e) => num(e));

  return (
    <div className="register">
      <div className="register-head">
        <h3>{t.registerTitle}</h3>
        <p>{t.registerLead(date(issueDate))}</p>
        <div className="chart-legend" role="group" aria-label={t.legendTitle}>
          <ul className="legend-tiers">
            {TIER_ORDER.map((tier) => (
              <li key={tier}>
                <TierChip tier={tier} />
                <span className="legend-range">{t.tierRange(tier, edges)}</span>
              </li>
            ))}
          </ul>
          <ul className="legend-marks">
            <li>
              <span className="key-bell">
                <BellIcon />
              </span>
              {t.legendAlert(int(thr))}
            </li>
            <li>
              <span className="key-dash" aria-hidden="true" />
              {t.legendLine(int(thr))}
            </li>
            <li>
              <span className="key-frame">{int(12)}</span>
              {t.legendSelected}
            </li>
          </ul>
        </div>
      </div>

      <div className="register-groups">
        {meta.cities.map((c) => {
          const rows = c.wards.map((id) => byWard.get(id)).filter((f): f is Forecast => !!f);
          const alerts = rows.filter((f) => f.early_alert).length;
          const scrolls = rows.length > 10;
          return (
            <section key={c.city} className="register-group" aria-label={cityName(c.city)}>
              <div className="group-head">
                <h4>{cityName(c.city)}</h4>
                <span className="group-meta">{t.registerGroupSummary(int(rows.length), int(alerts))}</span>
              </div>
              {scrolls && <p className="scroll-hint">{t.scrollHint(int(rows.length))}</p>}
              <p className="y-caption">
                <strong>{t.yTitle}</strong> <span>({t.yHelp})</span>
              </p>
              <div className="chart" role="group" aria-label={t.chartAria(cityName(c.city), int(rows.length), date(issueDate))}>
                <div className="chart-y" aria-hidden="true">
                  <div className="y-plot">
                    {ticks.map((v) => (
                      <span key={v} className="y-tick" style={{ bottom: pct(v) }}>
                        {int(v)}
                      </span>
                    ))}
                    <span className="y-tick y-alert" style={{ bottom: pct(thr) }}>
                      {int(thr)}
                    </span>
                  </div>
                </div>
                <div className="chart-scroll">
                  <div className="chart-body" style={{ minWidth: `${rows.length * BAR_W}px` }}>
                    <div className="grid-layer" aria-hidden="true">
                      {ticks.map((v) => (
                        <span key={v} className="grid-line" style={{ bottom: pct(v) }} />
                      ))}
                      <span className="alert-rule" style={{ bottom: pct(thr) }} />
                    </div>
                    <ul className="bars" aria-label={t.barsList(cityName(c.city))}>
                      {rows.map((f, i) => {
                        const sel = f.ward_id === selectedWard;
                        const edge = i < 2 ? " tip-start" : i >= rows.length - 2 ? " tip-end" : "";
                        return (
                          <li key={f.ward_id}>
                            <button
                              type="button"
                              className={`bar-btn tier-${f.risk_tier.toLowerCase()}${sel ? " is-selected" : ""}${f.early_alert ? " has-alert" : ""}`}
                              aria-pressed={sel}
                              aria-label={t.cardLabel(ward(f.ward_id), t.tier[f.risk_tier], num(f.predicted_cases_3wk), f.early_alert)}
                              onClick={() => onSelectWard(f.ward_id)}
                            >
                              <span className="bar-area">
                                <span className="bar-col" data-tier={f.risk_tier} style={{ height: pct(f.predicted_cases_3wk) }}>
                                  <span className="bar-val">{num(f.predicted_cases_3wk)}</span>
                                </span>
                                <span className={`tip${edge}`} aria-hidden="true">
                                  <strong>{ward(f.ward_id)}</strong>
                                  <span>{t.tipCases(num(f.predicted_cases_3wk))}</span>
                                  <span>{t.tipTier(t.tier[f.risk_tier])}</span>
                                  <span>{t.tipAlert(f.early_alert)}</span>
                                </span>
                              </span>
                              <span className="bar-label">{wardNo(f.ward_id)}</span>
                              <span className="bar-flag" aria-hidden="true">
                                {f.early_alert && <BellIcon />}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="x-title">{t.xTitle}</p>
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
