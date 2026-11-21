import { useMemo, useState } from "react";
import type { AllForecastsResponse, Forecast, Meta, RiskTier } from "../api/types";
import { TIER_ORDER } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { countByTier } from "../lib/format";
import type { RequestState } from "../lib/useRequest";
import { EmptyPanel, ErrorPanel, LoadingPanel } from "./StatusPanel";
import { TierChip } from "./TierChip";
import { WardCharts } from "./WardCharts";

interface Props {
  request: RequestState<AllForecastsResponse>;
  meta: Meta;
  issueDate: string;
  selectedWard: string;
  onSelectWard: (wardId: string) => void;
  baseUrl: string;
}

export function Overview({ request, meta, issueDate, selectedWard, onSelectWard, baseUrl }: Props) {
  const { t, int, date } = useI18n();
  return (
    <section className="overview" aria-labelledby="overview-title" aria-busy={request.status === "loading"}>
      <div className="section-head">
        <h2 id="overview-title">{t.overviewTitle(int(meta.ward_count), date(issueDate))}</h2>
        <p>{t.overviewLead}</p>
      </div>
      {request.status === "error" && request.error && (
        <ErrorPanel error={request.error} baseUrl={baseUrl} onRetry={request.reload} />
      )}
      {(request.status === "loading" || request.status === "idle") && <LoadingPanel label={t.loadingAll} />}
      {request.status === "success" && request.data && request.data.forecasts.length === 0 && (
        <EmptyPanel title={t.emptyAllTitle} body={t.emptyAllBody} />
      )}
      {request.status === "success" && request.data && request.data.forecasts.length > 0 && (
        <OverviewBody
          forecasts={request.data.forecasts}
          meta={meta}
          issueDate={issueDate}
          selectedWard={selectedWard}
          onSelectWard={onSelectWard}
        />
      )}
    </section>
  );
}

interface BodyProps {
  forecasts: Forecast[];
  meta: Meta;
  issueDate?: string;
  selectedWard: string;
  onSelectWard: (id: string) => void;
}

function OverviewBody({ forecasts, meta, issueDate, selectedWard, onSelectWard }: BodyProps) {
  const byTier = countByTier(forecasts);
  const alerts = forecasts.filter((f) => f.early_alert).length;
  return (
    <>
      <div className="summary">
        <TierSummary byTier={byTier} total={forecasts.length} alerts={alerts} threshold={meta.early_alert.threshold} />
        <CityBreakdown forecasts={forecasts} meta={meta} />
      </div>
      <WardCharts forecasts={forecasts} meta={meta} issueDate={issueDate ?? ""} selectedWard={selectedWard} onSelectWard={onSelectWard} />
      <WardTable forecasts={forecasts} meta={meta} selectedWard={selectedWard} onSelectWard={onSelectWard} />
    </>
  );
}

