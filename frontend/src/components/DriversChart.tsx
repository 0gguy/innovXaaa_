import type { Drivers } from "../api/types";
import { useI18n } from "../i18n/I18n";

/**
 * Plain-language view of the model's own attribution groups (values straight from the API).
 * Groups that raised the estimate and groups that lowered it are listed apart, largest first.
 * These describe how the model reached its number; they are not causes of dengue.
 */
export function DriversChart({ drivers, predicted, raw }: { drivers: Drivers | null; predicted: number; raw: number }) {
  const { t, lang, num, signed } = useI18n();
  if (!drivers || drivers.groups.length === 0) {
    return (
      <div className="drivers">
        <h3>{t.driversTitle}</h3>
        <p className="drivers-empty">{t.driversEmpty}</p>
      </div>
    );
  }
  const groups = drivers.groups;
  const max = Math.max(...groups.map((g) => Math.abs(g.contribution)), 0.001);
  const up = groups.filter((g) => g.contribution >= 0).sort((a, b) => b.contribution - a.contribution);
  const down = groups.filter((g) => g.contribution < 0).sort((a, b) => a.contribution - b.contribution);
  const sumUp = up.reduce((s, g) => s + g.contribution, 0);
  const sumDown = down.reduce((s, g) => s + g.contribution, 0);
  // Only show the arithmetic line when the groups really add up to the model output.
  const adds = Math.abs(drivers.baseline + sumUp + sumDown - raw) < 0.05 && Math.abs(raw - predicted) < 0.05;

  const row = (g: { group: string; contribution: number }) => {
    const isUp = g.contribution >= 0;
    const known = g.group in t.group;
    return (
      <li key={g.group} className="driver-row">
        <span className="driver-name">{known ? t.group[g.group] : g.group}</span>
        <span className="driver-val">
          {signed(g.contribution)}
          <span className="sr-only"> {isUp ? t.driversRaises : t.driversLowers}</span>
        </span>
        <span className="driver-track" aria-hidden="true">
          <span
            className={`driver-bar ${isUp ? "driver-up" : "driver-down"}`}
            style={{ width: `${(Math.abs(g.contribution) / max) * 100}%` }}
          />
        </span>
        {known && <span className="driver-help">{t.groupHelp[g.group]}</span>}
      </li>
    );
  };

  return (
    <div className="drivers">
      <h3>{t.driversTitle}</h3>
      <p className="drivers-lead">{t.driversLead(num(drivers.baseline))}</p>
      {adds && (
        <p className="drivers-eq">{t.driversEq(num(drivers.baseline), num(sumUp), num(Math.abs(sumDown)), num(predicted))}</p>
      )}
      <section className="driver-block driver-block-up" aria-label={t.driversUp}>
        <h4>
          <span className="driver-arrow" aria-hidden="true">
            ▲
          </span>{" "}
          {t.driversUp}
        </h4>
        {up.length > 0 ? <ul className="driver-list">{up.map(row)}</ul> : <p className="drivers-empty">{t.driversNoneUp}</p>}
      </section>
      <section className="driver-block driver-block-down" aria-label={t.driversDown}>
        <h4>
          <span className="driver-arrow" aria-hidden="true">
            ▼
          </span>{" "}
          {t.driversDown}
        </h4>
        {down.length > 0 ? <ul className="driver-list">{down.map(row)}</ul> : <p className="drivers-empty">{t.driversNone}</p>}
      </section>
      <p className="drivers-note">{t.driversCaution}</p>
      <details className="tech">
        <summary>{t.driversTech}</summary>
        <p>{t.driversTechBody(num(raw, 2), num(drivers.baseline, 2))}</p>
        <p lang={lang === "bn" ? "en" : undefined}>{drivers.note}</p>
      </details>
    </div>
  );
}
