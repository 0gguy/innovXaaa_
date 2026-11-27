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
from .demand import PlanningDataError, WardDemand, bed_planning_demand, to_decimal, ward_demand
from .hospital import WardBeds, city_capacity, headline_week, route_city, summarize, ward_capacities

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


# =========================================================================== hospital routing scenario
def _utilization(summary: dict) -> dict:
    """Add presentation percentages from the integer totals (never averaged across cities)."""
    cap = summary["hypothetical_capacity"]
    summary["utilization_pct"] = _pct(summary["occupied_after_routing"], cap)
    summary["demand_to_capacity_pct"] = _pct(summary["bed_planning_demand"], cap)
    summary["utilization_status"] = "no_capacity" if cap == 0 else "ok"
    return summary


def _validated_wards(forecasts: list[dict], densities: dict) -> list[WardDemand]:
    if not isinstance(forecasts, list) or not forecasts:
        raise PlanningDataError("no forecasts to plan from")
    wards = []
    for f in forecasts:
        wid = f.get("ward_id") if isinstance(f, dict) else None
        if wid not in densities:
            raise PlanningDataError("population density missing for a forecast ward")
        wards.append(ward_demand(f, densities[wid]))
    if len({w.ward_id for w in wards}) != len(wards):
        raise PlanningDataError("duplicate ward in forecasts")
    if len({w.weekly_source for w in wards}) != 1:
        raise PlanningDataError("mixed weekly sources in one scenario")
    return wards


