import type { Drivers } from "../api/types";
import { cases, signed } from "../lib/format";

/**
 * Diverging bars of the model's own attribution groups (values straight from the API).
 * Right of the axis raises the estimate, left lowers it. These describe how the model
 * reached its number; they are not causes of dengue.
 */
export function DriversChart({ drivers }: { drivers: Drivers | null }) {
  if (!drivers || drivers.groups.length === 0) {
    return (
      <div className="drivers">
        <h3>What shaped this estimate</h3>
        <p className="drivers-empty">The backend did not return driver details for this forecast.</p>
      </div>
    );
  }
  const max = Math.max(...drivers.groups.map((g) => Math.abs(g.contribution)), 0.001);
  return (
    <div className="drivers">
      <h3>What shaped this estimate</h3>
      <p className="drivers-lead">
        Contribution of each input group to the model's number, in cases, starting from a baseline of{" "}
        {cases(drivers.baseline)}.
      </p>
      <ul className="driver-list">
        {drivers.groups.map((g) => {
          const pct = (Math.abs(g.contribution) / max) * 100;
          const up = g.contribution >= 0;
          return (
            <li key={g.group} className="driver-row">
              <span className="driver-name">{g.group}</span>
              <span className="driver-track" aria-hidden="true">
                <span className="driver-axis" />
                <span
                  className={`driver-bar ${up ? "driver-up" : "driver-down"}`}
                  style={{ width: `${pct / 2}%` }}
                />
              </span>
              <span className="driver-val">
                {signed(g.contribution)}
                <span className="sr-only">{up ? " raises the estimate" : " lowers the estimate"}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="driver-legend" aria-hidden="true">
        <span>
          <i className="swatch swatch-down" /> lowers the estimate
        </span>
        <span>
          <i className="swatch swatch-up" /> raises the estimate
        </span>
      </div>
      {drivers.note && <p className="drivers-note">{drivers.note}</p>}
    </div>
  );
}
