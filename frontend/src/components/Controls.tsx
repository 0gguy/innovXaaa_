import type { Meta } from "../api/types";
import { formatDate, weeksBetween, yearOf } from "../lib/dates";
import { wardLabel } from "../lib/format";

export interface Selection {
  city: string;
  ward: string;
  date: string;
}

interface Props {
  meta: Meta;
  value: Selection;
  onChange: (next: Selection) => void;
  busy: boolean;
}

export function Controls({ meta, value, onChange, busy }: Props) {
  const weeks = weeksBetween(meta.valid_issue_weeks.first, meta.valid_issue_weeks.last);
  const years = [...new Set(weeks.map(yearOf))];
  const year = yearOf(value.date);
  const weeksInYear = weeks.filter((w) => yearOf(w) === year);
  const index = weeks.indexOf(value.date);
  const cityWards = meta.cities.find((c) => c.city === value.city)?.wards ?? [];

  const setCity = (city: string) => {
    const first = meta.cities.find((c) => c.city === city)?.wards[0];
    if (first) onChange({ ...value, city, ward: first });
  };
  const setYear = (y: number) => {
    // keep the same week-of-year position where possible, else the nearest valid week
    const pool = weeks.filter((w) => yearOf(w) === y);
    const same = Math.min(weeksInYear.indexOf(value.date), pool.length - 1);
    const next = pool[Math.max(0, same)];
    if (next) onChange({ ...value, date: next });
  };
  const step = (delta: number) => {
    const next = weeks[index + delta];
    if (next) onChange({ ...value, date: next });
  };

  return (
    <form className="controls" aria-label="Choose city, ward and issue week" onSubmit={(e) => e.preventDefault()}>
      <div className="field">
        <label htmlFor="city">City corporation</label>
        <select id="city" value={value.city} onChange={(e) => setCity(e.target.value)}>
          {meta.cities.map((c) => (
            <option key={c.city} value={c.city}>
              {c.city} ({c.ward_count} wards)
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ward">Ward</label>
        <select id="ward" value={value.ward} onChange={(e) => onChange({ ...value, ward: e.target.value })}>
          {cityWards.map((w) => (
            <option key={w} value={w}>
              {wardLabel(w)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="field field-week">
        <legend>Historical issue week (Mondays)</legend>
        <div className="week-row">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => step(-1)}
            disabled={index <= 0}
            aria-label="Previous week"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <label className="sr-only" htmlFor="year">
            Year
          </label>
          <select id="year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="week">
            Week
          </label>
          <select id="week" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })}>
            {weeksInYear.map((w) => (
              <option key={w} value={w}>
                Week of {formatDate(w).replace(/ \d{4}$/, "")}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => step(1)}
            disabled={index < 0 || index >= weeks.length - 1}
            aria-label="Next week"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </fieldset>
      <p className="controls-status" role="status" aria-live="polite">
        {busy ? "Updating forecasts…" : "Forecasts up to date"}
      </p>
    </form>
  );
}
