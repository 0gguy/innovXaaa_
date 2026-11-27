// Types mirror the actual FastAPI responses (backend/app/main.py) and the ML result
// object (ml/predict.py Forecaster._result). Classification stays in the backend.

export type RiskTier = "Low" | "Medium" | "High" | "Critical";
export const TIER_ORDER: readonly RiskTier[] = ["Low", "Medium", "High", "Critical"];

export interface CityMeta {
  city: string;
  ward_count: number;
  wards: string[];
}

export interface WardMeta {
  ward_id: string;
  city: string;
}

export interface Meta {
  mode: string;
  notice: string;
  model_version: string;
  cities: CityMeta[];
  wards: WardMeta[];
  ward_count: number;
  valid_issue_weeks: {
    first: string;
    last: string;
    weekday: string;
    actuals_available_until_issue_week: string;
  };
  horizon_weeks: number[];
  risk_tiers: { labels: RiskTier[]; edges: number[]; rule: string };
  early_alert: { threshold: number; rule: string };
  /** Task 1 weekly companion status. Optional: older /meta responses do not include it. */
  weekly_companion?: WeeklyCompanionMeta;
}

// ---------------------------------------------------------------- Phase 2, Task 1: weekly split
/** "companion": the weekly model; "equal_split": fallback, t/3 per week. */
export type WeeklySource = "companion" | "equal_split";
export const WEEKLY_SOURCES: readonly WeeklySource[] = ["companion", "equal_split"];

export interface WeeklyCompanionMeta {
  available: boolean;
  source: WeeklySource;
  model_version: string | null;
  fallback_reason: string | null;
  horizon_weeks: number[];
  reconciled_to: string;
}

export interface WeeklyValue {
  horizon_week: number;
  forecast_week: string;
  predicted_cases: number;
}

/** Split of predicted_cases_3wk into t+2, t+3, t+4. Never changes the total, tier or alert. */
export interface WeeklyForecast {
  source: WeeklySource;
  model_version: string | null;
  fallback_reason: string | null;
  reconciled_to: string;
  weeks: WeeklyValue[];
  note: string;
}

export interface DriverGroup {
  group: string;
  contribution: number;
}

export interface Drivers {
  baseline: number;
  groups: DriverGroup[];
  note: string;
}

export interface Observed {
  available: boolean;
  actual_cases_3wk: number | null;
  actual_risk_tier: RiskTier | null;
  note: string;
}

export interface Forecast {
  ward_id: string;
  city: string;
  issue_week: string;
  horizon_weeks: number[];
  forecast_weeks: string[];
  predicted_cases_3wk: number;
  risk_tier: RiskTier;
  early_alert: boolean;
  raw_model_output: number;
  model_version: string;
  data_source: string;
  warnings: string[];
  drivers: Drivers | null; // null when drivers were not requested or not reproducible
  actual: Observed | null; // observed outcome, for historical comparison only
  weekly?: WeeklyForecast; // present only when requested with include_weekly=true
}

export interface WardForecastResponse {
  mode: string;
  notice: string;
  forecast: Forecast;
}

export interface AllForecastsResponse {
  mode: string;
  notice: string;
  issue_date: string;
  count: number;
  forecasts: Forecast[];
}

// Static validation-error data exported by ml/tools/export_validation_errors.py
// (frontend/public/validation/weekly_errors.json). Computed from saved, clipped predictions.
export interface ValidationWeek {
  issue_week: string;
  mae: number;
  rmse: number;
  n: number;
}

export interface ValidationSplit {
  evaluation_scheme: string;
  first_issue_week: string;
  last_issue_week: string;
  issue_weeks: number;
  predictions: number;
  wards_per_week: number;
  pooled: { mae: number; rmse: number };
  weekly: ValidationWeek[];
}

export interface RollingYear {
  year: number;
  rows: number;
  mae: number;
  rmse: number;
}

export interface ValidationData {
  schema_version: number;
  model_version: string;
  error_unit: string;
  prediction_basis: string;
  pooled_metric_basis: string;
  data_provenance_note: string;
  target_window_offset_days: number[];
  splits: { validation: ValidationSplit; test: ValidationSplit };
  rolling_origin: { evaluation_scheme: string; years: RollingYear[] };
}

// ================================================================ Phase 2 planning (backend/app/planning)
// Every planning figure below is DERIVED from the model forecast under HYPOTHETICAL scenario inputs
// (stock, crews, bed capacity) or ASSUMED intervention effects. None is an observed inventory, a real
// transfer or an established effect. The frontend shows these values; it never recalculates them.

export interface ReplayEnvelope {
  mode: string;
  notice: string;
  issue_date: string;
  model_version: string;
}

