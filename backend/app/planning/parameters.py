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
