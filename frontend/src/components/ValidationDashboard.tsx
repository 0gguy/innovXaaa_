import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../api/client";
import type { RollingYear, ValidationData, ValidationSplit } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { addDays } from "../lib/dates";
import { useRequest } from "../lib/useRequest";
import { LoadingPanel } from "./StatusPanel";

export type ValidationLoader = (signal: AbortSignal) => Promise<unknown>;

const DATA_URL = `${import.meta.env.BASE_URL}validation/weekly_errors.json`;
const COL_W = 11; // px per issue week; the chart scrolls sideways when the screen is narrower
const LABEL_EVERY = 9;
/** A date label is about 6 columns wide; one that would run past the end of the plot is left out (the axis title and table give the range). */
const LABEL_COLS = 6;

/** Reads the committed static file. No network beyond the app's own origin. */
export const fetchValidation: ValidationLoader = async (signal) => {
  let res: Response;
  try {
    res = await fetch(DATA_URL, { signal, headers: { Accept: "application/json" } });
  } catch {
    if (signal.aborted) throw new ApiError("aborted", "Request cancelled.");
    throw new ApiError("network", "Could not read the saved evaluation file.");
  }
  if (!res.ok) throw new ApiError("http", `The saved evaluation file returned HTTP ${res.status}.`, { status: res.status });
  try {
    return await res.json();
  } catch {
    throw new ApiError("shape", "The saved evaluation file is not valid JSON.");
  }
};

class ShapeProblem extends Error {}

const SUPPORTED_SCHEMA = 1;
const EXPECTED_OFFSETS = [14, 21, 28];
const DAY_MS = 86_400_000;
const EPS = 1e-6; // exported values are rounded to six decimals

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ShapeProblem(`${what} is not a non-negative number`);
  return v;
};
const isoDate = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ShapeProblem(`${what} is not an ISO date`);
  }
  if (new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new ShapeProblem(`${what} is not a real calendar date`);
  return v;
};
const posInt = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ShapeProblem(`${what} is not a positive integer`);
  return v;
};
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new ShapeProblem(`${what} is missing`);
  return v;
};

function parseSplit(v: unknown, name: string): ValidationSplit {
  if (!isObj(v)) throw new ShapeProblem(`${name} is missing`);
  const pooled = v.pooled;
  if (!isObj(pooled)) throw new ShapeProblem(`${name}.pooled is missing`);
  if (!Array.isArray(v.weekly) || v.weekly.length === 0) throw new ShapeProblem(`${name}.weekly is empty`);
  let prev = "";
  const weekly = v.weekly.map((w: unknown, i: number) => {
    if (!isObj(w)) throw new ShapeProblem(`${name}.weekly[${i}] is not an object`);
    const issue_week = isoDate(w.issue_week, `${name}.weekly[${i}].issue_week`);
    if (new Date(`${issue_week}T00:00:00Z`).getUTCDay() !== 1) throw new ShapeProblem(`${name}.weekly[${i}] is not a Monday`);
    if (prev !== "" && issue_week <= prev) throw new ShapeProblem(`${name}.weekly is not in chronological order or repeats a week`);
    if (prev !== "" && dayNumber(issue_week) - dayNumber(prev) !== 7) throw new ShapeProblem(`${name}.weekly skips a week`);
    prev = issue_week;
    const mae = nonNeg(w.mae, "mae");
    const rmse = nonNeg(w.rmse, "rmse");
    if (rmse + EPS < mae) throw new ShapeProblem(`${name}.weekly[${i}] has RMSE below MAE`);
    return { issue_week, mae, rmse, n: posInt(w.n, "n") };
  });
  const out: ValidationSplit = {
    evaluation_scheme: str(v.evaluation_scheme, `${name}.evaluation_scheme`),
    first_issue_week: isoDate(v.first_issue_week, `${name}.first_issue_week`),
    last_issue_week: isoDate(v.last_issue_week, `${name}.last_issue_week`),
    issue_weeks: nonNeg(v.issue_weeks, "issue_weeks"),
    predictions: nonNeg(v.predictions, "predictions"),
    wards_per_week: nonNeg(v.wards_per_week, "wards_per_week"),
    pooled: { mae: nonNeg(pooled.mae, "pooled.mae"), rmse: nonNeg(pooled.rmse, "pooled.rmse") },
    weekly,
  };
  if (out.issue_weeks !== weekly.length) throw new ShapeProblem(`${name}.issue_weeks does not match the weekly list`);
  if (out.first_issue_week !== weekly[0]?.issue_week || out.last_issue_week !== weekly[weekly.length - 1]?.issue_week) {
    throw new ShapeProblem(`${name} first/last issue week do not match the weekly series`);
  }
  if (!Number.isInteger(out.wards_per_week) || out.wards_per_week <= 0 || weekly.some((w) => w.n !== out.wards_per_week)) {
    throw new ShapeProblem(`${name}.wards_per_week does not match every weekly count`);
  }
  if (out.predictions !== weekly.reduce((s, w) => s + w.n, 0)) throw new ShapeProblem(`${name}.predictions does not match the weekly counts`);
  if (out.pooled.rmse + EPS < out.pooled.mae) throw new ShapeProblem(`${name}.pooled has RMSE below MAE`);
  return out;
}