function StackedBar({ byTier, total, label }: { byTier: Record<RiskTier, number>; total: number; label: string }) {
  const { t, int } = useI18n();
  return (
    <div className="stack" role="img" aria-label={label}>
      {TIER_ORDER.map((tier) =>
        byTier[tier] > 0 ? (
          <span
            key={tier}
            className={`stack-seg tier-${tier.toLowerCase()}`}
            style={{ flexGrow: byTier[tier], flexBasis: 0 }}
            title={t.segTitle(t.tier[tier], int(byTier[tier]), int(total))}
          >
            {byTier[tier] / total > 0.08 ? int(byTier[tier]) : ""}
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
  const { t, int } = useI18n();
  const label = TIER_ORDER.map((x) => t.tierCount(int(byTier[x]), t.tier[x])).join(", ");
  return (
    <div className="tier-summary">
      <h3>{t.byTier}</h3>
      <StackedBar byTier={byTier} total={total} label={t.byTierLabel(label)} />
      <ul className="tier-legend">
        {TIER_ORDER.map((x) => (
          <li key={x}>
            <TierChip tier={x} />
            <span className="legend-count">{int(byTier[x])}</span>
          </li>
        ))}
      </ul>
      <p className="alert-line">{t.alertLine(int(alerts), int(total), int(threshold))}</p>
    </div>
  );
}

function CityBreakdown({ forecasts, meta }: { forecasts: Forecast[]; meta: Meta }) {
  const { t, int, city } = useI18n();
  return (
    <div className="city-breakdown">
      <h3>{t.byCity}</h3>
      <ul>
        {meta.cities.map((c) => {
          const rows = forecasts.filter((f) => f.city === c.city);
          const by = countByTier(rows);
          const a = rows.filter((f) => f.early_alert).length;
          const label = `${city(c.city)}: ${TIER_ORDER.map((x) => t.tierCount(int(by[x]), t.tier[x])).join(", ")}`;
          return (
            <li key={c.city}>
              <span className="city-name">{city(c.city)}</span>
              <StackedBar byTier={by} total={rows.length || 1} label={label} />
              <span className="city-meta">{t.cityMeta(int(rows.length), int(a))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type SortKey = "cases" | "ward";
const PREVIEW_ROWS = 12;

function WardTable({ forecasts, meta, selectedWard, onSelectWard }: BodyProps) {
  const { t, num, int, city: cityName, ward: wardName } = useI18n();
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [sort, setSort] = useState<SortKey>("cases");
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = forecasts.filter(
      (f) =>
        (city === "all" || f.city === city) &&
        (q === "" ||
          [wardName(f.ward_id), f.ward_id.replace(/_/g, " "), f.city, cityName(f.city)].some((s) => s.toLowerCase().includes(q))),
    );
    return [...list].sort((a, b) =>
      sort === "cases"
        ? b.predicted_cases_3wk - a.predicted_cases_3wk || a.ward_id.localeCompare(b.ward_id)
        : a.ward_id.localeCompare(b.ward_id),
    );
  }, [forecasts, query, city, sort, wardName, cityName]);
  const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="ward-table">
      <div className="table-head">
        <h3>{t.listTitle}</h3>
        <div className="table-filters">
          <div className="field">
            <label htmlFor="ward-search">{t.search}</label>
            <input
              id="ward-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchPh}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="list-city">{t.listCity}</label>
            <select id="list-city" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="all">{t.allCities}</option>
              {meta.cities.map((c) => (
                <option key={c.city} value={c.city}>
                  {cityName(c.city)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="list-sort">{t.orderBy}</label>
            <select id="list-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="cases">{t.orderCases}</option>
              <option value="ward">{t.orderWard}</option>
            </select>
          </div>
        </div>
      </div>
      <p className="table-count" role="status" aria-live="polite">
        {rows.length === forecasts.length
          ? t.showing(int(shown.length), int(rows.length))
          : t.showingFiltered(int(shown.length), int(rows.length), int(forecasts.length), rows.length === 1)}
      </p>
      {rows.length === 0 ? (
        <EmptyPanel title={t.noMatchTitle} body={t.noMatchBody} />
      ) : (
        <table>
          <caption className="sr-only">{t.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{t.thWard}</th>
              <th scope="col" className="num">
                {t.thCases}
              </th>
              <th scope="col">{t.thTier}</th>
              <th scope="col">{t.thAlert}</th>
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
                    {wardName(f.ward_id)}
                  </button>
                  <span className="row-city">{cityName(f.city)}</span>
                  {f.early_alert && <span className="row-alert">{t.rowAlert}</span>}
                </th>
                <td className="num">{num(f.predicted_cases_3wk)}</td>
                <td>
                  <TierChip tier={f.risk_tier} />
                </td>
                <td>
                  {f.early_alert ? (
                    <strong className="alert-on">{t.alertRaised}</strong>
                  ) : (
                    <span className="alert-off">{t.alertNotRaised}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > PREVIEW_ROWS && (
        <button type="button" className="btn btn-quiet" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? t.showTop(int(PREVIEW_ROWS)) : t.showAll(int(rows.length))}
        </button>
      )}
    </div>
  );
}
