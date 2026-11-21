import type { ReactNode } from "react";
import type { Meta, RiskTier } from "../api/types";
import { useI18n } from "../i18n/I18n";

const TIERS: RiskTier[] = ["Low", "Medium", "High", "Critical"];

function Block({ id, icon, title, children }: { id: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="m-block" aria-labelledby={id}>
      <h3 id={id}>
        <span className="m-icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

const svg = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICON_MODEL = svg("M4 7h5v10H4zM15 4h5v7h-5zM15 14h5v6h-5zM9 12h6");
const ICON_READ = svg("M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6ZM12 9.5v5M9.5 12h5");
const ICON_TIER = svg("M4 20V14M10 20V9M16 20V5M22 20V11");
const ICON_LIMIT = svg("M12 3 2.5 20h19L12 3ZM12 10v4.5M12 17.2v.1");

/** Facts come from /meta where the API provides them, otherwise from ml/model_config.json and ml/integration_guide.md. */
export function Methodology({ meta }: { meta: Meta | null }) {
  const { t, lang, num, int, date } = useI18n();
  const edges = meta?.risk_tiers.edges ?? [4.5, 14.5, 30.5];
  const e = edges.map((x) => num(x));
  const thr = meta?.early_alert.threshold ?? 25;
  const window = meta ? t.mWindow(date(meta.valid_issue_weeks.first), date(meta.valid_issue_weeks.last)) : "";
  const tech = t.mHowTech(int(meta?.ward_count ?? 60), window);

  return (
    <section className="method" aria-labelledby="method-title">
      <div className="method-head">
        <h2 id="method-title">{t.mTitle}</h2>
        <p>{t.mLead}</p>
      </div>

      <div className="m-grid">
        <Block id="m-how" icon={ICON_MODEL} title={t.mHowTitle}>
          <ol className="m-steps">
            {t.mSteps.map((s) => (
              <li key={s.h}>
                <strong>{s.h}</strong>
                <span>{s.p}</span>
              </li>
            ))}
          </ol>
          <details className="tech">
            <summary>{t.mHowTechSummary}</summary>
            {tech.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </details>
        </Block>

        <Block id="m-read" icon={ICON_READ} title={t.mReadTitle}>
          <dl className="m-defs">
            {t.mReadItems.map((s) => (
              <div key={s.h}>
                <dt>{s.h}</dt>
                <dd>{s.p}</dd>
              </div>
            ))}
          </dl>
        </Block>

        <Block id="m-tiers" icon={ICON_TIER} title={t.mTiersTitle}>
          <p>{t.mTiersLead}</p>
          <ol className="m-tiers">
            {TIERS.map((tier) => (
              <li key={tier} className={`tier-${tier.toLowerCase()}`}>
                <span className="m-tier-name">{t.tier[tier]}</span>
                <span className="m-tier-range">{t.tierRange(tier, e)}</span>
              </li>
            ))}
          </ol>
          <p className="m-alert">{t.mAlertText(int(thr))}</p>
          <details className="tech">
            <summary>{t.mTiersTechSummary}</summary>
            <p>{t.mTiersTech(int(thr))}</p>
          </details>
        </Block>

        <Block id="m-limits" icon={ICON_LIMIT} title={t.mLimitsTitle}>
          <p>{t.mLimitsLead}</p>
          <ul className="m-stats">
            {t.mStats.map((s) => (
              <li key={s.l}>
                <span className="m-stat-n">{s.n}</span>
                <span className="m-stat-l">{s.l}</span>
              </li>
            ))}
          </ul>
          <ul className="m-limits">
            {t.mLimits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <details className="tech">
            <summary>{t.mLimitsTechSummary}</summary>
            <p>{t.mLimitsTech}</p>
          </details>
        </Block>
      </div>

      <p className="method-foot">
        {meta ? t.mFoot(lang === "bn" ? t.notice : meta.notice, meta.model_version) : t.mFootFallback}
      </p>
    </section>
  );
}
