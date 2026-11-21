import { useMemo, useState } from "react";
import type { AllForecastsResponse, Forecast, Meta, RiskTier } from "../api/types";
import { TIER_ORDER } from "../api/types";
import { formatDate } from "../lib/dates";
import { cases, countByTier, TIER_MARK, wardLabel, wardNumber } from "../lib/format";
import type { RequestState } from "../lib/useRequest";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";
import { TierChip } from "./TierChip";

interface Props {
  request: RequestState<AllForecastsResponse>;
  meta: Meta;
  issueDate: string;
  selectedWard: string;
  onSelectWard: (wardId: string) => void;
  baseUrl: string;
}

export function Overview({ request, meta, issueDate, selectedWard, onSelectWard, baseUrl }: Props) {
  return (
    <section className="overview" aria-labelledby="overview-title" aria-busy={request.status === "loading"}>
      <div className="section-head">
        <h2 id="overview-title">All {meta.ward_count} wards, week of {formatDate(issueDate)}</h2>
        <p>
          Every ward for the same issue week, from the same model. Wards are ordered by predicted cases, not by any
          verified ranking.
        </p>
      </div>
      {request.status === "error" && request.error && (
        <ErrorPanel error={request.error} baseUrl={baseUrl} onRetry={request.reload} />
      )}
      {(request.status === "loading" || request.status === "idle") && (
        <LoadingPanel label="Loading all wards for this week…" />
      )}
      {request.status === "success" && request.data && request.data.forecasts.length === 0 && (
        <EmptyPanel title="No ward forecasts for this week" body="Choose another issue week." />
      )}
      {request.status === "success" && request.data && request.data.forecasts.length > 0 && (
        <OverviewBody
          forecasts={request.data.forecasts}
          meta={meta}
          selectedWard={selectedWard}
          onSelectWard={onSelectWard}
        />
      )}
    </section>
  );
}

function OverviewBody({
  forecasts,
  meta,
  selectedWard,
  onSelectWard,
}: {
  forecasts: Forecast[];
  meta: Meta;
  selectedWard: string;
  onSelectWard: (id: string) => void;
}) {
  const byTier = countByTier(forecasts);
  const alerts = forecasts.filter((f) => f.early_alert).length;
  return (
    <>
      <div className="summary">
        <TierSummary byTier={byTier} total={forecasts.length} alerts={alerts} threshold={meta.early_alert.threshold} />
        <CityBreakdown forecasts={forecasts} meta={meta} />
      </div>
      <WardRegister forecasts={forecasts} meta={meta} selectedWard={selectedWard} onSelectWard={onSelectWard} />
      <WardTable forecasts={forecasts} meta={meta} selectedWard={selectedWard} onSelectWard={onSelectWard} />
    </>
  );
}

function StackedBar({ byTier, total, label }: { byTier: Record<RiskTier, number>; total: number; label: string }) {
  return (
    <div className="stack" role="img" aria-label={label}>
      {TIER_ORDER.map((t) =>
        byTier[t] > 0 ? (
          <span
            key={t}
            className={`stack-seg tier-${t.toLowerCase()}`}
            style={{ flexGrow: byTier[t], flexBasis: 0 }}
            title={`${t}: ${byTier[t]} of ${total}`}
          >
            {byTier[t] / total > 0.08 ? byTier[t] : ""}
          </span>
        ) : null,
      )}
    </div>
  );
}

function TierSummary({
  byTier,
  total,
  alerts,
  threshold,
}: {
  byTier: Record<RiskTier, number>;
  total: number;
  alerts: number;
  threshold: number;
}) {
  const label = TIER_ORDER.map((t) => `${byTier[t]} ${t}`).join(", ");
  return (
    <div className="tier-summary">
      <h3>Wards by risk tier</h3>
      <StackedBar byTier={byTier} total={total} label={`Wards by risk tier: ${label}`} />
      <ul className="tier-legend">
        {TIER_ORDER.map((t) => (
          <li key={t}>
            <TierChip tier={t} />
            <span className="legend-count">{byTier[t]}</span>
          </li>
        ))}
      </ul>
      <p className="alert-line">
        <strong>{alerts}</strong> of {total} wards are above the early-alert line (predicted combined cases &gt;{" "}
        {threshold}).
      </p>
    </div>
  );
}

