"""Forecast -> integer planning demand. Exact Decimal arithmetic, ROUND_HALF_UP, standard library only.

Input is one Phase 1 forecast dict (predicted_cases_3wk, risk_tier, early_alert, forecast_weeks) with
the Task 1 `weekly` block attached, plus the ward's population density. Any malformed value raises
PlanningDataError; the API turns that into a generic server error without internals.
"""
from __future__ import annotations

import math
import numbers
from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

from .parameters import (
    COEFFICIENTS,
    CREW_DENSITY_PER_CREW,
    CREW_ELIGIBLE_TIERS,
    CREW_MAX_PER_WARD,
    MAX_OBSERVED_3WK_CASES,
    MAX_VALID_CASES,
    TIER_RANK,
)

WEEKLY_SOURCES = ("companion", "equal_split")
_RECONCILE_TOLERANCE = Decimal("0.000001")
_PEAK_RESOLUTION = Decimal("0.000000001")


class PlanningDataError(ValueError):
    """Internal forecast data cannot be turned into a plan (never caused by user query parameters)."""


@dataclass(frozen=True)
class WardDemand:
    ward_id: str
    city: str
    risk_tier: str
    early_alert: bool
    density: Decimal
    predicted_cases_3wk: Decimal
    saline: int
    kits: int
    crews: int
    bed_demand: int
    peak_horizon_week: int
    peak_forecast_week: str
    peak_week_cases: Decimal
    weekly_source: str
    exceeds_observed_range: bool

    def priority_key(self) -> tuple:
        """Ascending sort = served first: tier, alert, density, forecast (all descending), ward_id."""
        return (-TIER_RANK[self.risk_tier], 0 if self.early_alert else 1, -self.density,
                -self.predicted_cases_3wk, self.ward_id)


def half_up(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_decimal(value, name: str) -> Decimal:
    """Finite, non-negative, sane number -> exact Decimal of its shortest repr."""
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise PlanningDataError(f"{name} is not a number")
    f = float(value)
    if not math.isfinite(f) or f < 0:
        raise PlanningDataError(f"{name} must be finite and >= 0")
    d = Decimal(repr(f))
    if d > MAX_VALID_CASES:
        raise PlanningDataError(f"{name} is implausibly large")
    return d


def consumable_demand(predicted_3wk: Decimal, item: str) -> int:
    """3-week planning demand, rounded once per ward (planning convention, not an observed 3-week measure)."""
    return half_up(COEFFICIENTS[item] * predicted_3wk)


def bed_planning_demand(peak_week_cases: Decimal) -> int:
    """Peak-week bed planning demand (capacity-planning proxy, not measured occupancy)."""
    return half_up(COEFFICIENTS["beds"] * peak_week_cases)


def crew_demand(risk_tier: str, density: Decimal) -> int:
    """HYPOTHETICAL scenario crew demand: 0 for Low tier, else min(6, ceil(density / 12000))."""
    if risk_tier not in CREW_ELIGIBLE_TIERS:
        return 0
    need = int((density / Decimal(CREW_DENSITY_PER_CREW)).to_integral_value(rounding=ROUND_CEILING))
    return min(CREW_MAX_PER_WARD, need)


def ward_demand(forecast: dict, density) -> WardDemand:
    try:
        ward_id, city = forecast["ward_id"], forecast["city"]
        tier, alert = forecast["risk_tier"], forecast["early_alert"]
        forecast_weeks = forecast["forecast_weeks"]
        weekly = forecast["weekly"]
        weeks = weekly["weeks"]
        source = weekly["source"]
    except (KeyError, TypeError):
        raise PlanningDataError("forecast record is missing required fields") from None
    if not isinstance(ward_id, str) or not isinstance(city, str):
        raise PlanningDataError("ward_id and city must be strings")
    if tier not in TIER_RANK or not isinstance(alert, bool):
        raise PlanningDataError(f"{ward_id}: invalid risk tier or alert flag")
    if source not in WEEKLY_SOURCES:
        raise PlanningDataError(f"{ward_id}: unknown weekly source")
    p3 = to_decimal(forecast.get("predicted_cases_3wk"), f"{ward_id} predicted_cases_3wk")
    dens = to_decimal(density, f"{ward_id} population_density_sqkm")
    if dens <= 0:
        raise PlanningDataError(f"{ward_id}: population density must be > 0")

    if not isinstance(weeks, list) or len(weeks) != 3:
        raise PlanningDataError(f"{ward_id}: expected 3 weekly values")
    try:
        horizons = [w["horizon_week"] for w in weeks]
        fweeks = [w["forecast_week"] for w in weeks]
        values = [to_decimal(w["predicted_cases"], f"{ward_id} weekly value") for w in weeks]
    except (KeyError, TypeError):
        raise PlanningDataError(f"{ward_id}: malformed weekly values") from None
    if horizons != [2, 3, 4] or fweeks != list(forecast_weeks):
        raise PlanningDataError(f"{ward_id}: weekly values do not match the forecast weeks")
    if abs(sum(values) - p3) > _RECONCILE_TOLERANCE:
        raise PlanningDataError(f"{ward_id}: weekly values do not add up to the 3-week forecast")

    # Largest weekly value; earliest week on ties. Values are compared at 1e-9 so that float noise
    # (e.g. the equal split t/3, t/3, t - 2*(t/3)) does not decide which week is the peak.
    peak_idx = max(range(3), key=lambda j: (values[j].quantize(_PEAK_RESOLUTION), -j))
    return WardDemand(
        ward_id=ward_id, city=city, risk_tier=tier, early_alert=alert, density=dens,
        predicted_cases_3wk=p3,
        saline=consumable_demand(p3, "saline"), kits=consumable_demand(p3, "kits"),
        crews=crew_demand(tier, dens),
        bed_demand=bed_planning_demand(values[peak_idx]),
        peak_horizon_week=horizons[peak_idx], peak_forecast_week=fweeks[peak_idx],
        peak_week_cases=values[peak_idx], weekly_source=source,
        exceeds_observed_range=p3 > MAX_OBSERVED_3WK_CASES,
    )
