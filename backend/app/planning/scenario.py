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
from .demand import (PlanningDataError, WardDemand, bed_planning_demand, consumable_demand, to_decimal,
                     ward_demand)
from .hospital import WardBeds, city_capacity, headline_week, route_city, summarize, ward_capacities
from .intervention import (CrewCandidate, first_crew_ranking, marginal_benefit, per_crew, roi_greedy,
                           ward_effect)

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


# =========================================================================== intervention simulation scenario
def _r(x: float, places: int) -> float:
    """Presentation rounding (ROUND_HALF_UP) of an internal full-precision value."""
    return float(Decimal(repr(float(x))).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def _ward_resources(p3: Decimal, eff) -> dict:
    """Integer planning impact for one ward and scenario (Task 2 / Task 3 rounding rules).
    Consumables: baseline uses the published 3-week forecast (equals GET /allocation); adjusted uses the
    published total minus the projected avoided cases. Beds: weekly rule per forecast week; peak = max."""
    p_adj = p3 - Decimal(repr(eff.avoided_total))
    if p_adj < 0:
        p_adj = Decimal(0)
    out = {}
    for item in ("saline", "kits"):
        base, adj = consumable_demand(p3, item), consumable_demand(p_adj, item)
        out[item] = {"baseline_units": base, "scenario_adjusted_units": adj, "projected_units_avoided": base - adj}
    wb = [bed_planning_demand(to_decimal(x, "baseline weekly cases")) for x in eff.baseline]
    wa = [bed_planning_demand(to_decimal(x, "adjusted weekly cases")) for x in eff.adjusted]
    out["weekly_bed_planning_units"] = {"baseline": wb, "scenario_adjusted": wa,
                                        "projected_units_avoided": [b - a for b, a in zip(wb, wa)]}
    out["peak_bed_planning_units"] = {"baseline": max(wb), "scenario_adjusted": max(wa),
                                      "projected_reduction": max(wb) - max(wa)}
    return out


def _empty_totals() -> dict:
    return {"baseline_cases_3wk": 0.0, "projected_cases_avoided": 0.0, "assigned_crews": 0,
            "saline": [0, 0], "kits": [0, 0], "beds_base": [0, 0, 0], "beds_adj": [0, 0, 0], "peak_red": 0}


def _accumulate(t: dict, p3: float, eff, res: dict) -> None:
    t["baseline_cases_3wk"] += p3
    t["projected_cases_avoided"] += eff.avoided_total
    t["assigned_crews"] += eff.crews
    for item in ("saline", "kits"):
        t[item][0] += res[item]["baseline_units"]
        t[item][1] += res[item]["scenario_adjusted_units"]
    for k in range(3):
        t["beds_base"][k] += res["weekly_bed_planning_units"]["baseline"][k]
        t["beds_adj"][k] += res["weekly_bed_planning_units"]["scenario_adjusted"][k]
    t["peak_red"] += res["peak_bed_planning_units"]["projected_reduction"]


def _merge(into: dict, part: dict) -> None:
    for k, v in part.items():
        if isinstance(v, list):
            into[k] = [a + b for a, b in zip(into[k], v)]
        else:
            into[k] += v


def _present_totals(t: dict, forecast_weeks: list[str]) -> dict:
    avoided = t["projected_cases_avoided"]
    roi = per_crew(avoided, t["assigned_crews"])
    return {
        "baseline_cases_3wk": _r(t["baseline_cases_3wk"], 4),
        "scenario_adjusted_cases_3wk": _r(t["baseline_cases_3wk"] - avoided, 4),
        "projected_cases_avoided": _r(avoided, 4),
        "assigned_crews": t["assigned_crews"],
        "projected_cases_avoided_per_assigned_crew": None if roi is None else _r(roi, 3),
        "saline": {"baseline_units": t["saline"][0], "scenario_adjusted_units": t["saline"][1],
                   "projected_units_avoided": t["saline"][0] - t["saline"][1]},
        "kits": {"baseline_units": t["kits"][0], "scenario_adjusted_units": t["kits"][1],
                 "projected_units_avoided": t["kits"][0] - t["kits"][1]},
        "weekly_bed_planning_units": [
            {"horizon_week": h, "forecast_week": fw, "baseline": b, "scenario_adjusted": a,
             "projected_units_avoided": b - a}
            for h, fw, b, a in zip((2, 3, 4), forecast_weeks, t["beds_base"], t["beds_adj"])],
        "sum_of_ward_peak_bed_planning_reductions": t["peak_red"],
    }


def _scenario_totals(wards, by_city, assigned, base_cases, dens, p3s, m):
    """Raw (unrounded) city and region totals for one crew assignment and one scenario."""
    cities = {}
    for c, ws in by_city.items():
        t = _empty_totals()
        for w in ws:
            eff = ward_effect(base_cases[w.ward_id], assigned[w.ward_id], dens[w.ward_id], m)
            _accumulate(t, float(p3s[w.ward_id]), eff, _ward_resources(p3s[w.ward_id], eff))
        cities[c] = t
    region = _empty_totals()
    for c in sorted(cities):
        _merge(region, cities[c])
    return cities, region


def build_intervention_simulation(forecasts: list[dict], densities: dict, *, total_crews: int,
                                  min_coverage_pct: int, include_roi_alternative: bool = False) -> dict:
    """Pure function: forecasts (with `weekly`) + densities + crew scenario -> JSON-ready simulation body.

    Crews come from Task 2's build_plan (Minimum Coverage + Risk Priority) for the same budget and floor.
    Baselines are the Task 1 weekly forecasts; all scenario effects are assumed (causal = false)."""
    wards = _validated_wards(forecasts, densities)
    fmap = {f["ward_id"]: f for f in forecasts}
    week_sets = {tuple(f["forecast_weeks"]) for f in forecasts}
    if len(week_sets) != 1:
        raise PlanningDataError("forecasts are not for one common issue week")
    forecast_weeks = list(week_sets.pop())

    plan = build_plan(forecasts, densities, stock_pct=100, min_coverage_pct=min_coverage_pct,
                      total_crews=total_crews)
    crew_rows = {w["ward_id"]: w for w in plan["wards"]}
    assigned = {wid: r["crews"]["assigned"] for wid, r in crew_rows.items()}
    caps = {wid: r["crews"]["scenario_demand"] for wid, r in crew_rows.items()}
    pools = {c["city"]: c["crews"]["pool"] for c in plan["cities"]}
    region_crews = plan["region"]["crews"]

    by_city: dict[str, list[WardDemand]] = defaultdict(list)
    for w in wards:
        by_city[w.city].append(w)
    for c in by_city:
        by_city[c].sort(key=WardDemand.priority_key)
        if sum(assigned[w.ward_id] for w in by_city[c]) != pools[c]:
            raise PlanningDataError("crew assignment does not match the city crew pool")
    cities = sorted(by_city)
    base_cases = {w.ward_id: tuple(float(x["predicted_cases"]) for x in fmap[w.ward_id]["weekly"]["weeks"])
                  for w in wards}
    dens = {w.ward_id: float(densities[w.ward_id]) for w in wards}
    p3s = {w.ward_id: w.predicted_cases_3wk for w in wards}
    scen = P.INTERVENTION_SCENARIOS
    m_rank = scen[P.INTERVENTION_RANKING_SCENARIO]

    # ---- primary plan (Task 2 assignment), all scenarios
    raw = {s: _scenario_totals(wards, by_city, assigned, base_cases, dens, p3s, m) for s, m in scen.items()}
    scenarios_out = {}
    for s in scen:
        city_t, region_t = raw[s]
        scenarios_out[s] = {
            "max_reduction": scen[s],
            "region": _present_totals(region_t, forecast_weeks),
            "cities": [{"city": c, **_present_totals(city_t[c], forecast_weeks)} for c in cities],
        }

    # ---- wards
    ward_out = []
    for c in cities:
        for rank, w in enumerate(by_city[c], start=1):
            wid = w.ward_id
            cand = CrewCandidate(wid, caps[wid], w.priority_key(), base_cases[wid], dens[wid])
            nxt = marginal_benefit(cand, assigned[wid], m_rank)
            res_by_s, baseline_units = {}, None
            for s, m in scen.items():
                eff = ward_effect(base_cases[wid], assigned[wid], dens[wid], m)
                res = _ward_resources(p3s[wid], eff)
                roi = per_crew(eff.avoided_total, eff.crews)
                # baseline units are identical in every scenario: published once per ward below
                baseline_units = {"saline": res["saline"]["baseline_units"], "kits": res["kits"]["baseline_units"],
                                  "weekly_bed_planning_units": res["weekly_bed_planning_units"]["baseline"],
                                  "peak_bed_planning_units": res["peak_bed_planning_units"]["baseline"]}
                res_by_s[s] = {
                    # the t+4 value equals the ward's maximum assumed reduction R (ramp 1.0)
                    "effective_reduction_by_week": [_r(x, 6) for x in eff.reductions],
                    "scenario_adjusted_weekly_cases": [_r(x, 4) for x in eff.adjusted],
                    "projected_cases_avoided": _r(eff.avoided_total, 4),
                    "projected_cases_avoided_per_assigned_crew": None if roi is None else _r(roi, 3),
                    "saline": {k: v for k, v in res["saline"].items() if k != "baseline_units"},
                    "kits": {k: v for k, v in res["kits"].items() if k != "baseline_units"},
                    "weekly_bed_planning_units": {k: v for k, v in res["weekly_bed_planning_units"].items()
                                                  if k != "baseline"},
                    "peak_bed_planning_units": {k: v for k, v in res["peak_bed_planning_units"].items()
                                                if k != "baseline"},
                }
            cov = ward_effect(base_cases[wid], assigned[wid], dens[wid], m_rank).coverage
            ward_out.append({
                "ward_id": wid, "city": c, "priority_rank_in_city": rank, "risk_tier": w.risk_tier,
                "early_alert": w.early_alert, "population_density_sqkm": crew_rows[wid]["priority"]["population_density_sqkm"],
                "predicted_cases_3wk": _r(float(w.predicted_cases_3wk), 4),
                "baseline_weekly_cases": [_r(x, 4) for x in base_cases[wid]],
                "baseline_planning_units": baseline_units,
                "crews": {"scenario_demand": caps[wid], "assigned": assigned[wid], "coverage": _r(cov, 4),
                          "next_crew_status": ("ineligible" if caps[wid] == 0 else
                                               "at_cap" if assigned[wid] >= caps[wid] else "available"),
                          "next_crew_projected_cases_avoided_base": None if nxt is None else _r(nxt, 4)},
                "scenarios": res_by_s,
            })

    # ---- first-crew ranking (base scenario), all eligible wards
    cands_all = []
    for c in cities:
        cands_all += [CrewCandidate(w.ward_id, caps[w.ward_id], w.priority_key(), base_cases[w.ward_id],
                                    dens[w.ward_id]) for w in by_city[c]]
    city_of = {w.ward_id: w.city for w in wards}
    ranking = [{"rank": i, "ward_id": wid, "city": city_of[wid], "first_crew_projected_cases_avoided": _r(v, 4),
                "assigned_crews": assigned[wid]}
               for i, (wid, v) in enumerate(first_crew_ranking(cands_all, m_rank), start=1)]

    # ---- optional hypothetical ROI-oriented alternative (same city pools, same caps)
    alternative = None
    if include_roi_alternative:
        alt = {}
        for c in cities:
            cands = [CrewCandidate(w.ward_id, caps[w.ward_id], w.priority_key(), base_cases[w.ward_id],
                                   dens[w.ward_id]) for w in by_city[c]]
            alt.update(roi_greedy(cands, pools[c], m_rank))
        for c in cities:
            if sum(alt[w.ward_id] for w in by_city[c]) != pools[c]:
                raise PlanningDataError("alternative crew assignment does not match the city crew pool")
        comparison = {}
        for s, m in scen.items():
            city_t, region_t = _scenario_totals(wards, by_city, alt, base_cases, dens, p3s, m)
            prim_c, prim_r = raw[s]

            def diff(a, p):
                d = a["projected_cases_avoided"] - p["projected_cases_avoided"]
                pct = None if p["projected_cases_avoided"] == 0 else 100 * d / p["projected_cases_avoided"]
                return {"primary_projected_cases_avoided": _r(p["projected_cases_avoided"], 4),
                        "alternative_projected_cases_avoided": _r(a["projected_cases_avoided"], 4),
                        "difference": _r(d, 4), "difference_pct": None if pct is None else _r(pct, 1)}

            comparison[s] = {"region": diff(region_t, prim_r),
                             "cities": [{"city": c, **diff(city_t[c], prim_c[c])} for c in cities]}
        alternative = {
            "status": "hypothetical_assumption_dependent",
            "objective": "maximise total projected cases avoided (base scenario) per city with marginal-gain greedy; "
                         "same city pools, same Task 2 ward caps; not a proven best real-world deployment",
            "ranking_scenario": P.INTERVENTION_RANKING_SCENARIO,
            "city_pools": {c: pools[c] for c in cities},
            "assigned_crews": sum(alt.values()),
            "wards": [{"ward_id": w.ward_id, "city": c, "primary_crews": assigned[w.ward_id],
                       "alternative_crews": alt[w.ward_id]}
                      for c in cities for w in by_city[c] if caps[w.ward_id] > 0],
            "comparison": comparison,
        }

    warnings = []
    if wards[0].weekly_source == "equal_split":
        warnings.append("Weekly companion unavailable: the baseline is an equal split of the 3-week forecast.")
    if region_crews["unassigned"]:
        warnings.append(f"{region_crews['unassigned']} crews are unassigned: the budget exceeds hypothetical crew demand.")

    return {
        "policy": P.INTERVENTION_POLICY,
        "parameters": {
            "scenarios": dict(scen), "saturation_k": P.INTERVENTION_SATURATION_K,
            "density_per_crew_sqkm": P.CREW_DENSITY_PER_CREW, "max_crews_per_ward": P.CREW_MAX_PER_WARD,
            "ramp_by_horizon_week": {str(h): g for h, g in P.INTERVENTION_RAMP.items()},
            "total_crews": total_crews, "min_coverage_pct": min_coverage_pct,
            "include_roi_alternative": include_roi_alternative,
            "coefficients": {k: str(v) for k, v in P.COEFFICIENTS.items()}, "rounding": P.ROUNDING,
            "roi_definition": "projected cases avoided over t+2..t+4 / assigned crews (not financial); null if 0 crews",
        },
        "weekly_source": wards[0].weekly_source,
        "forecast_weeks": forecast_weeks,
        "assumptions": P.INTERVENTION_ASSUMPTIONS,
        "limitations": P.INTERVENTION_LIMITATIONS,
        "warnings": warnings,
        "crews": {"total_crews": region_crews["total_crews"], "scenario_demand": region_crews["scenario_demand"],
                  "assigned": region_crews["assigned"], "unassigned": region_crews["unassigned"],
                  "city_pools": {c: pools[c] for c in cities}},
        "scenarios": scenarios_out,
        "wards": ward_out,
        "first_crew_ranking": ranking,
        "roi_alternative": alternative,
    }