function CityBreakdown({ forecasts, meta }: { forecasts: Forecast[]; meta: Meta }) {
  return (
    <div className="city-breakdown">
      <h3>By city corporation</h3>
      <ul>
        {meta.cities.map((c) => {
          const rows = forecasts.filter((f) => f.city === c.city);
          const by = countByTier(rows);
          const a = rows.filter((f) => f.early_alert).length;
          const label = `${c.city}: ${TIER_ORDER.map((t) => `${by[t]} ${t}`).join(", ")}`;
          return (
            <li key={c.city}>
              <span className="city-name">{c.city}</span>
              <StackedBar byTier={by} total={rows.length || 1} label={label} />
              <span className="city-meta">
                {rows.length} wards, {a} above alert line
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WardRegister({
  forecasts,
  meta,
  selectedWard,
  onSelectWard,
}: {
  forecasts: Forecast[];
  meta: Meta;
  selectedWard: string;
  onSelectWard: (id: string) => void;
}) {
  const byWard = new Map(forecasts.map((f) => [f.ward_id, f]));
  return (
    <div className="register">
      <div className="register-head">
        <h3>Ward register</h3>
        <p>
          One tile per ward, grouped by city corporation. The big number is predicted combined cases for weeks +2 to
          +4; the letter is the risk tier. This is a register, not a map: tile position has no geographic meaning.
        </p>
      </div>
      <div className="register-groups">
        {meta.cities.map((c) => (
          <div key={c.city} className="register-group">
            <h4>{c.city}</h4>
            <ul className="tiles">
              {c.wards.map((id) => {
                const f = byWard.get(id);
                if (!f) return null;
                const sel = id === selectedWard;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className={`tile tier-${f.risk_tier.toLowerCase()}${sel ? " is-selected" : ""}${f.early_alert ? " has-alert" : ""}`}
                      aria-pressed={sel}
                      aria-label={`${wardLabel(id)}, ${f.risk_tier} tier, ${cases(f.predicted_cases_3wk)} predicted cases${f.early_alert ? ", early alert raised" : ""}`}
                      onClick={() => onSelectWard(id)}
                      title={`${wardLabel(id)}: ${f.risk_tier}, ${cases(f.predicted_cases_3wk)} cases`}
                    >
                      <span className="tile-ward">{wardNumber(id)}</span>
                      <span className="tile-val">{Math.round(f.predicted_cases_3wk)}</span>
                      <span className="tile-mark" aria-hidden="true">
                        {TIER_MARK[f.risk_tier]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="register-key">
        Tiles with a dark corner notch are above the early-alert line. The selected ward has a dark frame.
      </p>
    </div>
  );
}

type SortKey = "cases" | "ward";
const PREVIEW_ROWS = 12;

function WardTable({
  forecasts,
  meta,
  selectedWard,
  onSelectWard,
}: {
  forecasts: Forecast[];
  meta: Meta;
  selectedWard: string;
  onSelectWard: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [sort, setSort] = useState<SortKey>("cases");
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = forecasts.filter(
      (f) =>
        (city === "all" || f.city === city) &&
        (q === "" || wardLabel(f.ward_id).toLowerCase().includes(q) || f.city.toLowerCase().includes(q)),
    );
    return [...list].sort((a, b) =>
      sort === "cases"
        ? b.predicted_cases_3wk - a.predicted_cases_3wk || a.ward_id.localeCompare(b.ward_id)
        : a.ward_id.localeCompare(b.ward_id),
    );
  }, [forecasts, query, city, sort]);
  const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="ward-table">
      <div className="table-head">
        <h3>Ward list</h3>
        <div className="table-filters">
          <div className="field">
            <label htmlFor="ward-search">Search wards</label>
            <input
              id="ward-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. DNCC 12"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="list-city">City</label>
            <select id="list-city" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="all">All cities</option>
              {meta.cities.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="list-sort">Order by</label>
            <select id="list-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="cases">Predicted cases, highest first</option>
              <option value="ward">Ward name</option>
            </select>
          </div>
        </div>
      </div>
      <p className="table-count" role="status" aria-live="polite">
        {rows.length === forecasts.length
          ? `Showing ${shown.length} of ${rows.length} wards`
          : `Showing ${shown.length} of ${rows.length} matching ward${rows.length === 1 ? "" : "s"} (${forecasts.length} total)`}
      </p>
      {rows.length === 0 ? (
        <EmptyPanel title="No wards match" body="Clear the search or choose All cities." />
      ) : (
        <table>
          <caption className="sr-only">
            Predicted combined dengue cases for weeks +2 to +4, by ward. Select a row to open its forecast.
          </caption>
          <thead>
            <tr>
              <th scope="col">Ward</th>
              <th scope="col" className="num">
                Predicted cases
              </th>
              <th scope="col">Risk tier</th>
              <th scope="col">Early alert</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.ward_id} className={f.ward_id === selectedWard ? "is-selected" : undefined}>
                <th scope="row">
                  <button
                    type="button"
                    className="link-btn"
                    aria-current={f.ward_id === selectedWard ? "true" : undefined}
                    onClick={() => onSelectWard(f.ward_id)}
                  >
                    {wardLabel(f.ward_id)}
                  </button>
                  <span className="row-city">{f.city}</span>
                  {f.early_alert && <span className="row-alert">Early alert raised</span>}
                </th>
                <td className="num">{cases(f.predicted_cases_3wk)}</td>
                <td>
                  <TierChip tier={f.risk_tier} />
                </td>
                <td>{f.early_alert ? <strong className="alert-on">Raised</strong> : <span className="alert-off">Not raised</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > PREVIEW_ROWS && (
        <button type="button" className="btn btn-quiet" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? `Show top ${PREVIEW_ROWS} only` : `Show all ${rows.length} wards`}
        </button>
      )}
    </div>
  );
}
