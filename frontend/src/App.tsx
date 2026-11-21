import { useMemo, useState } from "react";
import { createClient, type ApiClient } from "./api/client";
import type { Meta } from "./api/types";
import { Controls, type Selection } from "./components/Controls";
import { Methodology } from "./components/Methodology";
import { Overview } from "./components/Overview";
import { ErrorPanel, LoadingPanel } from "./components/StatusPanel";
import { WardDetail } from "./components/WardDetail";
import { formatDate, weeksBetween } from "./lib/dates";
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

function ReplayBadge() {
  return (
    <span className="replay-badge">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Historical replay
    </span>
  );
}

export default function App({ client: injected }: { client?: ApiClient }) {
  const client = useMemo(() => injected ?? createClient(), [injected]);
  const metaReq = useRequest<Meta>("meta", (signal) => client.meta(signal));
  const meta = metaReq.data;

  // Until the user changes something, the selection is derived from /meta (no effect needed).
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

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to forecasts
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true" className="brand-mark">
              <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.14" />
              <path d="M6 21c4.2 0 4.2-10 10-10s5.8 10 10 10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
            <span className="brand-name">Dengue Outlook</span>
            <ReplayBadge />
          </div>
          {selection && (
            <aside className="replay-now" aria-label="Selected issue week">
              <p className="replay-now-label">Replaying the issue week of</p>
              <p className="replay-now-date">{formatDate(selection.date)}</p>
              <p className="replay-now-note">Combined dengue cases forecast for weeks +2 to +4.</p>
            </aside>
          )}
          <h1>Ward-level dengue forecasts for Bangladesh's cities, replayed from historical data</h1>
          <p className="masthead-lede">
            A trained model reads each ward's recent weather and case counts, then estimates the combined dengue cases
            for weeks +2 to +4. Sixty wards, five city corporations, weekly records through 29 Dec 2025.
          </p>
          <p className="masthead-notice" role="note">
            <strong>Not a live warning system.</strong>{" "}
            {meta ? meta.notice : "Forecasts are replayed from historical data and are model estimates, not verified real-world warnings."}
          </p>
        </div>
      </header>

      <main id="main" className="page">
        {metaReq.status === "loading" || metaReq.status === "idle" ? (
          <LoadingPanel label="Connecting to the forecast service…" />
        ) : null}
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
        <Methodology meta={meta} />
      </main>
    </>
  );
}