export interface PlanningPolicy {
  name: string;
  description: string;
}

// ---------------------------------------------------------------- Task 2: GET /allocation
export interface AllocationQuery {
  issue_date?: string;
  stock_pct?: number;
  stock_pct_saline?: number;
  stock_pct_kits?: number;
  min_coverage_pct?: number;
  total_crews?: number;
}

export type AllocationSeverity = "no_deficit" | "below_floor" | "partial";
export type AllocationReason = "no_demand" | "fulfilled" | "below_floor" | "floor_only" | "partial_priority" | "not_reached";

/** City or region totals for one consumable, in planning units (not verified inventory). */
export interface ResourceSummary {
  demand: number;
  stock: number;
  allocated: number;
  deficit: number;
  unallocated: number;
  coverage_pct: number | null; // null when demand is 0
  wards_with_deficit: number;
  wards_below_floor: number;
}

export interface CrewSummary {
  scenario_demand: number;
  pool: number;
  assigned: number;
  scenario_deficit: number;
  coverage_pct: number | null;
  wards_with_scenario_deficit: number;
  wards_below_floor: number;
}

export interface RegionCrewSummary extends CrewSummary {
  total_crews: number;
  unassigned: number;
}

export interface BedPlanningSummary {
  planning_demand: number;
  capacity_and_routing: string;
}

export interface WardResourceAllocation {
  demand: number;
  floor: number;
  allocated: number;
  deficit: number;
  coverage_pct: number | null;
  critical_deficit: boolean;
  severity: AllocationSeverity;
  reason: AllocationReason;
}

export interface WardCrewAllocation {
  scenario_demand: number;
  floor: number;
  assigned: number;
  scenario_deficit: number;
  coverage_pct: number | null;
  scenario_crew_deficit: boolean;
  severity: AllocationSeverity;
  reason: AllocationReason;
}

export interface AllocationWard {
  ward_id: string;
  city: string;
  priority_rank_in_city: number;
  priority: { risk_tier: RiskTier; early_alert: boolean; population_density_sqkm: number; predicted_cases_3wk: number };
  saline: WardResourceAllocation;
  kits: WardResourceAllocation;
  crews: WardCrewAllocation;
  bed_plan: {
    peak_forecast_week: string;
    peak_horizon_week: number;
    peak_week_expected_cases: number;
    bed_planning_demand: number;
    weekly_source: WeeklySource;
  };
  exceeds_observed_range: boolean;
}

export interface AllocationCity {
  city: string;
  ward_count: number;
  saline: ResourceSummary;
  kits: ResourceSummary;
  crews: CrewSummary;
  beds: BedPlanningSummary;
}

export interface AllocationResponse extends ReplayEnvelope {
  policy: PlanningPolicy;
  parameters: {
    stock_pct: { saline: number; kits: number };
    min_coverage_pct: number;
    total_crews: number;
    rounding: string;
    coefficients: Record<string, string>;
    crew_rule: { eligible_tiers: RiskTier[]; density_per_crew_sqkm: number; max_crews_per_ward: number; status: string };
    priority_key: string[];
  };
  weekly_source: WeeklySource;
  assumptions: string[];
  limitations: string[];
  region: { saline: ResourceSummary; kits: ResourceSummary; crews: RegionCrewSummary; beds: BedPlanningSummary };
  cities: AllocationCity[];
  wards: AllocationWard[];
}

// ---------------------------------------------------------------- Task 3: GET /hospital-routing
export interface HospitalRoutingQuery {
  issue_date?: string;
  capacity_pct?: number;
}

/** Bed PLANNING UNITS per forecast week against HYPOTHETICAL capacity (not patients, not real beds). */
export interface HospitalWeekSummary {
  hypothetical_capacity: number;
  bed_planning_demand: number;
  locally_assigned: number;
  transfer_units: number;
  transfer_edges: number;
  sending_wards: number;
  receiving_wards: number;
  occupied_after_routing: number;
  unmet_after_routing: number;
  spare_after_routing: number;
  wards_with_unmet: number;
  utilization_pct: number | null;
  demand_to_capacity_pct: number | null;
  utilization_status: "ok" | "no_capacity";
}

export interface HospitalCityWeek extends HospitalWeekSummary {
  city: string;
}

/** A SIMULATED within-city reassignment of planning units; never a real patient transfer. */
export interface SimulatedTransfer {
  city: string;
  horizon_week: number;
  forecast_week: string;
  from_ward: string;
  to_ward: string;
  units: number;
}