/** Validates the exported JSON before any metric is shown. Throws ApiError("shape") when it is not usable. */
export function parseValidation(raw: unknown): ValidationData {
  try {
    if (!isObj(raw) || !isObj(raw.splits) || !isObj(raw.rolling_origin)) throw new ShapeProblem("top-level shape");
    const years = raw.rolling_origin.years;
    if (!Array.isArray(years) || years.length === 0) throw new ShapeProblem("rolling_origin.years is empty");
    if (raw.schema_version !== SUPPORTED_SCHEMA) throw new ShapeProblem(`unsupported schema_version ${String(raw.schema_version)}`);
    const offsets = raw.target_window_offset_days;
    if (!Array.isArray(offsets) || offsets.length !== 3 || offsets.some((o, i) => o !== EXPECTED_OFFSETS[i])) {
      throw new ShapeProblem("target_window_offset_days must be exactly 14, 21 and 28");
    }
    let prevYear = 0;
    const rolling: RollingYear[] = years.map((y: unknown) => {
      if (!isObj(y)) throw new ShapeProblem("rolling year");
      const year = posInt(y.year, "year");
      if (year <= prevYear) throw new ShapeProblem("rolling_origin.years is not ascending or repeats a year");
      prevYear = year;
      const mae = nonNeg(y.mae, "mae");
      const rmse = nonNeg(y.rmse, "rmse");
      if (rmse + EPS < mae) throw new ShapeProblem(`rolling_origin ${year} has RMSE below MAE`);
      return { year, rows: posInt(y.rows, "rows"), mae, rmse };
    });
    const validation = parseSplit(raw.splits.validation, "validation");
    const test = parseSplit(raw.splits.test, "test");
    if (validation.last_issue_week >= test.first_issue_week) throw new ShapeProblem("validation and test issue weeks overlap or are out of order");
    return {
      schema_version: SUPPORTED_SCHEMA,
      model_version: str(raw.model_version, "model_version"),
      error_unit: str(raw.error_unit, "error_unit"),
      prediction_basis: str(raw.prediction_basis, "prediction_basis"),
      pooled_metric_basis: str(raw.pooled_metric_basis, "pooled_metric_basis"),
      data_provenance_note: str(raw.data_provenance_note, "data_provenance_note"),
      target_window_offset_days: offsets as number[],
      splits: { validation, test },
      rolling_origin: { evaluation_scheme: str(raw.rolling_origin.evaluation_scheme, "rolling scheme"), years: rolling },
    };
  } catch (e) {
    if (e instanceof ShapeProblem) throw new ApiError("shape", `The saved evaluation file has an unexpected shape (${e.message}).`);
    throw e;
  }
}

/** A tidy axis: at most six steps, from 0 to a round maximum that covers the data. */
export function niceAxis(max: number): { top: number; step: number; ticks: number[] } {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100];
  const step = steps.find((s) => Math.ceil(max / s) <= 6) ?? 100;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, step, ticks };
}

type SplitKey = "test" | "validation";
type MetricKey = "mae" | "rmse";

export function ValidationDashboard({ issueDate, loader = fetchValidation }: { issueDate: string | null; loader?: ValidationLoader }) {
  const { t } = useI18n();
  const req = useRequest<ValidationData>("validation-errors", async (signal) => parseValidation(await loader(signal)));
  return (
    <section className="valid" aria-labelledby="valid-title" aria-busy={req.status === "loading"}>
      <div className="valid-head">
        <h2 id="valid-title">{t.vTitle}</h2>
        <p>{t.vLead}</p>
      </div>
      {(req.status === "loading" || req.status === "idle") && <LoadingPanel label={t.vLoading} />}
      {req.status === "error" && (
        <div className="status status-empty" role="status">
          <h3>{t.vMissingTitle}</h3>
          <p>{t.vMissingBody}</p>
        </div>
      )}
      {req.status === "success" && req.data && <ValidationBody data={req.data} issueDate={issueDate} />}
    </section>
  );
}

