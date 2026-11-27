"""Planning parameters and their provenance. Values here are planning conventions, not clinical
guidelines and not verified municipal inventories."""
from decimal import Decimal

# --------------------------------------------------------------------------- demand coefficients
# In the onsite dataset every row satisfies  column = floor(k * dengue_cases + 1/2)  (ROUND_HALF_UP)
# for ANY k inside these intervals (31,320 / 31,320 rows), so k is not uniquely identified.
# The values used are representative points inside the intervals.
COEFFICIENTS = {
    "saline": Decimal("2.38485"),  # saline_bags_needed      k in [143/60, 105/44) = [2.38333, 2.38636)
    "kits": Decimal("1.16422"),    # diagnostic_kits_needed  k in [79/68, 7/6)     = [1.16176, 1.16667)
    "beds": Decimal("0.29844"),    # hospital_beds_required  k in [19/64, 3/10)    = [0.296875, 0.3)
}
COEFFICIENT_INTERVALS = {
    "saline": ("143/60", "105/44"),
    "kits": ("79/68", "7/6"),
    "beds": ("19/64", "3/10"),
}
ROUNDING = "ROUND_HALF_UP"

# Largest 3-week ward total observed in the onsite data (dengue_cases summed over 3 consecutive
# weeks). Forecasts above it are converted normally (never capped) but flagged.
MAX_OBSERVED_3WK_CASES = 92
# Sanity bound for internal forecast values; anything above is treated as corrupt input.
MAX_VALID_CASES = Decimal(1_000_000)

# --------------------------------------------------------------------------- stock scenario
STOCK_PCT_MIN, STOCK_PCT_MAX, STOCK_PCT_DEFAULT = 30, 100, 100
MIN_COVERAGE_PCT_MIN, MIN_COVERAGE_PCT_MAX, MIN_COVERAGE_PCT_DEFAULT = 0, 50, 30

# --------------------------------------------------------------------------- crews (scenario)
# HYPOTHETICAL. The data contain no crew requirements, availability or fleet sizes.
CREW_DENSITY_PER_CREW = 12_000       # persons/km2 per crew: workload proxy, not a staffing standard
CREW_MAX_PER_WARD = 6                # same cap as the reviewed simulator parameters
CREW_ELIGIBLE_TIERS = ("Medium", "High", "Critical")
TOTAL_CREWS_DEFAULT = 60             # hypothetical regional budget (about one crew per ward)
TOTAL_CREWS_MAX = 10_000             # input bound only

# --------------------------------------------------------------------------- risk
TIER_RANK = {"Low": 0, "Medium": 1, "High": 2, "Critical": 3}   # Phase 1 tiers, higher = more urgent
CITIES = ("Chattogram", "Dhaka North", "Dhaka South", "Gazipur", "Narayanganj")
PRIORITY_KEY = [
    "risk_tier (Critical > High > Medium > Low)",
    "early_alert (true first)",
    "population_density_sqkm (higher first)",
    "predicted_cases_3wk (higher first)",
    "ward_id (ascending)",
]

POLICY = {
    "name": "minimum_coverage_then_risk_priority",
    "description": (
        "Deterministic, fairness-first greedy allocation. Stage 1: units go one at a time to the ward "
        "with the lowest coverage (allocated/demand) among wards below their floor "
        "ceil(min_coverage_pct * demand / 100); ties go to the higher-priority ward. Stage 2: remaining "
        "units fill wards in strict priority order. Not a clinical or welfare optimum."
    ),
}

ASSUMPTIONS = [
    "100% stock means 100% of forecast planning demand in each city, not verified municipal inventory.",
    "Stock is pooled per city corporation and per resource; no transfers between cities.",
    "Saline and kit demand = ROUND_HALF_UP(coefficient x predicted 3-week cases), rounded once per ward.",
    "Coefficients are dataset-derived planning conventions (any value in a narrow interval reproduces the "
    "onsite columns); they are not unique and not clinical guidelines.",
    "Bed planning demand = ROUND_HALF_UP(coefficient x peak weekly expected cases); a capacity-planning "
    "proxy, not measured hospital occupancy. Beds are not allocated in this step.",
    "Crew demand and the crew budget are hypothetical scenario inputs: 0 for Low-tier wards, otherwise "
    "min(6, ceil(population_density_sqkm / 12000)); density is a workload proxy.",
    "Crew assignment is risk-prioritised; it is not an estimate of cases prevented.",
]

LIMITATIONS = [
    "Historical replay on data that appear simulated; not a live or official plan.",
    "Forecasts are expected values without prediction intervals; the Phase 1 model over-predicted the "
    "test period by about 12.5% in aggregate and can under-predict the largest outbreaks.",
    "No safety buffer is added to demand.",
    "Wards are planned independently; no travel time, delivery logistics or cost model.",
]

