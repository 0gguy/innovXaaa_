import type { Meta } from "../api/types";
import { formatDate } from "../lib/dates";

/** Facts come from /meta where the API provides them, otherwise from ml/model_config.json and ml/integration_guide.md. */
export function Methodology({ meta }: { meta: Meta | null }) {
  const edges = meta?.risk_tiers.edges;
  const threshold = meta?.early_alert.threshold ?? 25;
  return (
    <section className="method" aria-labelledby="method-title">
      <h2 id="method-title">How to read this, and what it can't tell you</h2>
      <div className="method-grid">
        <div>
          <h3>What the model does</h3>
          <p>
            A gradient-boosted regression model (XGBoost) estimates the combined number of dengue cases a ward will
            record in weeks +2, +3 and +4 after an issue week. It produces one number for those three weeks together.
          </p>
          <p>
            Inputs are that week's weather, rainfall, temperature and humidity from the previous four weeks, recent
            dengue case counts, ward vulnerability measures (population density, water-logging, sanitation) and the
            season.
          </p>
        </div>
        <div>
          <h3>The data window</h3>
          <p>
            The bundled records run weekly from 4 Jan 2016 to 29 Dec 2025 for {meta?.ward_count ?? 60} wards in five city
            corporations.
            {meta && (
              <>
                {" "}
                Forecasts can be replayed for issue weeks from {formatDate(meta.valid_issue_weeks.first)} to{" "}
                {formatDate(meta.valid_issue_weeks.last)}.
              </>
            )}{" "}
            Nothing after 2025 is predicted.
          </p>
          <p>
            Weeks marked "observed later" are recorded outcomes shown for comparison. The model never sees them as
            inputs.
          </p>
        </div>
        <div>
          <h3>Tiers and the early alert</h3>
          <p>
            Risk tiers are provisional categories on predicted combined cases
            {edges && edges.length === 3
              ? `: Low below ${edges[0]}, Medium from ${edges[0]} to below ${edges[1]}, High from ${edges[1]} to below ${edges[2]}, Critical from ${edges[2]}.`
              : "."}{" "}
            They are not clinical or official public-health thresholds.
          </p>
          <p>
            The early alert is raised when predicted combined cases are above {threshold}. That cut-off was chosen for the
            best validation F1 when detecting observed totals above 30.
          </p>
        </div>
        <div>
          <h3>Limits to keep in mind</h3>
          <p>
            Predictions are estimates. On the project's held-out test set (4,620 ward-weeks, issue weeks 17 Jun 2024 to
            1 Dec 2025) the early alert fired 649 times. In 232 of those the observed three-week total was above 30; in
            the other 417 it was not. It also missed 36 of the 268 ward-weeks whose observed total was above 30.
          </p>
          <p>
            In that test period the model over-forecast June (by 4.3 cases on average) and September (by 3.5), and the
            project notes say it under-forecasts the largest outbreaks. The organizer data's provenance is uncertain
            and appears simulated, so treat this as a prototype demonstration.
          </p>
          <p>
            The "what shaped this estimate" bars are model attributions (TreeSHAP). They show how the model reached its
            number, not what causes dengue.
          </p>
        </div>
      </div>
      <p className="method-foot">
        {meta ? meta.notice : "Historical replay, not a live warning system."} Model version{" "}
        {meta ? meta.model_version : "unknown"}.
      </p>
    </section>
  );
}