/**
 * The tooltip is anchored on its bar (a % of the plot width, like the bars and the date labels) and centred there by CSS.
 * This only slides it sideways, by a pixel offset in --tip-shift, when it would stick out of the visible chart window
 * (near either end of the chart, or on a narrow screen). It measures and writes in one go, so nothing is painted in between.
 */
function placeTip(box: HTMLElement | null) {
  const tip = box?.querySelector<HTMLElement>(".vtip");
  if (!box || !tip) return;
  tip.style.setProperty("--tip-shift", "0px");
  const view = box.getBoundingClientRect();
  const r = tip.getBoundingClientRect();
  const gap = 4;
  let shift = 0;
  if (r.right > view.right - gap) shift = view.right - gap - r.right;
  if (r.left + shift < view.left + gap) shift = view.left + gap - r.left;
  tip.style.setProperty("--tip-shift", `${Math.round(shift * 10) / 10}px`);
}

function ValidationBody({ data, issueDate }: { data: ValidationData; issueDate: string | null }) {
  const { t, num, int, date, dayMonth } = useI18n();
  const [splitKey, setSplitKey] = useState<SplitKey>("test");
  const [metric, setMetric] = useState<MetricKey>("mae");
  const [active, setActive] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const split = data.splits[splitKey];
  const weeks = split.weekly;
  const metricName = metric === "mae" ? t.vMae : t.vRmse;
  const splitName = splitKey === "test" ? t.vSplitTest : t.vSplitValidation;
  const pooled = split.pooled[metric];
  const values = weeks.map((w) => w[metric]);
  const axis = niceAxis(Math.max(pooled, ...values));
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / axis.top) * 100))}%`;
  const selectedIdx = issueDate ? weeks.findIndex((w) => w.issue_week === issueDate) : -1;
  const peakIdx = values.indexOf(Math.max(...values));
  const [o1, o2, o3] = data.target_window_offset_days as [number, number, number];
  const n = weeks.length;

  // On a narrow screen the chart scrolls sideways. Hide any date label that is only partly inside the visible
  // window, so a label is never shown cut off (for example "21 Oct 20"). It reappears as soon as it is fully in view.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const update = () => {
      const view = box.getBoundingClientRect();
      const scrolls = box.scrollWidth > box.clientWidth + 1;
      box.querySelectorAll<HTMLElement>(".vx-label").forEach((el) => {
        const r = el.getBoundingClientRect();
        el.classList.toggle("is-clipped", scrolls && (r.left < view.left - 0.5 || r.right > view.right + 0.5));
      });
    };
    const refresh = () => {
      update();
      placeTip(box);
    };
    update();
    box.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);
    return () => {
      box.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [splitKey, n, date]);

  // keep the tooltip inside the visible chart window whenever it appears or changes
  useLayoutEffect(() => {
    placeTip(scrollRef.current);
  }, [active, splitKey, metric, n, t]);

  // Hovering always happens on a visible bar. With the keyboard, the active bar can be off screen on a narrow
  // screen, so bring it into view (the minimum scroll) so the tooltip stays next to it.
  const reveal = (i: number) => {
    const box = scrollRef.current;
    const bar = box?.querySelectorAll<HTMLElement>(".vbar")[i];
    if (!box || !bar) return;
    const v = box.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    if (r.left < v.left) box.scrollLeft -= v.left - r.left + 8;
    else if (r.right > v.right) box.scrollLeft += r.right - v.right + 8;
  };

  const choose = (next: SplitKey) => {
    setSplitKey(next);
    setActive(null);
  };
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? (selectedIdx >= 0 ? selectedIdx : n - 1);
    const keys: Record<string, number> = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: n - 1, PageUp: cur - 8, PageDown: cur + 8 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = Math.min(n - 1, Math.max(0, keys[e.key] as number));
    setActive(next);
    reveal(next);
  };
  const act = active !== null ? weeks[active] : undefined;
  const sliderText = act
    ? [
        t.vSliderValue(
          splitName,
          date(act.issue_week),
          metricName,
          num(act[metric], 2),
          int(act.n),
          dayMonth(addDays(act.issue_week, o1)),
          dayMonth(addDays(act.issue_week, o2)),
          date(addDays(act.issue_week, o3)),
        ),
        active === selectedIdx ? t.vSliderSameWeek : "",
      ]
        .filter(Boolean)
        .join(" ")
    : t.vSliderIdle(int(n));

  return (
    <>
      <div className="valid-controls">
        <div className="valid-ctl" role="group" aria-label={t.vSplitLabel}>
          <span className="valid-ctl-label">{t.vSplitLabel}</span>
          <div className="seg">
            {(["test", "validation"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={splitKey === k} onClick={() => choose(k)}>
                {k === "test" ? t.vSplitTest : t.vSplitValidation}
              </button>
            ))}
          </div>
        </div>
        <div className="valid-ctl" role="group" aria-label={t.vMetricLabel}>
          <span className="valid-ctl-label">{t.vMetricLabel}</span>
          <div className="seg">
            {(["mae", "rmse"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)}>
                {k === "mae" ? t.vMae : t.vRmse}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="valid-note">{splitKey === "test" ? t.vSplitNoteTest : t.vSplitNoteValidation}</p>
      {splitKey === "validation" && (
        <p className="valid-caution" data-testid="validation-caution">
          {t.vValidationCaution}
        </p>
      )}

      <dl className="valid-tiles">
        <div className={metric === "mae" ? "is-on" : undefined}>
          <dt>{t.vPooledMae}</dt>
          <dd className="valid-num" data-testid="pooled-mae">
            {num(split.pooled.mae, 3)}
          </dd>
        </div>
        <div className={metric === "rmse" ? "is-on" : undefined}>
          <dt>{t.vPooledRmse}</dt>
          <dd className="valid-num" data-testid="pooled-rmse">
            {num(split.pooled.rmse, 3)}
          </dd>
        </div>
        <div>
          <dt>{t.vTilePeriod}</dt>
          <dd>
            {date(split.first_issue_week)} – {date(split.last_issue_week)}
          </dd>
        </div>
        <div>
          <dt>{t.vTileWeeks}</dt>
          <dd>
            <span className="valid-num">{int(split.issue_weeks)}</span>
            <span className="valid-sub">{t.vWardsEach(int(split.wards_per_week))}</span>
          </dd>
        </div>
        <div>
          <dt>{t.vTilePreds}</dt>
          <dd className="valid-num">{int(split.predictions)}</dd>
        </div>
      </dl>
      <p className="valid-help">
        {t.vMaeHelp} {t.vRmseHelp} {t.vPooledHelp}
      </p>
      <p className="valid-help">
        {t.vUnit} {t.vBasis}
      </p>

      <div className="vchart" role="group" aria-label={t.vChartAria(splitName, metricName, int(n), date(split.first_issue_week), date(split.last_issue_week))}>
        <p className="vy-title">{t.vYAxis(metricName)}</p>
        <p className="vref-key" data-testid="reference-key">
          <span className="key-dash" aria-hidden="true" />
          {t.vRefKey(metricName, num(pooled, 3))}
        </p>
        <div className="vchart-grid">
          <div className="vchart-y" aria-hidden="true">
            <div className="vy-plot">
              {axis.ticks.map((v) => (
                <span key={v} className="y-tick" style={{ bottom: pct(v) }}>
                  {num(v, axis.step < 1 ? 1 : 0)}
                </span>
              ))}
            </div>
          </div>
          <div className="vchart-scroll" ref={scrollRef}>
            <div className="vchart-body" style={{ minWidth: `${n * COL_W}px` }}>
              <div className="vgrid" aria-hidden="true">
                {axis.ticks.map((v) => (
                  <span key={v} className="grid-line" style={{ bottom: pct(v) }} />
                ))}
                <span className="vref" style={{ bottom: pct(pooled) }} />
              </div>
              <div
                className="vbars"
                role="slider"
                tabIndex={0}
                aria-label={`${t.vChartAria(splitName, metricName, int(n), date(split.first_issue_week), date(split.last_issue_week))}. ${t.vSliderHint}`}
                aria-describedby="vchart-desc"
                aria-orientation="horizontal"
                aria-valuemin={1}
                aria-valuemax={n}
                aria-valuenow={(active ?? (selectedIdx >= 0 ? selectedIdx : n - 1)) + 1}
                aria-valuetext={sliderText}
                onKeyDown={move}
                onFocus={() => {
                  const i = active ?? (selectedIdx >= 0 ? selectedIdx : n - 1);
                  setActive(i);
                  reveal(i);
                }}
                onBlur={() => setActive(null)}
                onMouseLeave={() => setActive(null)}
              >
                {weeks.map((w, i) => (
                  <div
                    key={w.issue_week}
                    className={`vbar${i === selectedIdx ? " is-selected" : ""}${i === active ? " is-active" : ""}`}
                    data-week={w.issue_week}
                    onMouseMove={() => setActive(i)}
                    onClick={() => setActive(i)}
                  >
                    <span className="vbar-col" style={{ height: pct(w[metric]) }}>
                      {i === selectedIdx && (
                        <span className="vbar-mark" aria-hidden="true">
                          ▼
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              {act && active !== null && (
                <div
                  className="vtip"
                  style={{ left: `${((active + 0.5) / n) * 100}%` }}
                  role="presentation"
                  data-testid="validation-tooltip"
                >
                  <strong>{t.vTipHeader(date(act.issue_week))}</strong>
                  <span>{t.vTipLine(splitName, metricName, num(act[metric], 2))}</span>
                  <span>{t.vTipWards(int(act.n))}</span>
                  <span>
                    {t.vTipTarget(dayMonth(addDays(act.issue_week, o1)), dayMonth(addDays(act.issue_week, o2)), date(addDays(act.issue_week, o3)))}
                  </span>
                </div>
              )}
              <div className="vx" aria-hidden="true">
                {weeks.map((w, i) =>
                  i % LABEL_EVERY === 0 && n - i >= LABEL_COLS ? (
                    <span key={w.issue_week} className="vx-label" style={{ left: `${(i / n) * 100}%` }}>
                      {date(w.issue_week)}
                    </span>
                  ) : null,
                )}
              </div>
              <p className="x-title">{t.vXAxis}</p>
            </div>
          </div>
        </div>
        <p id="vchart-desc" className="sr-only">
          {t.vChartDesc(num(pooled, 3), num(values[peakIdx] ?? 0, 2), date(weeks[peakIdx]?.issue_week ?? split.first_issue_week))}
        </p>
        {selectedIdx >= 0 && (
          <ul className="vlegend">
            <li>{t.vLegendSelected}</li>
          </ul>
        )}
        {selectedIdx < 0 && issueDate && <p className="valid-note">{t.vNotInSplit}</p>}
        <p className="valid-note">{t.vSelectionNote}</p>
      </div>

      <details className="tech">
        <summary>{t.vTableSummary}</summary>
        <div className="valid-table-wrap">
          <table className="valid-table">
            <caption className="sr-only">{t.vChartAria(splitName, metricName, int(n), date(split.first_issue_week), date(split.last_issue_week))}</caption>
            <thead>
              <tr>
                <th scope="col">{t.vThWeek}</th>
                <th scope="col" className="num">
                  {t.vThMae}
                </th>
                <th scope="col" className="num">
                  {t.vThRmse}
                </th>
                <th scope="col" className="num">
                  {t.vThWards}
                </th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.issue_week}>
                  <th scope="row">{date(w.issue_week)}</th>
                  <td className="num">{num(w.mae, 2)}</td>
                  <td className="num">{num(w.rmse, 2)}</td>
                  <td className="num">{int(w.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="roll" aria-labelledby="roll-title">
        <h3 id="roll-title">{t.vRollTitle}</h3>
        <p>{t.vRollLead}</p>
        <table className="valid-table">
          <caption className="sr-only">{t.vRollCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{t.vRollYear}</th>
              <th scope="col" className="num">
                {t.vThMae}
              </th>
              <th scope="col" className="num">
                {t.vThRmse}
              </th>
              <th scope="col" className="num">
                {t.vRollRows}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rolling_origin.years.map((y) => (
              <tr key={y.year}>
                <th scope="row">{int(y.year).replace(/,/g, "")}</th>
                <td className="num">{num(y.mae, 2)}</td>
                <td className="num">{num(y.rmse, 2)}</td>
                <td className="num">{int(y.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="valid-notes">
        <h3>{t.vNotesTitle}</h3>
        <ul className="m-limits">
          {t.vNotes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    </>
  );
}
