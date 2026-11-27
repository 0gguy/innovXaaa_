"""Assemble a full 60-ward allocation scenario from Phase 1 forecasts (standard library only).

City isolation: every pool (saline, kits, crews) is computed and allocated per city corporation.
Region totals are sums of the city totals; no regional pool is ever split back into cities, except
the hypothetical regional crew budget, which is divided into city pools first (split_budget) and then
never moves again.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal

from . import parameters as P
from .allocate import Allocation, Claim, allocate, split_budget
from .demand import PlanningDataError, WardDemand, ward_demand

CONSUMABLES = ("saline", "kits")


def _pct(num: int, den: int) -> float | None:
    """Coverage percentage with 1 decimal (ROUND_HALF_UP); None when there is no demand."""
    if den == 0:
        return None
    return float((Decimal(100 * num) / Decimal(den)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _num4(x: Decimal) -> float:
    return float(x.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def _resource_entry(a: Allocation) -> dict:
    return {
        "demand": a.demand, "floor": a.floor, "allocated": a.allocated, "deficit": a.deficit,
        "coverage_pct": _pct(a.allocated, a.demand),
        "critical_deficit": a.deficit > 0, "severity": a.severity, "reason": a.reason,
    }


def _crew_entry(a: Allocation) -> dict:
    return {
        "scenario_demand": a.demand, "floor": a.floor, "assigned": a.allocated,
        "scenario_deficit": a.deficit, "coverage_pct": _pct(a.allocated, a.demand),
        "scenario_crew_deficit": a.deficit > 0, "severity": a.severity, "reason": a.reason,
    }


def _summary(allocs: list[Allocation], stock: int) -> dict:
    demand = sum(a.demand for a in allocs)
    allocated = sum(a.allocated for a in allocs)
    return {
        "demand": demand, "stock": stock, "allocated": allocated, "deficit": demand - allocated,
        "unallocated": stock - allocated, "coverage_pct": _pct(allocated, demand),
        "wards_with_deficit": sum(a.deficit > 0 for a in allocs),
        "wards_below_floor": sum(a.allocated < a.floor for a in allocs),
    }


def _add(total: dict, part: dict) -> None:
    for k, v in part.items():
        if isinstance(v, int) and not isinstance(v, bool):
            total[k] = total.get(k, 0) + v


def build_plan(forecasts: list[dict], densities: dict, *, stock_pct: int, min_coverage_pct: int,
               total_crews: int, stock_pct_saline: int | None = None, stock_pct_kits: int | None = None) -> dict:
    """Pure function: forecasts (with `weekly`) + ward densities + scenario -> JSON-ready plan body."""
    if not isinstance(forecasts, list) or not forecasts:
        raise PlanningDataError("no forecasts to plan from")
    pct = {"saline": stock_pct if stock_pct_saline is None else stock_pct_saline,
           "kits": stock_pct if stock_pct_kits is None else stock_pct_kits}

    wards: list[WardDemand] = []
    for f in forecasts:
        wid = f.get("ward_id") if isinstance(f, dict) else None
        if wid not in densities:
            raise PlanningDataError("population density missing for a forecast ward")
        wards.append(ward_demand(f, densities[wid]))
    if len({w.ward_id for w in wards}) != len(wards):
        raise PlanningDataError("duplicate ward in forecasts")
    sources = {w.weekly_source for w in wards}
    if len(sources) != 1:
        raise PlanningDataError("mixed weekly sources in one scenario")

    by_city: dict[str, list[WardDemand]] = defaultdict(list)
    for w in wards:
        by_city[w.city].append(w)
    cities = sorted(by_city)

    # ---- consumables: per-city pools, stock = floor(pct * D / 100)
    res_alloc: dict[str, dict[str, Allocation]] = {r: {} for r in CONSUMABLES}
    city_out = {c: {"city": c, "ward_count": len(by_city[c])} for c in cities}
    region = {r: {} for r in CONSUMABLES}
    for r in CONSUMABLES:
        for c in cities:
            claims = [Claim(w.ward_id, getattr(w, r), w.priority_key()) for w in by_city[c]]
            demand_c = sum(cl.demand for cl in claims)
            stock_c = pct[r] * demand_c // 100
            allocs, _ = allocate(claims, stock_c, min_coverage_pct)
            res_alloc[r].update({a.ward_id: a for a in allocs})
            s = _summary(allocs, stock_c)
            city_out[c][r] = s
            _add(region[r], s)
        region[r]["coverage_pct"] = _pct(region[r]["allocated"], region[r]["demand"])

    # ---- crews: regional hypothetical budget -> city pools -> wards
    crew_demand_city = {c: sum(w.crews for w in by_city[c]) for c in cities}
    pools, unassigned = split_budget(crew_demand_city, total_crews,
                                     tie_key={c: (-crew_demand_city[c],) for c in cities})
    crew_alloc: dict[str, Allocation] = {}
    region_crews = {"total_crews": total_crews}
    for c in cities:
        claims = [Claim(w.ward_id, w.crews, w.priority_key()) for w in by_city[c]]
        allocs, left = allocate(claims, pools[c], min_coverage_pct)
        if left:  # cannot happen: a pool never exceeds its city's demand
            raise PlanningDataError("crew pool exceeded city crew demand")
        crew_alloc.update({a.ward_id: a for a in allocs})
        s = _summary(allocs, pools[c])
        cs = {"scenario_demand": s["demand"], "pool": pools[c], "assigned": s["allocated"],
              "scenario_deficit": s["deficit"], "coverage_pct": s["coverage_pct"],
              "wards_with_scenario_deficit": s["wards_with_deficit"], "wards_below_floor": s["wards_below_floor"]}
        city_out[c]["crews"] = cs
        _add(region_crews, {k: v for k, v in cs.items() if k != "coverage_pct"})
    region_crews["unassigned"] = unassigned
    region_crews["coverage_pct"] = _pct(region_crews["assigned"], region_crews["scenario_demand"])
    if region_crews["assigned"] + unassigned != total_crews:
        raise PlanningDataError("crew balance check failed")

    # ---- beds: planning demand only (capacity and routing are a later step)
    for c in cities:
        city_out[c]["beds"] = {"planning_demand": sum(w.bed_demand for w in by_city[c]),
                               "capacity_and_routing": "not_computed"}
    region_beds = {"planning_demand": sum(city_out[c]["beds"]["planning_demand"] for c in cities),
                   "capacity_and_routing": "not_computed"}

    # ---- wards, grouped by city in priority order
    ward_out = []
    for c in cities:
        for w in sorted(by_city[c], key=WardDemand.priority_key):
            ward_out.append({
                "ward_id": w.ward_id, "city": c,
                "priority_rank_in_city": res_alloc["saline"][w.ward_id].rank,
                "priority": {"risk_tier": w.risk_tier, "early_alert": w.early_alert,
                             "population_density_sqkm": int(w.density) if w.density == w.density.to_integral_value()
                             else float(w.density),
                             "predicted_cases_3wk": _num4(w.predicted_cases_3wk)},
                "saline": _resource_entry(res_alloc["saline"][w.ward_id]),
                "kits": _resource_entry(res_alloc["kits"][w.ward_id]),
                "crews": _crew_entry(crew_alloc[w.ward_id]),
                "bed_plan": {"peak_forecast_week": w.peak_forecast_week, "peak_horizon_week": w.peak_horizon_week,
                             "peak_week_expected_cases": _num4(w.peak_week_cases),
                             "bed_planning_demand": w.bed_demand, "weekly_source": w.weekly_source},
                "exceeds_observed_range": w.exceeds_observed_range,
            })

    return {
        "policy": P.POLICY,
        "parameters": {
            "stock_pct": pct, "min_coverage_pct": min_coverage_pct, "total_crews": total_crews,
            "rounding": P.ROUNDING, "coefficients": {k: str(v) for k, v in P.COEFFICIENTS.items()},
            "coefficient_intervals": {k: list(v) for k, v in P.COEFFICIENT_INTERVALS.items()},
            "crew_rule": {"eligible_tiers": list(P.CREW_ELIGIBLE_TIERS),
                          "density_per_crew_sqkm": P.CREW_DENSITY_PER_CREW,
                          "max_crews_per_ward": P.CREW_MAX_PER_WARD, "status": "hypothetical_scenario"},
            "priority_key": P.PRIORITY_KEY,
        },
        "weekly_source": sources.pop(),
        "assumptions": P.ASSUMPTIONS,
        "limitations": P.LIMITATIONS,
        "region": {"saline": region["saline"], "kits": region["kits"], "crews": region_crews, "beds": region_beds},
        "cities": [city_out[c] for c in cities],
        "wards": ward_out,
    }