# --------------------------------------------------------------------------- hospital routing (scenario)
# HYPOTHETICAL city bed capacity baseline, in bed planning units. Retrospectively calibrated:
# for each city, the mean over 2016-2023 of each calendar year's peak CITY-WIDE weekly bed planning
# demand, where weekly ward demand = ROUND_HALF_UP(0.29844 * dengue_cases) from the bundled Phase 1 CSV
# (ml/data/dengue_dataset.csv); the mean is then rounded ROUND_HALF_UP (Dhaka North: 86.5 -> 87).
# Not an observed hospital inventory, staffed-bed count or point-in-time estimate.
HOSPITAL_CITY_BASELINE_BEDS = {
    "Chattogram": 46,
    "Dhaka North": 87,
    "Dhaka South": 86,
    "Gazipur": 27,
    "Narayanganj": 21,
}
HOSPITAL_BASELINE_FIRST_YEAR, HOSPITAL_BASELINE_LAST_YEAR = 2016, 2023
HOSPITAL_BASELINE_DEFINITION = (
    "Mean over 2016-2023 of each calendar year's peak city-wide weekly bed planning demand "
    "(ward weekly demand = ROUND_HALF_UP(0.29844 x dengue_cases), bundled Phase 1 CSV), rounded ROUND_HALF_UP."
)
CAPACITY_PCT_MIN, CAPACITY_PCT_MAX, CAPACITY_PCT_DEFAULT = 25, 200, 100

HOSPITAL_POLICY = {
    "name": "within_city_overflow_routing",
    "description": (
        "Per forecast week and city: each ward first uses its own hypothetical capacity; remaining bed planning "
        "units move one at a time from the sender with the lowest served ratio (local + transferred out) / demand "
        "to the receiver with the lowest occupancy ratio (local + transferred in) / capacity, only within the "
        "same city. Every ward pair in a city is assumed connected, so the units moved equal "
        "min(total overflow, total spare capacity). No distance, travel time or facility data is used."
    ),
}

HOSPITAL_ASSUMPTIONS = [
    "Bed planning units are forecast-derived planning quantities, not patients, admissions or occupied beds.",
    "Weekly bed planning demand = ROUND_HALF_UP(0.29844 x weekly expected cases) for t+2, t+3 and t+4; the "
    "largest of the three equals the bed_planning_demand of GET /allocation.",
    "Hypothetical city capacity = floor(capacity_pct x city baseline / 100), split equally across the city's "
    "wards (remainder one unit per ward in ward_id order). It is not a real hospital inventory.",
    "Transfers are planning reassignments between wards of the same city corporation only; every ward pair in "
    "a city is assumed connected. No cross-city transfers.",
    "Each forecast week is routed independently against the same capacities; weekly figures must not be "
    "added together as beds or patients.",
]

HOSPITAL_LIMITATIONS = [
    "No hospital locations, distances, travel times, specialties or real occupancy are available or used.",
    "Capacity baseline is retrospectively calibrated on 2016-2023 data and split equally across wards; "
    "real bed distribution is unknown.",
    "Bed demand is an expected-value planning proxy with no prediction interval.",
    "Historical replay on data that appear simulated; not an operational transfer plan.",
]

# --------------------------------------------------------------------------- intervention simulation (scenario)
# ASSUMPTIONS from the reviewed handoff (ml_handoff_reviewed, artifacts/parameters.json, sim-params-1.1.0).
# Not learned from data, not published effect estimates. The dataset contains no intervention records.
INTERVENTION_SCENARIOS = {"low": 0.15, "base": 0.35, "high": 0.55}   # maximum assumed reduction M
INTERVENTION_RANKING_SCENARIO = "base"
INTERVENTION_SATURATION_K = 1.4
INTERVENTION_RAMP = {2: 0.5, 3: 0.85, 4: 1.0}                          # share of R reached in week t+h
# Density per crew (12,000) and the 6-crew cap are shared with Task 2 (CREW_DENSITY_PER_CREW, CREW_MAX_PER_WARD).

INTERVENTION_POLICY = {
    "name": "assumed_effect_scenarios_on_ml_baseline",
    "causal": False,
    "effect_size_basis": "assumed_scenario_not_learned",
    "crew_capacity_status": "hypothetical",
    "crew_assignment_source": "task2_minimum_coverage_then_risk_priority",
    "timing": "If crews were deployed in the issue week, effects are assumed to ramp across weeks t+2, t+3 and t+4.",
    "description": (
        "coverage = crews / max(1, density / 12000); R = M x (1 - exp(-1.4 x coverage)); weekly reduction = "
        "R x ramp[h]; scenario_adjusted_cases = baseline x (1 - weekly reduction). The baseline is the ML "
        "forecast; the reduction is hypothetical scenario arithmetic."
    ),
}

INTERVENTION_ASSUMPTIONS = [
    "Model-driven: only the baseline weekly case forecast (Phase 1 3-week total split into t+2, t+3, t+4).",
    "Assumed: the low / base / high maximum reductions (15% / 35% / 55%), the saturation constant 1.4, the "
    "density workload scale (12,000 persons/km2 per crew), the weekly ramp (0.5 / 0.85 / 1.0), and the "
    "hypothetical crew budget, eligibility and cap (6 per ward).",
    "Derived scenario outputs: scenario-adjusted cases, projected cases avoided, planning supply and bed "
    "planning reductions, and projected cases avoided per assigned crew.",
    "Crews are the Task 2 Minimum Coverage + Risk Priority assignment for the same budget and floor.",
    "Projected cases avoided per assigned crew is a benefit-per-resource ratio, not a financial return.",
]

INTERVENTION_LIMITATIONS = [
    "The simulator applies hypothetical effects to an ML-derived baseline. It does not estimate or establish "
    "causal effectiveness, actual cases prevented, real resource savings, or actual public-health outcomes.",
    "No spraying activity, patient outcome or supply use is observed; nothing here has been carried out.",
    "Wards are treated independently: no mosquito movement, spillover, re-infestation or travel model.",
    "The baseline is an expected value without prediction intervals (Phase 1 over-predicted the test period "
    "by about 12.5% in aggregate).",
    "Historical replay on data that appear simulated.",
]