export interface HospitalWeek {
  horizon_week: number;
  forecast_week: string;
  region: HospitalWeekSummary;
  cities: HospitalCityWeek[];
  transfers: SimulatedTransfer[];
}

export interface HospitalWardWeek {
  horizon_week: number;
  forecast_week: string;
  bed_planning_demand: number;
  locally_assigned: number;
  transferred_out: number;
  transferred_in: number;
  unmet_after_routing: number;
  occupied_after_routing: number;
  spare_after_routing: number;
}

export interface HospitalWard {
  ward_id: string;
  city: string;
  priority_rank_in_city: number;
  risk_tier: RiskTier;
  hypothetical_capacity: number;
  max_weekly_bed_planning_demand: number;
  weeks: HospitalWardWeek[];
}

export interface HospitalRoutingResponse extends ReplayEnvelope {
  policy: PlanningPolicy;
  parameters: {
    capacity_pct: number;
    capacity_rule: string;
    city_baseline_beds: Record<string, number>;
    baseline_definition: string;
    baseline_years: number[];
    baseline_status: string;
    bed_coefficient: string;
    rounding: string;
    units: string;
    connectivity: string;
    sender_rule: string;
    receiver_rule: string;
  };
  weekly_source: WeeklySource;
  assumptions: string[];
  limitations: string[];
  warnings: string[];
  capacity: {
    cities: { city: string; ward_count: number; baseline: number; hypothetical_capacity: number }[];
    region_hypothetical_capacity: number;
  };
  weeks: HospitalWeek[];
  headline_week_by_city: Record<string, { horizon_week: number; forecast_week: string }>;
  wards: HospitalWard[];
}

// ---------------------------------------------------------------- Task 4: GET /intervention-simulation
export type InterventionScenario = "low" | "base" | "high";
export const INTERVENTION_SCENARIOS: readonly InterventionScenario[] = ["low", "base", "high"];

export interface InterventionQuery {
  issue_date?: string;
  total_crews?: number;
  min_coverage_pct?: number;
  include_roi_alternative?: boolean;
}

export interface UnitsImpact {
  baseline_units: number;
  scenario_adjusted_units: number;
  projected_units_avoided: number;
}

export interface WeeklyBedImpact {
  horizon_week: number;
  forecast_week: string;
  baseline: number;
  scenario_adjusted: number;
  projected_units_avoided: number;
}

/** Totals under an ASSUMED effect size. "Projected cases avoided" is scenario arithmetic, not an outcome. */
export interface InterventionTotals {
  baseline_cases_3wk: number;
  scenario_adjusted_cases_3wk: number;
  projected_cases_avoided: number;
  assigned_crews: number;
  projected_cases_avoided_per_assigned_crew: number | null; // null when no crews are assigned
  saline: UnitsImpact;
  kits: UnitsImpact;
  weekly_bed_planning_units: WeeklyBedImpact[];
  sum_of_ward_peak_bed_planning_reductions: number;
}

export interface InterventionScenarioResult {
  max_reduction: number;
  region: InterventionTotals;
  cities: (InterventionTotals & { city: string })[];
}

export interface InterventionWardScenario {
  effective_reduction_by_week: number[];
  scenario_adjusted_weekly_cases: number[];
  projected_cases_avoided: number;
  projected_cases_avoided_per_assigned_crew: number | null;
  saline: { scenario_adjusted_units: number; projected_units_avoided: number };
  kits: { scenario_adjusted_units: number; projected_units_avoided: number };
  weekly_bed_planning_units: { scenario_adjusted: number[]; projected_units_avoided: number[] };
  peak_bed_planning_units: { scenario_adjusted: number; projected_reduction: number };
}

export interface InterventionWard {
  ward_id: string;
  city: string;
  priority_rank_in_city: number;
  risk_tier: RiskTier;
  early_alert: boolean;
  population_density_sqkm: number;
  predicted_cases_3wk: number;
  baseline_weekly_cases: number[];
  baseline_planning_units: { saline: number; kits: number; weekly_bed_planning_units: number[]; peak_bed_planning_units: number };
  crews: {
    scenario_demand: number;
    assigned: number;
    coverage: number;
    next_crew_status: "ineligible" | "at_cap" | "available";
    next_crew_projected_cases_avoided_base: number | null;
  };
  scenarios: Record<InterventionScenario, InterventionWardScenario>;
}

export interface FirstCrewRank {
  rank: number;
  ward_id: string;
  city: string;
  first_crew_projected_cases_avoided: number;
  assigned_crews: number;
}

export interface RoiComparison {
  primary_projected_cases_avoided: number;
  alternative_projected_cases_avoided: number;
  difference: number;
  difference_pct: number | null;
}

