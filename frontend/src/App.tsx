import { useMemo, useState } from "react";
import { createClient, type ApiClient } from "./api/client";
import type { Meta } from "./api/types";
import { Controls, type Selection } from "./components/Controls";
import { closeAllInfoPopovers } from "./components/InfoButton";
import { Methodology } from "./components/Methodology";
import { Overview } from "./components/Overview";
import { ValidationDashboard, type ValidationLoader } from "./components/ValidationDashboard";
import { isSectionAvailable, SectionNav, type SectionId } from "./components/SectionNav";
import { ErrorPanel, LoadingPanel } from "./components/StatusPanel";
import { WardDetail } from "./components/WardDetail";
import { WeeklyOutlook } from "./components/WeeklyOutlook";
import { I18nProvider, useI18n } from "./i18n/I18n";
import { weeksBetween } from "./lib/dates";
import { useRequest } from "./lib/useRequest";

// A replay week in peak season where wards fall in several tiers. Used only if /meta says it is valid.
const PREFERRED_DATE = "2025-07-28";
const PREFERRED_WARD = "DNCC_Ward_12";

export function initialSelection(meta: Meta): Selection {
  const weeks = weeksBetween(meta.valid_issue_weeks.first, meta.valid_issue_weeks.last);
  const date = weeks.includes(PREFERRED_DATE) ? PREFERRED_DATE : (weeks[weeks.length - 1] ?? meta.valid_issue_weeks.last);
  const preferred = meta.wards.find((w) => w.ward_id === PREFERRED_WARD);
  const fallback = meta.cities[0]?.wards[0];
  const ward = preferred?.ward_id ?? fallback ?? "";
  const city = meta.wards.find((w) => w.ward_id === ward)?.city ?? meta.cities[0]?.city ?? "";
  return { city, ward, date };
}

/** English | বাংলা. Each label is in its own language so it is findable from either one. */
function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t.langGroup}>
      <button type="button" lang="en" aria-pressed={lang === "en"} aria-label={t.langEnLabel} onClick={() => setLang("en")}>
        English
      </button>
      <button type="button" lang="bn" aria-pressed={lang === "bn"} aria-label={t.langBnLabel} onClick={() => setLang("bn")}>
        বাংলা
      </button>
    </div>
  );
}

function Dashboard({ injected, validationLoader }: { injected?: ApiClient; validationLoader?: ValidationLoader }) {
  const { t, lang, date } = useI18n();
  const client = useMemo(() => injected ?? createClient(), [injected]);
  const metaReq = useRequest<Meta>("meta", (signal) => client.meta(signal));
  const meta = metaReq.data;

  // Until the user changes something, the selection is derived from /meta (no effect needed).
  // It lives here, above the language, so switching language never resets it.
  const [chosen, setSelection] = useState<Selection | null>(null);
  const selection = chosen ?? (meta ? initialSelection(meta) : null);

  const detail = useRequest(selection ? `ward:${selection.ward}:${selection.date}` : null, (signal) =>
    client.forecastWard(selection?.ward ?? "", selection?.date ?? "", true, signal),
  );
  const overview = useRequest(selection ? `all:${selection.date}` : null, (signal) =>
    client.forecastAll(selection?.date ?? "", signal),
  );

  const selectWard = (wardId: string) => {
    if (!meta || !selection) return;
    const city = meta.wards.find((w) => w.ward_id === wardId)?.city ?? selection.city;
    setSelection({ ...selection, city, ward: wardId });
    document.getElementById("detail-anchor")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  // Section navigation is local state, not a router. Only available sections can become current. The selection and
  // the Overview's forecast requests live here, above every section, so switching sections never resets the
  // selection and never re-requests the Overview forecasts; only the visible section's content is rendered.
  const [section, setSection] = useState<SectionId>("overview");
  const selectSection = (id: SectionId) => {
    if (!isSectionAvailable(id)) return;
    closeAllInfoPopovers();
    setSection(id);
  };

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skip}
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="masthead-top">
            <div className="brand">
              <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true" className="brand-mark">
                <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.14" />
                <path d="M6 21c4.2 0 4.2-10 10-10s5.8 10 10 10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
              </svg>
              <span className="brand-name">{t.brand}</span>
            </div>
            <LanguageSwitch />
          </div>
          {selection && (
            <aside className="replay-now" aria-label={t.replayLabel}>
              <p className="replay-now-label">{t.replayingOf}</p>
              <p className="replay-now-date">{date(selection.date)}</p>
              <p className="replay-now-note">{t.replayNote}</p>
            </aside>
          )}
          <h1>{t.h1}</h1>
          <p className="masthead-lede">{t.lede}</p>
          <p className="masthead-notice" role="note">
            <strong>{t.notLive}</strong> {lang === "bn" ? t.notice : meta ? meta.notice : t.noticeFallback}
          </p>
        </div>
      </header>

      <SectionNav current={section} onSelect={selectSection} />

      <main id="main" className="page">
        {metaReq.status === "loading" || metaReq.status === "idle" ? <LoadingPanel label={t.connecting} /> : null}
        {metaReq.status === "error" && metaReq.error && (
          <ErrorPanel error={metaReq.error} baseUrl={client.baseUrl} onRetry={metaReq.reload} />
        )}
        {meta && selection && (
          <>
            <Controls
              meta={meta}
              value={selection}
              onChange={setSelection}
              busy={detail.status === "loading" || overview.status === "loading"}
            />
            {section === "overview" && (
              <>
                <div id="detail-anchor" className="detail-anchor" />
                <WardDetail request={detail} meta={meta} baseUrl={client.baseUrl} />
                <Overview
                  request={overview}
                  meta={meta}
                  issueDate={selection.date}
                  selectedWard={selection.ward}
                  onSelectWard={selectWard}
                  baseUrl={client.baseUrl}
                />
              </>
            )}
            {section === "weekly" && <WeeklyOutlook client={client} meta={meta} selection={selection} />}
          </>
        )}
        {section === "overview" && (
          <>
            <ValidationDashboard issueDate={selection?.date ?? null} loader={validationLoader} />
            <Methodology meta={meta} />
          </>
        )}
      </main>
    </>
  );
}

export default function App({ client, validationLoader }: { client?: ApiClient; validationLoader?: ValidationLoader }) {
  return (
    <I18nProvider>
      <Dashboard injected={client} validationLoader={validationLoader} />
    </I18nProvider>
  );
}