def build_hospital_routing(forecasts: list[dict], densities: dict, *, capacity_pct: int) -> dict:
    """Pure function: forecasts (with `weekly`) + densities + capacity scenario -> JSON-ready routing body.

    Each of the three forecast weeks is routed independently against the same hypothetical capacities;
    routing runs per city, so no transfer can cross a city boundary. Region totals are sums of city totals.
    """
    wards = _validated_wards(forecasts, densities)
    fmap = {f["ward_id"]: f for f in forecasts}
    issue_weeks = {f.get("issue_week") for f in forecasts}
    week_sets = {tuple(f["forecast_weeks"]) for f in forecasts}
    if len(issue_weeks) != 1 or len(week_sets) != 1:
        raise PlanningDataError("forecasts are not for one common issue week")
    issue_week = str(issue_weeks.pop())
    forecast_weeks = list(week_sets.pop())
    horizons = [2, 3, 4]

    by_city: dict[str, list[WardDemand]] = defaultdict(list)
    for w in wards:
        by_city[w.city].append(w)
    cities = sorted(by_city)
    if any(c not in P.HOSPITAL_CITY_BASELINE_BEDS for c in cities):
        raise PlanningDataError("no hypothetical capacity baseline for a forecast city")

    # Weekly bed planning demand per ward (same rule as Task 2); its maximum must equal Task 2's value.
    weekly_demand: dict[str, list[int]] = {}
    for w in wards:
        vals = [bed_planning_demand(to_decimal(x["predicted_cases"], f"{w.ward_id} weekly value"))
                for x in fmap[w.ward_id]["weekly"]["weeks"]]
        if max(vals) != w.bed_demand:
            raise PlanningDataError("weekly bed demand does not reconcile with the Task 2 bed plan")
        weekly_demand[w.ward_id] = vals

    # Hypothetical capacities: fixed for all three weeks.
    city_cap = {c: city_capacity(P.HOSPITAL_CITY_BASELINE_BEDS[c], capacity_pct) for c in cities}
    ward_cap: dict[str, int] = {}
    for c in cities:
        ward_cap.update(ward_capacities([w.ward_id for w in by_city[c]], city_cap[c]))

    ward_weeks: dict[str, list[dict]] = {w.ward_id: [] for w in wards}
    city_weeks: dict[str, list[tuple[int, dict]]] = {c: [] for c in cities}
    weeks_out = []
    for k, (h, fw) in enumerate(zip(horizons, forecast_weeks)):
        region: dict = {}
        city_rows, transfer_rows = [], []
        for c in cities:
            inputs = [WardBeds(w.ward_id, weekly_demand[w.ward_id][k], ward_cap[w.ward_id], w.priority_key())
                      for w in by_city[c]]
            results, transfers = route_city(inputs)
            s = summarize(results, transfers)
            city_weeks[c].append((h, dict(s)))
            _add(region, s)
            city_rows.append({"city": c, **_utilization(s)})
            transfer_rows += [{"city": c, "horizon_week": h, "forecast_week": fw, "from_ward": t.from_ward,
                               "to_ward": t.to_ward, "units": t.units} for t in transfers]
            for r in results:
                ward_weeks[r.ward_id].append({
                    "horizon_week": h, "forecast_week": fw, "bed_planning_demand": r.demand,
                    "locally_assigned": r.locally_assigned, "transferred_out": r.transferred_out,
                    "transferred_in": r.transferred_in, "unmet_after_routing": r.unmet_after_routing,
                    "occupied_after_routing": r.occupied_after_routing,
                    "spare_after_routing": r.spare_after_routing})
        if region["transfer_units"] != sum(t["units"] for t in transfer_rows):
            raise PlanningDataError("region transfer balance check failed")
        weeks_out.append({"horizon_week": h, "forecast_week": fw, "region": _utilization(region),
                          "cities": city_rows, "transfers": transfer_rows})

    headline = {}
    for c in cities:
        hw = headline_week(city_weeks[c])
        headline[c] = {"horizon_week": hw, "forecast_week": forecast_weeks[horizons.index(hw)]}

    ward_out = []
    for c in cities:
        for rank, w in enumerate(sorted(by_city[c], key=WardDemand.priority_key), start=1):
            ward_out.append({"ward_id": w.ward_id, "city": c, "priority_rank_in_city": rank,
                             "risk_tier": w.risk_tier, "hypothetical_capacity": ward_cap[w.ward_id],
                             "max_weekly_bed_planning_demand": w.bed_demand, "weeks": ward_weeks[w.ward_id]})

    source = wards[0].weekly_source
    warnings = []
    if issue_week < f"{P.HOSPITAL_BASELINE_LAST_YEAR + 1}-01-01":
        warnings.append(
            f"Issue week {issue_week} is before {P.HOSPITAL_BASELINE_LAST_YEAR + 1}: the capacity baseline was "
            f"calibrated on {P.HOSPITAL_BASELINE_FIRST_YEAR}-{P.HOSPITAL_BASELINE_LAST_YEAR} data, including weeks "
            "after this issue week (retrospective scenario, not information available at the time).")
    if source == "equal_split":
        warnings.append("Weekly companion unavailable: weekly demand is an equal split of the 3-week forecast, "
                        "so the three weeks are identical.")

    return {
        "policy": P.HOSPITAL_POLICY,
        "parameters": {
            "capacity_pct": capacity_pct,
            "capacity_rule": "floor(capacity_pct x city_baseline / 100), equal split across wards; remainder "
                             "one unit per ward in ward_id order",
            "city_baseline_beds": dict(P.HOSPITAL_CITY_BASELINE_BEDS),
            "baseline_definition": P.HOSPITAL_BASELINE_DEFINITION,
            "baseline_years": [P.HOSPITAL_BASELINE_FIRST_YEAR, P.HOSPITAL_BASELINE_LAST_YEAR],
            "baseline_status": "hypothetical_retrospective_scenario",
            "bed_coefficient": str(P.COEFFICIENTS["beds"]), "rounding": P.ROUNDING,
            "units": "bed planning units per forecast week (not patients, admissions or occupied beds)",
            "connectivity": "all ward pairs within a city; no cross-city transfers",
            "sender_rule": "lowest served ratio (local + transferred_out) / demand; ties by Task 2 priority key",
            "receiver_rule": "lowest occupancy ratio (local + transferred_in) / capacity; ties by more spare, "
                             "then ward_id",
        },
        "weekly_source": source,
        "assumptions": P.HOSPITAL_ASSUMPTIONS,
        "limitations": P.HOSPITAL_LIMITATIONS,
        "warnings": warnings,
        "capacity": {"cities": [{"city": c, "ward_count": len(by_city[c]),
                                 "baseline": P.HOSPITAL_CITY_BASELINE_BEDS[c],
                                 "hypothetical_capacity": city_cap[c]} for c in cities],
                     "region_hypothetical_capacity": sum(city_cap.values())},
        "weeks": weeks_out,
        "headline_week_by_city": headline,
        "wards": ward_out,
    }