/** Optional HYPOTHETICAL ROI-greedy crew assignment, for comparison only. */
export interface RoiAlternative {
  status: string;
  objective: string;
  ranking_scenario: InterventionScenario;
  city_pools: Record<string, number>;
  assigned_crews: number;
  wards: { ward_id: string; city: string; primary_crews: number; alternative_crews: number }[];
  comparison: Record<InterventionScenario, { region: RoiComparison; cities: (RoiComparison & { city: string })[] }>;
}

export interface InterventionResponse extends ReplayEnvelope {
  policy: {
    name: string;
    /** Always false: effect sizes are assumed scenarios, not learned or causal estimates. */
    causal: false;
    effect_size_basis: string;
    crew_capacity_status: string;
    crew_assignment_source: string;
    timing: string;
    description: string;
  };
  parameters: {
    scenarios: Record<InterventionScenario, number>;
    saturation_k: number;
    density_per_crew_sqkm: number;
    max_crews_per_ward: number;
    ramp_by_horizon_week: Record<string, number>;
    total_crews: number;
    min_coverage_pct: number;
    include_roi_alternative: boolean;
    roi_definition: string;
  };
  weekly_source: WeeklySource;
  forecast_weeks: string[];
  assumptions: string[];
  limitations: string[];
  warnings: string[];
  crews: { total_crews: number; scenario_demand: number; assigned: number; unassigned: number; city_pools: Record<string, number> };
  scenarios: Record<InterventionScenario, InterventionScenarioResult>;
  wards: InterventionWard[];
  first_crew_ranking: FirstCrewRank[];
  roi_alternative: RoiAlternative | null;
}

// ---------------------------------------------------------------- Task 5: GET /dispatch-brief
export type DispatchScope = "city" | "ward";
export type DispatchAudience = "resource" | "hospital" | "all";
export type DispatchVariant = "short" | "detailed";
export type DispatchDocumentFormat = "text" | "html";
export type DispatchSectionKey =
  | "forecast_estimates"
  | "resource_plan"
  | "crew_scenario"
  | "hospital_overflow"
  | "intervention_scenario";
export const DISPATCH_SECTION_KEYS: readonly DispatchSectionKey[] = [
  "forecast_estimates",
  "resource_plan",
  "crew_scenario",
  "hospital_overflow",
  "intervention_scenario",
];

/** Query for GET /dispatch-brief. `format` is set by the client method, never by the caller. */
export interface DispatchQuery {
  scope: DispatchScope;
  city?: string;
  ward_id?: string;
  issue_date?: string;
  audience?: DispatchAudience;
  variant?: DispatchVariant;
  stock_pct?: number;
  min_coverage_pct?: number;
  total_crews?: number;
  capacity_pct?: number;
  intervention_scenario?: InterventionScenario;
  download?: boolean;
}

/** Machine-readable draft status. The values are fixed by the backend: nothing is ever sent. */
export interface DispatchStatus {
  draft: true;
  sent: false;
  authorised: false;
  simulated: true;
  historical_replay: true;
  human_verification_required: true;
  dispatch_capability: "none";
  labels: string[];
  statement: string;
}

/** A brief section: validated label and safety fields, other planning fields kept as sent. */
export type DispatchSection = { label: string } & Record<string, unknown>;

export interface DispatchBriefResponse {
  mode: string;
  notice: string;
  brief_version: string;
  status: DispatchStatus;
  scenario_id: string;
  document_id: string;
  scenario_fingerprint: string;
  scope: { type: DispatchScope; city: string; ward_id: string | null; display_name: string; ward_count?: number };
  audience: DispatchAudience;
  variant: DispatchVariant;
  intended_role: string;
  scenario: {
    issue_week: string;
    forecast_weeks: string[];
    horizon_weeks: number[];
    model_version: string;
    weekly_source: WeeklySource;
    weekly_model_version: string | null;
    parameters: {
      stock_pct: number;
      min_coverage_pct: number;
      total_crews: number;
      capacity_pct: number;
      intervention_scenario: InterventionScenario;
    };
    notice: string;
  };
  sections_included: DispatchSectionKey[];
  sections: Partial<Record<DispatchSectionKey, DispatchSection>>;
  verification_checklist: string[];
  warnings: string[];
  assumptions: string[];
  limitations: string[];
}

/** A text or printable-HTML brief, returned as an inert string. It is never parsed or inserted into the app. */
export interface DispatchDocument {
  format: DispatchDocumentFormat;
  body: string;
  contentType: string;
  /** From Content-Disposition when the browser exposes it (cross-origin CORS usually does not); else null. */
  filename: string | null;
}
