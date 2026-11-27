"""Draft dispatch briefs from ONE shared forecast run (standard library only).

The Task 2 resource plan, the Task 3 hypothetical hospital routing and the Task 4 intervention simulation
are built from the same forecast list, the same densities and exactly the requested scenario parameters,
cross-checked against each other, and then reduced to a city- or ward-level brief. The brief is rendered as
JSON-ready data, a short SMS-style ASCII text, a detailed WhatsApp-ready plain text, or self-contained
printable HTML.

Nothing here sends, dispatches, transfers or authorises anything. Every output is a draft of a simulated
planning scenario on historical replay data and requires human verification.
"""
from __future__ import annotations

import copy
import hashlib
import html
import json
import re
from decimal import ROUND_HALF_UP, Decimal

from . import parameters as P
from .scenario import build_hospital_routing, build_intervention_simulation, build_plan

BRIEF_VERSION = "dispatch-brief-1.0"
SCOPES = ("city", "ward")
AUDIENCES = ("resource", "hospital", "all")
VARIANTS = ("short", "detailed")
FORMATS = ("json", "text", "html")
INTERVENTION_CHOICES = tuple(P.INTERVENTION_SCENARIOS)
SHORT_MAX_CHARS = 459          # 3 concatenated GSM-7 SMS segments of 153 characters each
LABELS = ("DRAFT / NOT SENT", "SIMULATED PLANNING SCENARIO", "HISTORICAL REPLAY", "HUMAN VERIFICATION REQUIRED")
HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'"
MEDIA_TYPES = {"json": "application/json", "text": "text/plain; charset=utf-8", "html": "text/html; charset=utf-8"}
EXTENSIONS = {"json": "json", "text": "txt", "html": "html"}
DEFAULT_NOTICE = ("Historical replay of a trained model on bundled data. These are model estimates, not verified "
                  "real-world warnings or live predictions.")

SECTION_ORDER = ("forecast_estimates", "resource_plan", "crew_scenario", "hospital_overflow", "intervention_scenario")
AUDIENCE_SECTIONS = {
    "resource": ("forecast_estimates", "resource_plan", "crew_scenario", "intervention_scenario"),
    "hospital": ("forecast_estimates", "hospital_overflow"),
    "all": SECTION_ORDER,
}
SECTION_LABELS = {
    "forecast_estimates": "FORECAST-DERIVED ESTIMATES",
    "resource_plan": "SUGGESTED ALLOCATION - HYPOTHETICAL STOCK SCENARIO",
    "crew_scenario": "HYPOTHETICAL CREW SCENARIO",
    "hospital_overflow": "HYPOTHETICAL CAPACITY - SIMULATED WITHIN-CITY REASSIGNMENT",
    "intervention_scenario": "ASSUMED-EFFECT INTERVENTION SCENARIO - NOT CAUSAL",
}
SECTION_TITLES = {
    "forecast_estimates": "Forecast-derived estimates",
    "resource_plan": "Suggested saline and kit allocation (hypothetical stock)",
    "crew_scenario": "Hypothetical crew scenario",
    "hospital_overflow": "Hypothetical bed capacity and simulated within-city reassignment",
    "intervention_scenario": "Assumed-effect intervention scenario (not causal)",
}
ROLE_LABELS = {
    ("city", "resource"): "City resource coordinator",
    ("city", "hospital"): "City hospital capacity coordinator",
    ("city", "all"): "City planning coordinator",
    ("ward", "resource"): "Ward response coordinator",
    ("ward", "hospital"): "Ward hospital capacity liaison",
    ("ward", "all"): "Ward response coordinator",
}
REASON_TEXT = {
    "fulfilled": "full planning demand covered",
    "floor_only": "minimum coverage floor only",
    "partial_priority": "floor plus a partial priority share",
    "below_floor": "below the minimum coverage floor",
    "not_reached": "not reached (no stock left and no floor)",
    "no_demand": "no forecast-derived demand",
}
SHORTAGE_FLAGS = ("BELOW FLOOR", "SHORT", "UNMET")
_HOSPITAL_KEYS = ("bed_planning_demand", "hypothetical_capacity", "locally_assigned", "transfer_units",
                  "transfer_edges", "sending_wards", "receiving_wards", "unmet_after_routing",
                  "spare_after_routing", "wards_with_unmet", "utilization_pct")
_RESOURCE_SUMMARY_KEYS = ("demand", "stock", "allocated", "deficit", "unallocated", "coverage_pct",
                          "wards_with_deficit", "wards_below_floor")


class DispatchQueryError(ValueError):
    """The request names an unknown or inconsistent city/ward, or a parameter is out of range."""

    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code, self.message = code, message


class DispatchConsistencyError(ValueError):
    """The planning layers disagree for one scenario (internal; never caused by the query)."""


class DispatchRenderError(ValueError):
    """A rendered output failed a safety or length check (internal)."""


def _check(cond: bool, what: str) -> None:
    if not cond:
        raise DispatchConsistencyError(what)


# =========================================================================== selection and parameters
def validate_selection(scope: str, city: str | None, ward_id: str | None) -> None:
    """Structural checks that need no forecast data (run before the model is called)."""
    if scope not in SCOPES:
        raise DispatchQueryError("invalid_parameter", "scope must be 'city' or 'ward'.")
    if city is not None and city not in P.CITIES:
        raise DispatchQueryError("unknown_city", "Unknown city. Use one of: " + ", ".join(P.CITIES) + ".")
    if scope == "city" and city is None:
        raise DispatchQueryError("missing_city", "scope=city requires the city parameter.")
    if scope == "ward" and ward_id is None:
        raise DispatchQueryError("missing_ward_id", "scope=ward requires the ward_id parameter.")


def _resolve_selection(forecasts: list[dict], scope: str, city: str | None, ward_id: str | None):
    """-> (city, ward_id or None). ward_id is checked against the forecast wards (never echoed back)."""
    validate_selection(scope, city, ward_id)
    ward_city = {f["ward_id"]: f["city"] for f in forecasts}
    if ward_id is not None:
        if ward_id not in ward_city:
            raise DispatchQueryError("unknown_ward", "Unknown ward_id.")
        if city is not None and city != ward_city[ward_id]:
            raise DispatchQueryError("city_ward_mismatch", "ward_id does not belong to the given city.")
    if scope == "ward":
        return ward_city[ward_id], ward_id
    if city not in set(ward_city.values()):
        raise DispatchQueryError("unknown_city", "No forecasts for this city.")
    return city, None       # a consistent ward_id does not change a city-scope brief


def _int_in(name: str, value, lo: int, hi: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise DispatchQueryError("invalid_parameter", f"{name} must be an integer from {lo} to {hi}.")


def _validate_parameters(params: dict, audience: str, variant: str) -> None:
    _int_in("stock_pct", params["stock_pct"], P.STOCK_PCT_MIN, P.STOCK_PCT_MAX)
    _int_in("min_coverage_pct", params["min_coverage_pct"], P.MIN_COVERAGE_PCT_MIN, P.MIN_COVERAGE_PCT_MAX)
    _int_in("total_crews", params["total_crews"], 0, P.TOTAL_CREWS_MAX)
    _int_in("capacity_pct", params["capacity_pct"], P.CAPACITY_PCT_MIN, P.CAPACITY_PCT_MAX)
    if params["intervention_scenario"] not in INTERVENTION_CHOICES:
        raise DispatchQueryError("invalid_parameter", "intervention_scenario must be low, base or high.")
    if audience not in AUDIENCES:
        raise DispatchQueryError("invalid_parameter", "audience must be resource, hospital or all.")
    if variant not in VARIANTS:
        raise DispatchQueryError("invalid_parameter", "variant must be short or detailed.")


# =========================================================================== one shared scenario
def build_bundle(forecasts: list[dict], densities: dict, *, stock_pct: int, min_coverage_pct: int,
                 total_crews: int, capacity_pct: int) -> dict:
    """Task 2, 3 and 4 bodies from the SAME forecasts and densities (each builder gets its own deep copy,
    so no builder can affect another or the caller), then cross-checked."""
    plan = build_plan(copy.deepcopy(forecasts), dict(densities), stock_pct=stock_pct,
                      min_coverage_pct=min_coverage_pct, total_crews=total_crews)
    hospital = build_hospital_routing(copy.deepcopy(forecasts), dict(densities), capacity_pct=capacity_pct)
    simulation = build_intervention_simulation(copy.deepcopy(forecasts), dict(densities), total_crews=total_crews,
                                               min_coverage_pct=min_coverage_pct)
    reconcile(forecasts, plan, hospital, simulation, stock_pct=stock_pct, min_coverage_pct=min_coverage_pct,
              total_crews=total_crews, capacity_pct=capacity_pct)
    return {"plan": plan, "hospital": hospital, "simulation": simulation}


def reconcile(forecasts, plan, hospital, simulation, *, stock_pct, min_coverage_pct, total_crews, capacity_pct):
    """Raise DispatchConsistencyError unless all three layers describe the same scenario."""
    _check(len({f.get("issue_week") for f in forecasts}) == 1, "forecasts span several issue weeks")
    _check(len({f.get("model_version") for f in forecasts}) == 1, "forecasts span several model versions")
    weeks = {tuple(f["forecast_weeks"]) for f in forecasts}
    _check(len(weeks) == 1, "forecasts span several forecast-week sets")
    fw = list(weeks.pop())
    _check(simulation["forecast_weeks"] == fw, "intervention forecast weeks differ")
    _check([w["forecast_week"] for w in hospital["weeks"]] == fw, "hospital forecast weeks differ")
    _check(plan["weekly_source"] == hospital["weekly_source"] == simulation["weekly_source"],
           "weekly source differs between layers")

    _check(plan["parameters"]["stock_pct"] == {"saline": stock_pct, "kits": stock_pct}, "stock_pct not applied")
    _check(plan["parameters"]["min_coverage_pct"] == min_coverage_pct == simulation["parameters"]["min_coverage_pct"],
           "min_coverage_pct not applied")
    _check(plan["parameters"]["total_crews"] == total_crews == simulation["parameters"]["total_crews"],
           "total_crews not applied")
    _check(hospital["parameters"]["capacity_pct"] == capacity_pct, "capacity_pct not applied")

    ids = {f["ward_id"] for f in forecasts}
    pw = {w["ward_id"]: w for w in plan["wards"]}
    hw = {w["ward_id"]: w for w in hospital["wards"]}
    sw = {w["ward_id"]: w for w in simulation["wards"]}
    _check(set(pw) == set(hw) == set(sw) == ids, "ward sets differ between layers")
    for wid in ids:
        p, h, s = pw[wid], hw[wid], sw[wid]
        _check(p["city"] == h["city"] == s["city"], "ward city differs between layers")
        _check(p["crews"]["assigned"] == s["crews"]["assigned"]
               and p["crews"]["scenario_demand"] == s["crews"]["scenario_demand"],
               "crew assignment differs between allocation and intervention")
        weekly = [x["bed_planning_demand"] for x in h["weeks"]]
        base = s["baseline_planning_units"]
        _check(weekly == base["weekly_bed_planning_units"], "weekly bed demand differs between routing and intervention")
        _check(max(weekly) == h["max_weekly_bed_planning_demand"] == p["bed_plan"]["bed_planning_demand"]
               == base["peak_bed_planning_units"], "peak bed demand differs between layers")
        _check(p["saline"]["demand"] == base["saline"] and p["kits"]["demand"] == base["kits"],
               "consumable baseline differs between allocation and intervention")
    pools = {c["city"]: c["crews"]["pool"] for c in plan["cities"]}
    _check(pools == simulation["crews"]["city_pools"], "city crew pools differ")


# =========================================================================== identifiers
def _slug(text: str) -> str:
    s = re.sub(r"[^A-Z0-9]+", "-", str(text).upper()).strip("-")
    return s[:48] or "X"


def scenario_id(issue_week: str, params: dict, weekly_source: str) -> str:
    """Every scenario input that changes planning content, plus the weekly split source."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(issue_week)):
        raise DispatchConsistencyError("issue week is not an ISO date")
    src = "WC" if weekly_source == "companion" else "WE"
    return (f"DO-{issue_week.replace('-', '')}-S{params['stock_pct']}-F{params['min_coverage_pct']}"
            f"-C{params['total_crews']}-H{params['capacity_pct']}-I{params['intervention_scenario'].upper()}-{src}")


def document_id(scen_id: str, scope: str, city: str, ward_id: str | None, audience: str, variant: str) -> str:
    target = f"CITY-{_slug(city)}" if scope == "city" else f"WARD-{_slug(ward_id)}"
    return f"{scen_id}.{target}.{audience.upper()}.{variant.upper()}"


def fingerprint(payload: dict) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode("ascii")).hexdigest()[:16]


def filename(brief: dict, fmt: str) -> str:
    """Deterministic, header-safe download name (only [a-z0-9_.-])."""
    name = "dispatch_" + brief["document_id"].lower().replace(".", "_") + "." + EXTENSIONS[fmt]
    if not re.fullmatch(r"[a-z0-9_-]{1,200}\.(json|txt|html)", name):
        raise DispatchRenderError("unsafe file name")
    return name


# =========================================================================== numbers
def _dec(x, places: int) -> str:
    d = Decimal(repr(float(x))).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    return f"{d:f}"


def _r4(d: Decimal) -> float:
    return float(d.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def _c1(x) -> str:
    return _dec(x, 1)


def _pct_text(x) -> str:
    return "n/a" if x is None else f"{_dec(x, 1)}%"


def _opt(x, places: int) -> str:
    return "n/a" if x is None else _dec(x, places)


def _share(m: float) -> str:
    return f"{_dec(m * 100, 0)}%"


def _display(ward_id: str) -> str:
    return str(ward_id).replace("_", " ")


def _one(rows: list[dict], city: str) -> dict:
    found = [r for r in rows if r["city"] == city]
    _check(len(found) == 1, "city row missing")
    return found[0]


# =========================================================================== sections
def _status_label(entry: dict) -> str:
    if entry["demand"] == 0:
        return "NO DEMAND"
    if entry["deficit"] == 0:
        return "COVERED"
    if entry["allocated"] < entry["floor"]:
        return "BELOW FLOOR"
    return "SHORT"


def _resource_ward(entry: dict) -> dict:
    out = {k: entry[k] for k in ("demand", "floor", "allocated", "deficit", "coverage_pct", "reason")}
    out["status_label"] = _status_label(entry)
    return out


def _transfer(t: dict) -> dict:
    return {"horizon_week": t["horizon_week"], "forecast_week": t["forecast_week"],
            "from_ward": t["from_ward"], "from_display_name": _display(t["from_ward"]),
            "to_ward": t["to_ward"], "to_display_name": _display(t["to_ward"]),
            "units": t["units"], "status": "simulated_proposal_not_executed"}


def _hospital_weeks(hospital: dict, city: str, city_ids: set) -> tuple[list, list]:
    weeks, transfers = [], []
    for wk in hospital["weeks"]:
        row = _one(wk["cities"], city)
        weeks.append({"horizon_week": wk["horizon_week"], "forecast_week": wk["forecast_week"],
                      **{k: row[k] for k in _HOSPITAL_KEYS}})
        for t in wk["transfers"]:
            if t["city"] != city:
                continue
            _check(t["from_ward"] in city_ids and t["to_ward"] in city_ids, "transfer crosses a city boundary")
            transfers.append(_transfer(t))
    return weeks, transfers


def _intervention_totals(row: dict) -> dict:
    keys = ("baseline_cases_3wk", "scenario_adjusted_cases_3wk", "projected_cases_avoided", "assigned_crews",
            "projected_cases_avoided_per_assigned_crew", "saline", "kits")
    return {k: copy.deepcopy(row[k]) for k in keys}


def _intervention_head(simulation: dict, selected: str) -> dict:
    pol = simulation["policy"]
    return {"label": SECTION_LABELS["intervention_scenario"], "causal": pol["causal"],
            "effect_size_basis": pol["effect_size_basis"], "crew_assignment_source": pol["crew_assignment_source"],
            "selected_scenario": selected, "max_reduction": simulation["scenarios"][selected]["max_reduction"]}


def _city_sections(b: dict, forecasts: list[dict], city: str, params: dict) -> dict:
    plan, hospital, sim = b["plan"], b["hospital"], b["simulation"]
    rows = [w for w in plan["wards"] if w["city"] == city]                       # priority order
    ids = {w["ward_id"] for w in rows}
    fmap = {f["ward_id"]: f for f in forecasts}
    pc = _one(plan["cities"], city)
    sel = params["intervention_scenario"]
    sim_city = {s: _one(sim["scenarios"][s]["cities"], city) for s in INTERVENTION_CHOICES}

    weekly = []
    for k, (h, fw) in enumerate(zip((2, 3, 4), sim["forecast_weeks"])):
        total = sum((Decimal(repr(float(fmap[w]["weekly"]["weeks"][k]["predicted_cases"]))) for w in ids), Decimal(0))
        weekly.append({"horizon_week": h, "forecast_week": fw, "expected_cases": _r4(total)})
    forecast = {
        "label": SECTION_LABELS["forecast_estimates"], "ward_count": len(rows),
        "predicted_cases_3wk_total": sim_city[sel]["baseline_cases_3wk"],
        "weekly_expected_cases": weekly,
        "tier_counts": {t: sum(w["priority"]["risk_tier"] == t for w in rows) for t in ("Critical", "High", "Medium", "Low")},
        "early_alert_wards": sum(w["priority"]["early_alert"] for w in rows),
        "wards_exceeding_observed_range": sum(w["exceeds_observed_range"] for w in rows),
        "wards": [{"ward_id": w["ward_id"], "display_name": _display(w["ward_id"]),
                   "priority_rank_in_city": w["priority_rank_in_city"], "risk_tier": w["priority"]["risk_tier"],
                   "early_alert": w["priority"]["early_alert"], "predicted_cases_3wk": w["priority"]["predicted_cases_3wk"]}
                  for w in rows],
    }
    resource = {
        "label": SECTION_LABELS["resource_plan"], "stock_pct": params["stock_pct"],
        "min_coverage_pct": params["min_coverage_pct"], "units": "planning units (not verified inventory)",
        "saline": {k: pc["saline"][k] for k in _RESOURCE_SUMMARY_KEYS},
        "kits": {k: pc["kits"][k] for k in _RESOURCE_SUMMARY_KEYS},
        "priority_order": list(P.PRIORITY_KEY),
        "wards": [{"ward_id": w["ward_id"], "display_name": _display(w["ward_id"]),
                   "priority_rank_in_city": w["priority_rank_in_city"], "risk_tier": w["priority"]["risk_tier"],
                   "early_alert": w["priority"]["early_alert"],
                   "saline": _resource_ward(w["saline"]), "kits": _resource_ward(w["kits"])} for w in rows],
    }
    rc = plan["region"]["crews"]
    cc = pc["crews"]
    crews = {
        "label": SECTION_LABELS["crew_scenario"], "status": "hypothetical",
        "region": {"total_crews": rc["total_crews"], "assigned": rc["assigned"], "unassigned": rc["unassigned"]},
        "city": {k: cc[k] for k in ("pool", "scenario_demand", "assigned", "scenario_deficit", "coverage_pct",
                                    "wards_with_scenario_deficit", "wards_below_floor")},
        "wards": [{"ward_id": w["ward_id"], "display_name": _display(w["ward_id"]),
                   "priority_rank_in_city": w["priority_rank_in_city"], "risk_tier": w["priority"]["risk_tier"],
                   "scenario_demand": w["crews"]["scenario_demand"], "assigned": w["crews"]["assigned"],
                   "scenario_deficit": w["crews"]["scenario_deficit"], "reason": w["crews"]["reason"]} for w in rows],
    }
    weeks, transfers = _hospital_weeks(hospital, city, ids)
    head = hospital["headline_week_by_city"][city]
    headline = next(w for w in weeks if w["horizon_week"] == head["horizon_week"])
    hw = {w["ward_id"]: w for w in hospital["wards"] if w["city"] == city}
    hidx = [2, 3, 4].index(head["horizon_week"])
    cap = _one(hospital["capacity"]["cities"], city)
    hosp = {
        "label": SECTION_LABELS["hospital_overflow"],
        "units": "bed planning units per forecast week (not patients, admissions or occupied beds)",
        "capacity_pct": params["capacity_pct"], "capacity_status": "hypothetical_retrospective_scenario",
        "city_baseline": cap["baseline"], "hypothetical_capacity": cap["hypothetical_capacity"],
        "retrospective_baseline_overlap": _retrospective(forecasts),
        "headline": headline, "weeks": weeks, "simulated_transfers": transfers,
        "wards_with_unmet_at_headline": [
            {"ward_id": w["ward_id"], "display_name": _display(w["ward_id"]),
             "unmet_after_routing": hw[w["ward_id"]]["weeks"][hidx]["unmet_after_routing"]}
            for w in rows if hw[w["ward_id"]]["weeks"][hidx]["unmet_after_routing"] > 0],
        "wards": [{"ward_id": w["ward_id"], "display_name": _display(w["ward_id"]),
                   "hypothetical_capacity": hw[w["ward_id"]]["hypothetical_capacity"],
                   "weekly_bed_planning_demand": [x["bed_planning_demand"] for x in hw[w["ward_id"]]["weeks"]],
                   "weekly_unmet_after_routing": [x["unmet_after_routing"] for x in hw[w["ward_id"]]["weeks"]]}
                  for w in rows],
        "warnings": list(hospital["warnings"]),
    }
    interv = _intervention_head(sim, sel)
    interv["selected"] = _intervention_totals(sim_city[sel])
    interv["comparison"] = [{"scenario": s, "max_reduction": sim["scenarios"][s]["max_reduction"],
                             "projected_cases_avoided": sim_city[s]["projected_cases_avoided"],
                             "scenario_adjusted_cases_3wk": sim_city[s]["scenario_adjusted_cases_3wk"],
                             "projected_cases_avoided_per_assigned_crew":
                                 sim_city[s]["projected_cases_avoided_per_assigned_crew"]}
                            for s in INTERVENTION_CHOICES]
    return {"forecast_estimates": forecast, "resource_plan": resource, "crew_scenario": crews,
            "hospital_overflow": hosp, "intervention_scenario": interv}


def _ward_sections(b: dict, forecasts: list[dict], city: str, wid: str, params: dict) -> dict:
    plan, hospital, sim = b["plan"], b["hospital"], b["simulation"]
    p = next(w for w in plan["wards"] if w["ward_id"] == wid)
    h = next(w for w in hospital["wards"] if w["ward_id"] == wid)
    s = next(w for w in sim["wards"] if w["ward_id"] == wid)
    city_ids = {w["ward_id"] for w in plan["wards"] if w["city"] == city}
    pc = _one(plan["cities"], city)
    sel = params["intervention_scenario"]

    forecast = {
        "label": SECTION_LABELS["forecast_estimates"], "ward_id": wid, "display_name": _display(wid), "city": city,
        "priority_rank_in_city": p["priority_rank_in_city"], "ward_count_in_city": len(city_ids),
        "risk_tier": p["priority"]["risk_tier"], "early_alert": p["priority"]["early_alert"],
        "predicted_cases_3wk": p["priority"]["predicted_cases_3wk"],
        "weekly_expected_cases": [{"horizon_week": hz, "forecast_week": fw, "expected_cases": v}
                                  for hz, fw, v in zip((2, 3, 4), sim["forecast_weeks"], s["baseline_weekly_cases"])],
        "exceeds_observed_range": p["exceeds_observed_range"],
    }
    resource = {
        "label": SECTION_LABELS["resource_plan"], "stock_pct": params["stock_pct"],
        "min_coverage_pct": params["min_coverage_pct"], "units": "planning units (not verified inventory)",
        "priority_rank_in_city": p["priority_rank_in_city"], "priority_basis": copy.deepcopy(p["priority"]),
        "priority_order": list(P.PRIORITY_KEY),
        "saline": _resource_ward(p["saline"]), "kits": _resource_ward(p["kits"]),
        "city_context": {r: {k: pc[r][k] for k in ("demand", "stock", "allocated", "coverage_pct", "wards_with_deficit")}
                         for r in ("saline", "kits")},
    }
    rc = plan["region"]["crews"]
    crews = {
        "label": SECTION_LABELS["crew_scenario"], "status": "hypothetical",
        "ward": {"scenario_demand": p["crews"]["scenario_demand"], "assigned": p["crews"]["assigned"],
                 "scenario_deficit": p["crews"]["scenario_deficit"], "reason": p["crews"]["reason"],
                 "next_crew_status": s["crews"]["next_crew_status"]},
        "city": {k: pc["crews"][k] for k in ("pool", "scenario_demand", "assigned")},
        "region": {"total_crews": rc["total_crews"], "assigned": rc["assigned"], "unassigned": rc["unassigned"]},
    }
    weeks, transfers = _hospital_weeks(hospital, city, city_ids)
    head = hospital["headline_week_by_city"][city]
    hidx = [2, 3, 4].index(head["horizon_week"])
    hosp = {
        "label": SECTION_LABELS["hospital_overflow"],
        "units": "bed planning units per forecast week (not patients, admissions or occupied beds)",
        "capacity_pct": params["capacity_pct"], "capacity_status": "hypothetical_retrospective_scenario",
        "retrospective_baseline_overlap": _retrospective(forecasts),
        "ward_hypothetical_capacity": h["hypothetical_capacity"],
        "max_weekly_bed_planning_demand": h["max_weekly_bed_planning_demand"],
        "weeks": copy.deepcopy(h["weeks"]),
        "simulated_transfers": [t for t in transfers if wid in (t["from_ward"], t["to_ward"])],
        "city_headline": next(w for w in weeks if w["horizon_week"] == head["horizon_week"]),
        "ward_at_city_headline": copy.deepcopy(h["weeks"][hidx]),
        "warnings": list(hospital["warnings"]),
    }
    base = s["baseline_planning_units"]
    sc = s["scenarios"][sel]
    interv = _intervention_head(sim, sel)
    interv.update({
        "assigned_crews": s["crews"]["assigned"],
        "baseline_weekly_cases": list(s["baseline_weekly_cases"]),
        "selected": {
            "scenario_adjusted_weekly_cases": list(sc["scenario_adjusted_weekly_cases"]),
            "projected_cases_avoided": sc["projected_cases_avoided"],
            "projected_cases_avoided_per_assigned_crew": sc["projected_cases_avoided_per_assigned_crew"],
            "saline": {"baseline_units": base["saline"], **sc["saline"]},
            "kits": {"baseline_units": base["kits"], **sc["kits"]},
            "peak_bed_planning_units": {"baseline": base["peak_bed_planning_units"], **sc["peak_bed_planning_units"]},
        },
        "comparison": [{"scenario": k, "max_reduction": sim["scenarios"][k]["max_reduction"],
                        "projected_cases_avoided": s["scenarios"][k]["projected_cases_avoided"],
                        "projected_cases_avoided_per_assigned_crew":
                            s["scenarios"][k]["projected_cases_avoided_per_assigned_crew"]}
                       for k in INTERVENTION_CHOICES],
    })
    return {"forecast_estimates": forecast, "resource_plan": resource, "crew_scenario": crews,
            "hospital_overflow": hosp, "intervention_scenario": interv}


def _retrospective(forecasts: list[dict]) -> bool:
    return str(forecasts[0]["issue_week"]) < f"{P.HOSPITAL_BASELINE_LAST_YEAR + 1}-01-01"


def _checklist(included: tuple) -> list[str]:
    items = ["Forecast figures reviewed by the responsible surveillance or epidemiology role."]
    if "resource_plan" in included:
        items.append("Physical saline and diagnostic kit stock counted before any allocation decision.")
    if "crew_scenario" in included:
        items.append("Real crew availability confirmed; crew numbers in this draft are hypothetical.")
    if "hospital_overflow" in included:
        items.append("Real bed capacity confirmed with each facility; capacity in this draft is hypothetical.")
        items.append("Decisions about moving patients are clinical decisions made outside this tool.")
    if "intervention_scenario" in included:
        items.append("Intervention effects treated as assumed scenarios, not proven outcomes.")
    items.append("Draft reviewed, and any action decided, by the responsible coordinator role.")
    return items


def _assumptions() -> list[str]:
    s = P.INTERVENTION_SCENARIOS
    return [
        "Planning demand converts forecast cases with dataset-derived coefficients for saline, kits and bed "
        "planning units; these are planning conventions, not clinical guidelines.",
        "Stock percentage, crew budget and bed capacity are hypothetical scenario inputs, not verified inventories.",
        "Stock, crews and bed capacity are pooled per city corporation; there are no cross-city transfers.",
        f"Intervention effects (maximum reduction low {_share(s['low'])}, base {_share(s['base'])}, high "
        f"{_share(s['high'])}) are assumptions, not learned or causal estimates.",
    ]


def _limitations() -> list[str]:
    return [
        "Historical replay on data that appear simulated; not a live or official plan.",
        "Forecasts are expected values without prediction intervals.",
        "No travel time, delivery logistics, facility locations or real occupancy data are used.",
        "Nothing in this brief has been sent, carried out or authorised.",
    ]


STATUS = {
    "draft": True, "sent": False, "authorised": False, "simulated": True, "historical_replay": True,
    "human_verification_required": True, "dispatch_capability": "none",
    "labels": list(LABELS),
    "statement": "Draft generated for planning review only. It has not been sent to anyone and authorises no action.",
}


def build_dispatch_brief(forecasts: list[dict], densities: dict, *, scope: str, city: str | None = None,
                         ward_id: str | None = None, audience: str = "all", variant: str = "detailed",
                         stock_pct: int = P.STOCK_PCT_DEFAULT, min_coverage_pct: int = P.MIN_COVERAGE_PCT_DEFAULT,
                         total_crews: int = P.TOTAL_CREWS_DEFAULT, capacity_pct: int = P.CAPACITY_PCT_DEFAULT,
                         intervention_scenario: str = "base", notice: str = DEFAULT_NOTICE) -> dict:
    """Pure function: one forecast list (with `weekly`) + densities + scenario -> JSON-ready draft brief."""
    params = {"stock_pct": stock_pct, "min_coverage_pct": min_coverage_pct, "total_crews": total_crews,
              "capacity_pct": capacity_pct, "intervention_scenario": intervention_scenario}
    _validate_parameters(params, audience, variant)
    if not isinstance(forecasts, list) or not forecasts:
        raise DispatchConsistencyError("no forecasts")
    city, ward_id = _resolve_selection(forecasts, scope, city, ward_id)
    bundle = build_bundle(forecasts, densities, stock_pct=stock_pct, min_coverage_pct=min_coverage_pct,
                          total_crews=total_crews, capacity_pct=capacity_pct)
    sim = bundle["simulation"]
    issue_week = str(forecasts[0]["issue_week"])
    weekly_source = sim["weekly_source"]
    weekly_versions = {(f.get("weekly") or {}).get("model_version") for f in forecasts}
    _check(len(weekly_versions) == 1, "weekly model versions differ")
    weekly_version = weekly_versions.pop()

    all_sections = (_city_sections(bundle, forecasts, city, params) if scope == "city"
                    else _ward_sections(bundle, forecasts, city, ward_id, params))
    included = AUDIENCE_SECTIONS[audience]
    sections = {k: all_sections[k] for k in included}

    warnings: list[str] = []
    if "hospital_overflow" in included:
        warnings += bundle["hospital"]["warnings"]
    if "intervention_scenario" in included:
        warnings += sim["warnings"]
    if weekly_source == "equal_split" and not warnings:
        warnings.append("Weekly companion unavailable: weekly values are an equal split of the 3-week forecast.")
    above = (all_sections["forecast_estimates"].get("wards_exceeding_observed_range", 0) if scope == "city"
             else int(all_sections["forecast_estimates"]["exceeds_observed_range"]))
    if above:
        warnings.append(f"{above} ward forecast(s) exceed the largest 3-week total observed in the data; "
                        "treat them with extra caution.")
    warnings = list(dict.fromkeys(warnings))

    scen = scenario_id(issue_week, params, weekly_source)
    scenario = {"issue_week": issue_week, "forecast_weeks": list(sim["forecast_weeks"]), "horizon_weeks": [2, 3, 4],
                "model_version": str(forecasts[0]["model_version"]), "weekly_source": weekly_source,
                "weekly_model_version": weekly_version, "parameters": dict(params), "notice": notice}
    target = {"type": scope, "city": city, "ward_id": ward_id,
              "display_name": city if scope == "city" else _display(ward_id)}
    if scope == "city":
        target["ward_count"] = all_sections["forecast_estimates"]["ward_count"]
    brief = {
        "brief_version": BRIEF_VERSION,
        "status": copy.deepcopy(STATUS),
        "scenario_id": scen,
        "document_id": document_id(scen, scope, city, ward_id, audience, variant),
        "scenario_fingerprint": fingerprint({k: scenario[k] for k in scenario if k != "notice"}),
        "scope": target,
        "audience": audience,
        "variant": variant,
        "intended_role": ROLE_LABELS[(scope, audience)] + " (role label only; no recipient or contact details)",
        "scenario": scenario,
        "sections_included": list(included),
        "sections": sections,
        "verification_checklist": _checklist(included),
        "warnings": warnings,
        "assumptions": _assumptions(),
        "limitations": _limitations(),
    }
    _assert_safe("\n".join(_strings(brief)))
    return brief


# =========================================================================== safety checks
_CLAIM_RE = re.compile(r"\b(?:sent|dispatched|delivered|deployed|transferred|authori[sz]ed|approved|executed|official)\b",
                       re.I)
_STATE_RE = re.compile(r"\b(?:has|have|had|was|were|is|are)\s+(?:(?:been|now|already)\s+)*"
                       r"(?:verified|confirmed|completed|performed|carried\s+out)\b", re.I)
_PATIENT_RE = re.compile(r"\bpatients?\b[^.;:!?\n]{0,60}?\b(?:transferred|moved|admitted|relocated|sent)\b", re.I)
_NEGATION_RE = re.compile(r"\b(?:not|no|nothing|never|none|without|if|would|unless|cannot)\b", re.I)
_CLAUSE_CHARS = ".;:!?\n|()[]"


def false_claim_findings(text: str) -> list[str]:
    """Clauses that state a completed send, dispatch, transfer, authorisation or verification.

    Context-aware: a claim word inside a negated or conditional clause ("not sent", "nothing ... carried
    out", "if crews were deployed") is accepted, and technical nouns such as "simulated transfer" or
    "transfer_units" are not claim words at all."""
    found = []
    for rx in (_CLAIM_RE, _STATE_RE, _PATIENT_RE):
        for m in rx.finditer(text):
            start = max(text.rfind(ch, 0, m.start()) for ch in _CLAUSE_CHARS) + 1
            if not _NEGATION_RE.search(text[start:m.start()]):
                found.append(text[start:m.end()].strip())
    return found


def _assert_safe(text: str) -> None:
    if false_claim_findings(text):
        raise DispatchRenderError("output contains a completion claim")


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


# =========================================================================== text renderers
_GSM_SAFE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !\"#$%&'()*+,-./:;<=>?@_\n")


def _plain(s) -> str:
    """Dynamic value -> ASCII, single line, no WhatsApp formatting markers (* _ ~ `)."""
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(s)).encode("ascii", "replace").decode("ascii")
    return re.sub(r"[*_~`]", " ", s)


def _sms(s) -> str:
    """Dynamic value -> GSM-7 basic characters only (ASCII extension characters such as [ ] { } | count double)."""
    return "".join(ch if ch in _GSM_SAFE and ch != "\n" else "?" for ch in _plain(s))


def _place(brief: dict, clean) -> str:
    sc, t = brief["scenario"], brief["scope"]
    fw = sc["forecast_weeks"]
    name = clean(t["city"]) if t["type"] == "city" else f"{clean(t['display_name'])} ({clean(t['city'])})"
    return f"{name}: issue {sc['issue_week']}, forecast weeks {fw[0]} to {fw[-1]}."


# Priority order of the short-text lines per audience (later lines are dropped first if space runs out).
_SHORT_ORDER = {
    "resource": ("forecast_ward", "res1", "res2", "crews", "interv", "forecast_city"),
    "hospital": ("forecast_ward", "beds1", "beds_retro", "beds2", "beds_note", "forecast_city"),
    "all": ("forecast_ward", "res1", "beds1", "beds_retro", "crews", "beds2", "res2", "interv", "forecast_city"),
}


def _short_body(brief: dict) -> list[str]:
    secs, t, prm = brief["sections"], brief["scope"], brief["scenario"]["parameters"]
    ln: dict[str, str] = {}
    fc = secs["forecast_estimates"]
    city = t["type"] == "city"
    if city:
        tc = fc["tier_counts"]
        ln["forecast_city"] = (f"Forecast {_c1(fc['predicted_cases_3wk_total'])} cases; Critical {tc['Critical']}, "
                               f"High {tc['High']} wards; alerts {fc['early_alert_wards']}.")
    else:
        ln["forecast_ward"] = (f"Forecast {_c1(fc['predicted_cases_3wk'])} cases, {fc['risk_tier']} tier, early alert "
                               f"{'yes' if fc['early_alert'] else 'no'}.")
    if "resource_plan" in secs:
        r = secs["resource_plan"]
        if city:
            ln["res1"] = (f"Saline {r['saline']['allocated']} of {r['saline']['demand']} units, kits "
                          f"{r['kits']['allocated']} of {r['kits']['demand']} suggested ({prm['stock_pct']}% stock).")
            ln["res2"] = (f"Wards short: saline {r['saline']['wards_with_deficit']}, kits {r['kits']['wards_with_deficit']} "
                          f"of {fc['ward_count']}; below {prm['min_coverage_pct']}% floor: "
                          f"{r['saline']['wards_below_floor']}, {r['kits']['wards_below_floor']}.")
        else:
            ln["res1"] = (f"Saline {r['saline']['allocated']} of {r['saline']['demand']} ({r['saline']['status_label']}), "
                          f"kits {r['kits']['allocated']} of {r['kits']['demand']} ({r['kits']['status_label']}).")
            ln["res2"] = f"Priority rank {r['priority_rank_in_city']} of {fc['ward_count_in_city']} in city."
    if "crew_scenario" in secs:
        c = secs["crew_scenario"]["city" if city else "ward"]
        ln["crews"] = (f"Crews (hypothetical): {c['assigned']} suggested, need {c['scenario_demand']}." if city
                       else f"Crews (hypothetical): {c['assigned']} of {c['scenario_demand']} suggested.")
    if "hospital_overflow" in secs:
        h = secs["hospital_overflow"]
        if city:
            hd = h["headline"]
            ln["beds1"] = (f"Beds {hd['forecast_week']} (t+{hd['horizon_week']}): {hd['bed_planning_demand']} units vs "
                           f"hypothetical capacity {hd['hypothetical_capacity']}.")
            ln["beds2"] = (f"Simulated within-city reassignment {hd['transfer_units']} units; unmet "
                           f"{hd['unmet_after_routing']} units.")
        else:
            wk = h["ward_at_city_headline"]
            ln["beds1"] = (f"Beds {wk['forecast_week']}: {wk['bed_planning_demand']} units vs hypothetical ward "
                           f"capacity {h['ward_hypothetical_capacity']}.")
            ln["beds2"] = (f"Simulated reassignment out {wk['transferred_out']}, in {wk['transferred_in']}; unmet "
                           f"{wk['unmet_after_routing']} units.")
        ln["beds_note"] = "Units are planning units, not patients."
        if h["retrospective_baseline_overlap"]:
            ln["beds_retro"] = "Capacity baseline is retrospective."
    if "intervention_scenario" in secs:
        i = secs["intervention_scenario"]
        ln["interv"] = (f"Assumed {i['selected_scenario']} effect, not causal: "
                        f"{_c1(i['selected']['projected_cases_avoided'])} cases avoided.")
    return [_sms(ln[k]) for k in _SHORT_ORDER[brief["audience"]] if k in ln]


def render_short_text(brief: dict) -> str:
    """ASCII / GSM-7 text of at most 459 characters (3 concatenated SMS segments). Lines are kept in priority
    order; if not all fit, later lines are dropped and the text points to the detailed brief."""
    head = ["DRAFT/NOT SENT. SIMULATED PLANNING SCENARIO. HISTORICAL REPLAY.", _sms(brief["scenario_id"]),
            _place(brief, _sms)]
    tail = "Estimates only. HUMAN VERIFICATION REQUIRED before any action."
    more = "More in the detailed brief."
    body = _short_body(brief)

    def size(lines):
        return len("\n".join(lines))

    if size(head + body + [tail]) <= SHORT_MAX_CHARS:
        lines = head + body
    else:
        lines = list(head)
        for ln in body:
            if size(lines + [ln, more, tail]) <= SHORT_MAX_CHARS:
                lines.append(ln)
        lines.append(more)
    text = "\n".join(lines + [tail])
    if len(text) > SHORT_MAX_CHARS or not set(text) <= _GSM_SAFE or not text.startswith("DRAFT/NOT SENT"):
        raise DispatchRenderError("short text exceeds the SMS limits")
    _assert_safe(text)
    return text


def _more(n_total: int, n_shown: int, what: str) -> list[str]:
    return [f"- and {n_total - n_shown} more {what}"] if n_total > n_shown else []


def _weekly_line(rows: list[dict], key: str) -> str:
    return "; ".join(f"{r['forecast_week']} {_c1(r[key])}" for r in rows)


def render_detailed_text(brief: dict) -> str:
    """WhatsApp-ready plain text (ASCII; *bold* headings; no underscores, links or recipients)."""
    sc, t, secs = brief["scenario"], brief["scope"], brief["sections"]
    prm = sc["parameters"]
    src = "weekly companion model" if sc["weekly_source"] == "companion" else "equal split fallback"
    if t["type"] == "city":
        scope_line = f"Scope: {_plain(t['city'])} (city corporation, {t['ward_count']} wards)"
    else:
        scope_line = f"Scope: {_plain(t['display_name'])}, {_plain(t['city'])} (ward)"
    out = ["*DRAFT / NOT SENT*", "*SIMULATED PLANNING SCENARIO - HISTORICAL REPLAY*", "*HUMAN VERIFICATION REQUIRED*", "",
           f"Prepared for: {_plain(brief['intended_role'])}",
           scope_line,
           f"Scenario ID: {_plain(brief['scenario_id'])}",
           f"Document ID: {_plain(brief['document_id'])}",
           f"Issue week: {sc['issue_week']}",
           f"Forecast weeks: {', '.join(sc['forecast_weeks'])} (t+2 to t+4)",
           f"Model: {_plain(sc['model_version'])}; weekly split: {src}",
           f"Scenario inputs (hypothetical): stock {prm['stock_pct']}%, minimum coverage {prm['min_coverage_pct']}%, "
           f"regional crews {prm['total_crews']}, bed capacity {prm['capacity_pct']}%, intervention "
           f"{prm['intervention_scenario']}"]
    n = 0
    for key in brief["sections_included"]:
        n += 1
        s = secs[key]
        out += ["", f"*{n}. {SECTION_TITLES[key]}*", f"[{s['label']}]"]
        out += _detailed_section(key, s, brief)
    out += ["", "*Human verification checklist*"] + [f"[ ] {_plain(x)}" for x in brief["verification_checklist"]]
    out += ["Reviewed by (role): ..........  Date: .........."]
    if brief["warnings"]:
        out += ["", "*Warnings*"] + [f"- {_plain(x)}" for x in brief["warnings"]]
    out += ["", "*Limitations*"] + [f"- {_plain(x)}" for x in brief["limitations"]]
    out += ["", _plain(sc["notice"]), "Draft for planning review only. Not sent. No action authorised."]
    text = "\n".join(out) + "\n"
    if not text.isascii() or "_" in text:
        raise DispatchRenderError("detailed text contains unsafe characters")
    _assert_safe(text)
    return text


def _detailed_section(key: str, s: dict, brief: dict) -> list[str]:
    city = brief["scope"]["type"] == "city"
    prm = brief["scenario"]["parameters"]
    o: list[str] = []
    if key == "forecast_estimates":
        if city:
            tc = s["tier_counts"]
            o.append(f"- Expected cases t+2 to t+4: {_c1(s['predicted_cases_3wk_total'])} "
                     f"(by week: {_weekly_line(s['weekly_expected_cases'], 'expected_cases')})")
            o.append(f"- Risk tiers: Critical {tc['Critical']}, High {tc['High']}, Medium {tc['Medium']}, Low {tc['Low']}; "
                     f"early alerts {s['early_alert_wards']}")
            o.append("- Highest priority wards:")
            for w in s["wards"][:5]:
                o.append(f"  {w['priority_rank_in_city']}. {_plain(w['display_name'])}: {_plain(w['risk_tier'])}"
                         f"{', early alert' if w['early_alert'] else ''}, {_c1(w['predicted_cases_3wk'])} cases")
            o += _more(len(s["wards"]), 5, "wards in the printable brief")
        else:
            o.append(f"- Expected cases t+2 to t+4: {_c1(s['predicted_cases_3wk'])} "
                     f"(by week: {_weekly_line(s['weekly_expected_cases'], 'expected_cases')})")
            o.append(f"- Risk tier {_plain(s['risk_tier'])}; early alert {'yes' if s['early_alert'] else 'no'}; "
                     f"priority rank {s['priority_rank_in_city']} of {s['ward_count_in_city']} in {_plain(s['city'])}")
        o.append("- Model estimates, not confirmed events.")
    elif key == "resource_plan":
        if city:
            for r, name in (("saline", "Saline"), ("kits", "Kits")):
                x = s[r]
                o.append(f"- {name}: suggest {x['allocated']} of {x['demand']} planning units "
                         f"(hypothetical stock {x['stock']}, coverage {_pct_text(x['coverage_pct'])}, deficit {x['deficit']})")
            o.append(f"- Wards with a shortage: saline {s['saline']['wards_with_deficit']}, kits "
                     f"{s['kits']['wards_with_deficit']}; below the {prm['min_coverage_pct']}% floor: saline "
                     f"{s['saline']['wards_below_floor']}, kits {s['kits']['wards_below_floor']}")
            short = sorted((w for w in s["wards"] if w["saline"]["deficit"] or w["kits"]["deficit"]),
                           key=lambda w: (-(w["saline"]["deficit"] + w["kits"]["deficit"]), w["priority_rank_in_city"]))
            if short:
                o.append("- Largest shortages:")
                for w in short[:5]:
                    o.append(f"  {_plain(w['display_name'])}: saline {w['saline']['allocated']} of "
                             f"{w['saline']['demand']} ({w['saline']['status_label']}), kits {w['kits']['allocated']} of "
                             f"{w['kits']['demand']} ({w['kits']['status_label']})")
                o += _more(len(short), 5, "wards with a shortage")
            else:
                o.append("- No ward shortages in this scenario.")
        else:
            for r, name in (("saline", "Saline"), ("kits", "Kits")):
                x = s[r]
                o.append(f"- {name}: suggest {x['allocated']} of {x['demand']} planning units, deficit {x['deficit']} "
                         f"({x['status_label']}: {REASON_TEXT.get(x['reason'], _plain(x['reason']))})")
            pb = s["priority_basis"]
            o.append(f"- Priority rank {s['priority_rank_in_city']}: tier {_plain(pb['risk_tier'])}, early alert "
                     f"{'yes' if pb['early_alert'] else 'no'}, density {pb['population_density_sqkm']} per sq km, "
                     f"forecast {_c1(pb['predicted_cases_3wk'])} cases")
            cs = s["city_context"]["saline"]
            o.append(f"- City context: saline {cs['allocated']} of {cs['demand']} suggested across the city "
                     f"({_pct_text(cs['coverage_pct'])})")
    elif key == "crew_scenario":
        if city:
            c, r = s["city"], s["region"]
            o.append(f"- City pool {c['pool']} of regional budget {r['total_crews']}; scenario need {c['scenario_demand']}; "
                     f"suggested {c['assigned']}; deficit {c['scenario_deficit']}")
            assigned = [w for w in s["wards"] if w["assigned"] > 0]
            if assigned:
                shown = assigned[:8]
                o.append("- Suggested: " + ", ".join(f"{_plain(w['display_name'])} {w['assigned']} of {w['scenario_demand']}"
                                                       for w in shown))
                o += _more(len(assigned), len(shown), "wards with suggested crews")
            else:
                o.append("- No crews suggested in this scenario.")
        else:
            w, c = s["ward"], s["city"]
            o.append(f"- Suggested {w['assigned']} of {w['scenario_demand']} hypothetical crews "
                     f"({REASON_TEXT.get(w['reason'], _plain(w['reason']))})")
            o.append(f"- City pool {c['pool']}, city need {c['scenario_demand']}")
        o.append("- Crew numbers are a hypothetical budget, not real teams.")
    elif key == "hospital_overflow":
        o.append("- Units are bed planning units, not patients, admissions or occupied beds.")
        if city:
            hd = s["headline"]
            o.append(f"- Hypothetical capacity {s['hypothetical_capacity']} units ({s['capacity_pct']}% of baseline "
                     f"{s['city_baseline']})")
            o.append(f"- Headline week {hd['forecast_week']} (t+{hd['horizon_week']}): demand {hd['bed_planning_demand']}, "
                     f"local {hd['locally_assigned']}, simulated within-city reassignment {hd['transfer_units']}, "
                     f"unmet {hd['unmet_after_routing']} in {hd['wards_with_unmet']} wards")
            moves = [x for x in s["simulated_transfers"] if x["horizon_week"] == hd["horizon_week"]]
            if moves:
                o.append("- Proposed simulated reassignments (headline week):")
                for x in moves[:8]:
                    o.append(f"  {_plain(x['from_display_name'])} -> {_plain(x['to_display_name'])}: {x['units']} unit(s)")
                o += _more(len(moves), min(8, len(moves)), "simulated proposals")
            o.append("- By week: " + "; ".join(f"t+{w['horizon_week']} demand {w['bed_planning_demand']}, unmet "
                                               f"{w['unmet_after_routing']}" for w in s["weeks"]))
        else:
            wk = s["ward_at_city_headline"]
            o.append(f"- Hypothetical ward capacity {s['ward_hypothetical_capacity']} units ({s['capacity_pct']}% scenario)")
            o.append("- By week: " + "; ".join(f"{w['forecast_week']} demand {w['bed_planning_demand']}, simulated out "
                                               f"{w['transferred_out']}, in {w['transferred_in']}, unmet "
                                               f"{w['unmet_after_routing']}" for w in s["weeks"]))
            for x in s["simulated_transfers"]:
                o.append(f"  Simulated proposal {x['forecast_week']}: {_plain(x['from_display_name'])} -> "
                         f"{_plain(x['to_display_name'])}: {x['units']} unit(s)")
            o.append(f"- City headline week {s['city_headline']['forecast_week']}: unmet {wk['unmet_after_routing']} "
                     "units in this ward")
        if s["retrospective_baseline_overlap"]:
            o.append("- Capacity baseline is retrospective: it was calibrated on years that include this issue week.")
        o.append("- Real capacity has not been verified.")
    elif key == "intervention_scenario":
        sel = s["selected"]
        if city:
            o.append(f"- Selected {s['selected_scenario']} (maximum reduction {_share(s['max_reduction'])}): "
                     f"{_c1(sel['projected_cases_avoided'])} of {_c1(sel['baseline_cases_3wk'])} expected cases projected "
                     f"avoided with {sel['assigned_crews']} hypothetical crew(s) "
                     f"({_opt(sel['projected_cases_avoided_per_assigned_crew'], 3)} per crew)")
        else:
            o.append(f"- Selected {s['selected_scenario']} (maximum reduction {_share(s['max_reduction'])}) with "
                     f"{s['assigned_crews']} hypothetical crew(s): {_c1(sel['projected_cases_avoided'])} cases projected "
                     f"avoided; adjusted weekly cases {' / '.join(_c1(x) for x in sel['scenario_adjusted_weekly_cases'])}")
        o.append("- Comparison: " + ", ".join(f"{c['scenario']} {_c1(c['projected_cases_avoided'])}" for c in s["comparison"]))
        o.append("- Effects are assumptions, not learned from data; nothing has been carried out.")
    return o


# =========================================================================== HTML renderer
_CSS = """
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; }
html { background: #fff; color: #000; }
body { margin: 0 auto; max-width: 180mm; padding: 8mm 0; background: #fff; color: #000;
  font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, "Noto Sans", "Nirmala UI", sans-serif;
  font-size: 10.5pt; line-height: 1.4; }
@media print { body { max-width: none; padding: 0; } .screen-note { display: none; } }
.status { border: 2pt solid #000; padding: 3mm 4mm; margin: 0 0 5mm; }
.status p { margin: 0; font-weight: 700; font-size: 11pt; letter-spacing: 0.02em; }
.status p + p { margin-top: 1mm; font-weight: 400; font-size: 9.5pt; letter-spacing: 0; }
h1 { font-size: 16pt; margin: 0 0 2mm; line-height: 1.2; }
h2 { font-size: 12.5pt; margin: 7mm 0 1mm; padding-bottom: 1mm; border-bottom: 1.5pt solid #000;
  break-after: avoid; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 4mm 0 1.5mm; break-after: avoid; page-break-after: avoid; }
.sec-status { margin: 0 0 2.5mm; font-size: 8.5pt; font-weight: 700; }
.note { border: 1pt solid #000; padding: 2mm 3mm; margin: 0 0 3mm; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.6mm 5mm; margin: 0 0 3mm; }
dl.kv dt { font-weight: 700; }
dl.kv dd { margin: 0; }
table { width: 100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 9.5pt; }
caption { text-align: left; font-weight: 700; padding: 0 0 1mm; }
th, td { border: 0.75pt solid #000; padding: 1mm 1.6mm; text-align: left; vertical-align: top; }
thead th { background: #e8e8e8; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
thead { display: table-header-group; }
tr, .keep { break-inside: avoid; page-break-inside: avoid; }
.flag { font-weight: 700; text-decoration: underline; }
ul { margin: 0 0 3mm; padding-left: 6mm; }
ul.check { list-style: none; padding-left: 0; }
ul.check li { position: relative; padding-left: 7mm; margin: 0 0 2mm; }
ul.check li::before { content: ""; position: absolute; left: 0; top: 0.5mm; width: 3.6mm; height: 3.6mm;
  border: 1pt solid #000; }
.sign { margin: 4mm 0 0; }
.line { display: inline-block; min-width: 50mm; border-bottom: 1pt solid #000; margin: 0 6mm 0 1mm; }
footer { margin-top: 7mm; padding-top: 2mm; border-top: 1pt solid #000; font-size: 8.5pt; }
.screen-note { font-size: 9pt; border: 1pt dashed #000; padding: 2mm 3mm; margin: 0 0 4mm; }
"""


def _e(x) -> str:
    return html.escape(str(x), quote=True)


def _cell(value, tag: str = "td", num: bool = False, scope: str | None = None) -> str:
    text = str(value)
    inner = f'<strong class="flag">{_e(text)}</strong>' if text in SHORTAGE_FLAGS else _e(text)
    attrs = (f' scope="{scope}"' if scope else "") + (' class="num"' if num else "")
    return f"<{tag}{attrs}>{inner}</{tag}>"


def _table(caption: str, headers: list[str], rows: list[list], num: tuple = ()) -> str:
    out = [f"<table><caption>{_e(caption)}</caption><thead><tr>"]
    out += [_cell(h, "th", i in num, "col") for i, h in enumerate(headers)]
    out.append("</tr></thead><tbody>")
    for r in rows:
        out.append("<tr>" + "".join(_cell(v, "th" if i == 0 else "td", i in num, "row" if i == 0 else None)
                                    for i, v in enumerate(r)) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _dl(pairs: list[tuple]) -> str:
    return '<dl class="kv">' + "".join(f"<dt>{_e(k)}</dt><dd>{_e(v)}</dd>" for k, v in pairs) + "</dl>"


def _ul(items: list[str], cls: str = "") -> str:
    c = f' class="{cls}"' if cls else ""
    return f"<ul{c}>" + "".join(f"<li>{_e(x)}</li>" for x in items) + "</ul>"


def _alloc(x: dict) -> str:
    return f"{x['allocated']} / {x['demand']}"


def _html_section(key: str, s: dict, brief: dict, detailed: bool) -> str:
    city = brief["scope"]["type"] == "city"
    prm = brief["scenario"]["parameters"]
    p: list[str] = []
    if key == "forecast_estimates":
        if city:
            tc = s["tier_counts"]
            p.append(_dl([("Wards", s["ward_count"]),
                          ("Expected cases t+2 to t+4", _c1(s["predicted_cases_3wk_total"])),
                          ("By forecast week", _weekly_line(s["weekly_expected_cases"], "expected_cases")),
                          ("Risk tiers", f"Critical {tc['Critical']}, High {tc['High']}, Medium {tc['Medium']}, Low {tc['Low']}"),
                          ("Early alerts", s["early_alert_wards"]),
                          ("Above observed 3-week range", s["wards_exceeding_observed_range"])]))
            if detailed:
                p.append(_table("Ward forecasts in priority order (model estimates, not confirmed events)",
                                ["Ward", "Rank", "Risk tier", "Early alert", "Expected cases t+2 to t+4"],
                                [[w["ward_id"], w["priority_rank_in_city"], w["risk_tier"],
                                  "yes" if w["early_alert"] else "no", _c1(w["predicted_cases_3wk"])] for w in s["wards"]],
                                num=(1, 4)))
        else:
            p.append(_dl([("Ward", f"{s['ward_id']} ({s['city']})"),
                          ("Priority rank in city", f"{s['priority_rank_in_city']} of {s['ward_count_in_city']}"),
                          ("Risk tier", s["risk_tier"]), ("Early alert", "yes" if s["early_alert"] else "no"),
                          ("Expected cases t+2 to t+4", _c1(s["predicted_cases_3wk"])),
                          ("By forecast week", _weekly_line(s["weekly_expected_cases"], "expected_cases")),
                          ("Above observed 3-week range", "yes" if s["exceeds_observed_range"] else "no")]))
        p.append("<p>Model estimates, not confirmed events.</p>")
    elif key == "resource_plan":
        p.append(f'<p class="note">Hypothetical stock scenario: {prm["stock_pct"]}% of forecast planning demand, '
                 f'minimum coverage floor {prm["min_coverage_pct"]}%. Planning units, not verified inventory.</p>')
        if city:
            p.append(_table("City summary (planning units)",
                            ["Resource", "Planning demand", "Hypothetical stock", "Suggested allocation", "Deficit",
                             "Coverage", "Wards short", "Wards below floor"],
                            [[name, x["demand"], x["stock"], x["allocated"], x["deficit"], _pct_text(x["coverage_pct"]),
                              x["wards_with_deficit"], x["wards_below_floor"]]
                             for name, x in (("Saline", s["saline"]), ("Diagnostic kits", s["kits"]))],
                            num=(1, 2, 3, 4, 5, 6, 7)))
            if detailed:
                p.append(_table("Ward allocation in priority order (suggested / planning demand)",
                                ["Ward", "Rank", "Risk tier", "Saline", "Saline status", "Kits", "Kits status"],
                                [[w["ward_id"], w["priority_rank_in_city"], w["risk_tier"], _alloc(w["saline"]),
                                  w["saline"]["status_label"], _alloc(w["kits"]), w["kits"]["status_label"]]
                                 for w in s["wards"]], num=(1, 3, 5)))
        else:
            p.append(_table("Ward allocation (planning units)",
                            ["Resource", "Planning demand", "Floor", "Suggested", "Deficit", "Status", "Explanation"],
                            [[name, x["demand"], x["floor"], x["allocated"], x["deficit"], x["status_label"],
                              REASON_TEXT.get(x["reason"], x["reason"])]
                             for name, x in (("Saline", s["saline"]), ("Diagnostic kits", s["kits"]))],
                            num=(1, 2, 3, 4)))
            pb = s["priority_basis"]
            p.append(_dl([("Priority rank in city", s["priority_rank_in_city"]),
                          ("Priority basis", f"tier {pb['risk_tier']}, early alert {'yes' if pb['early_alert'] else 'no'}, "
                                             f"density {pb['population_density_sqkm']} per sq km, forecast "
                                             f"{_c1(pb['predicted_cases_3wk'])} cases"),
                          ("Priority order", "; ".join(s["priority_order"]))]))
    elif key == "crew_scenario":
        if city:
            c, r = s["city"], s["region"]
            p.append(_dl([("Regional hypothetical budget", f"{r['total_crews']} crews ({r['assigned']} suggested, "
                                                           f"{r['unassigned']} unassigned)"),
                          ("City pool", c["pool"]), ("City scenario need", c["scenario_demand"]),
                          ("Suggested in city", c["assigned"]), ("City deficit", c["scenario_deficit"])]))
            if detailed:
                rows = [w for w in s["wards"] if w["scenario_demand"] > 0]
                p.append(_table("Hypothetical crews by ward (eligible wards only)",
                                ["Ward", "Rank", "Risk tier", "Scenario need", "Suggested", "Explanation"],
                                [[w["ward_id"], w["priority_rank_in_city"], w["risk_tier"], w["scenario_demand"],
                                  w["assigned"], REASON_TEXT.get(w["reason"], w["reason"])] for w in rows],
                                num=(1, 3, 4)))
        else:
            w, c = s["ward"], s["city"]
            p.append(_dl([("Suggested hypothetical crews", f"{w['assigned']} of {w['scenario_demand']}"),
                          ("Explanation", REASON_TEXT.get(w["reason"], w["reason"])),
                          ("City pool / need", f"{c['pool']} / {c['scenario_demand']}")]))
        p.append("<p>Crew numbers are a hypothetical budget, not real teams.</p>")
    elif key == "hospital_overflow":
        p.append('<p class="note">Bed planning units per forecast week: not patients, admissions or occupied beds. '
                 'Capacity is hypothetical and has not been verified. Simulated reassignments are planning proposals '
                 'within one city corporation only.</p>')
        if s["retrospective_baseline_overlap"]:
            p.append('<p class="note"><strong>Retrospective capacity disclosure:</strong> the capacity baseline was '
                     'calibrated on years that include this issue week, so it is not information that was available '
                     'at the time.</p>')
        week_headers = ["Forecast week", "Demand", "Hypothetical capacity", "Local", "Simulated reassignment",
                        "Unmet", "Wards with unmet"]
        if city:
            p.append(_dl([("Hypothetical city capacity",
                           f"{s['hypothetical_capacity']} units ({s['capacity_pct']}% of baseline {s['city_baseline']})"),
                          ("Headline week", f"{s['headline']['forecast_week']} (t+{s['headline']['horizon_week']})")]))
            p.append(_table("City bed planning units by forecast week (each week routed independently)", week_headers,
                            [[f"{w['forecast_week']} (t+{w['horizon_week']})", w["bed_planning_demand"],
                              w["hypothetical_capacity"], w["locally_assigned"], w["transfer_units"],
                              w["unmet_after_routing"], w["wards_with_unmet"]] for w in s["weeks"]],
                            num=(1, 2, 3, 4, 5, 6)))
            moves = s["simulated_transfers"] if detailed else [
                x for x in s["simulated_transfers"] if x["horizon_week"] == s["headline"]["horizon_week"]]
            if moves:
                p.append(_table("Proposed simulated within-city reassignments (not executed)",
                                ["Forecast week", "From ward", "To ward", "Units"],
                                [[x["forecast_week"], x["from_ward"], x["to_ward"], x["units"]] for x in moves], num=(3,)))
            else:
                p.append("<p>No simulated reassignments in this scenario.</p>")
            if detailed:
                p.append(_table("Ward hypothetical capacity and unmet units (t+2 / t+3 / t+4)",
                                ["Ward", "Hypothetical capacity", "Demand", "Unmet", "Status at headline week"],
                                [[w["ward_id"], w["hypothetical_capacity"],
                                  " / ".join(str(v) for v in w["weekly_bed_planning_demand"]),
                                  " / ".join(str(v) for v in w["weekly_unmet_after_routing"]),
                                  "UNMET" if w["weekly_unmet_after_routing"][[2, 3, 4].index(s["headline"]["horizon_week"])]
                                  else "met"] for w in s["wards"]], num=(1,)))
        else:
            p.append(_dl([("Hypothetical ward capacity", f"{s['ward_hypothetical_capacity']} units "
                                                         f"({s['capacity_pct']}% scenario)"),
                          ("Largest weekly demand", s["max_weekly_bed_planning_demand"]),
                          ("City headline week", s["city_headline"]["forecast_week"])]))
            p.append(_table("Ward bed planning units by forecast week",
                            ["Forecast week", "Demand", "Local", "Simulated out", "Simulated in", "Unmet"],
                            [[f"{w['forecast_week']} (t+{w['horizon_week']})", w["bed_planning_demand"],
                              w["locally_assigned"], w["transferred_out"], w["transferred_in"], w["unmet_after_routing"]]
                             for w in s["weeks"]], num=(1, 2, 3, 4, 5)))
            if s["simulated_transfers"]:
                p.append(_table("Simulated reassignments involving this ward (not executed)",
                                ["Forecast week", "From ward", "To ward", "Units"],
                                [[x["forecast_week"], x["from_ward"], x["to_ward"], x["units"]]
                                 for x in s["simulated_transfers"]], num=(3,)))
            else:
                p.append("<p>No simulated reassignments involve this ward.</p>")
    elif key == "intervention_scenario":
        p.append('<p class="note">Assumed effect sizes applied to the forecast baseline. Not causal, not learned from '
                 'data, and nothing has been carried out.</p>')
        rows = []
        for c in s["comparison"]:
            name = c["scenario"] + (" (selected)" if c["scenario"] == s["selected_scenario"] else "")
            rows.append([name, _share(c["max_reduction"]), _c1(c["projected_cases_avoided"]),
                         _opt(c["projected_cases_avoided_per_assigned_crew"], 3)])
        p.append(_table("Assumed-effect scenarios (projected cases avoided over t+2 to t+4)",
                        ["Scenario", "Maximum reduction", "Projected cases avoided", "Per hypothetical crew"], rows,
                        num=(1, 2, 3)))
        sel = s["selected"]
        if city:
            p.append(_dl([("Expected cases (baseline)", _c1(sel["baseline_cases_3wk"])),
                          ("Scenario-adjusted cases", _c1(sel["scenario_adjusted_cases_3wk"])),
                          ("Hypothetical crews", sel["assigned_crews"]),
                          ("Saline planning units", f"{sel['saline']['baseline_units']} baseline, "
                                                    f"{sel['saline']['scenario_adjusted_units']} scenario-adjusted"),
                          ("Kit planning units", f"{sel['kits']['baseline_units']} baseline, "
                                                 f"{sel['kits']['scenario_adjusted_units']} scenario-adjusted")]))
        else:
            p.append(_dl([("Hypothetical crews", s["assigned_crews"]),
                          ("Baseline weekly cases", " / ".join(_c1(x) for x in s["baseline_weekly_cases"])),
                          ("Scenario-adjusted weekly cases", " / ".join(_c1(x) for x in sel["scenario_adjusted_weekly_cases"])),
                          ("Peak bed planning units", f"{sel['peak_bed_planning_units']['baseline']} baseline, "
                                                      f"{sel['peak_bed_planning_units']['scenario_adjusted']} scenario-adjusted")]))
    return "".join(p)


def render_html(brief: dict) -> str:
    """Self-contained A4 printable HTML: inline CSS only, no scripts, links, fonts or remote assets."""
    sc, t = brief["scenario"], brief["scope"]
    prm = sc["parameters"]
    detailed = brief["variant"] == "detailed"
    sid = brief["scenario_id"]
    title_target = t["city"] if t["type"] == "city" else f"{t['ward_id']} ({t['city']})"
    src = "weekly companion model" if sc["weekly_source"] == "companion" else "equal split fallback"
    banner = " | ".join(LABELS)
    parts = [
        "<!DOCTYPE html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{_e('DRAFT dispatch brief - ' + title_target + ' - ' + sid)}</title>",
        f"<style>{_CSS}</style>", "</head>", "<body>",
        f'<header class="status" role="note"><p>{_e(banner)}</p>'
        f"<p>{_e(brief['status']['statement'])}</p></header>",
        "<main>",
        f"<h1>Draft dispatch brief: {_e(title_target)}</h1>",
        '<p class="screen-note">To print or save as PDF, use the browser print command. Turn off browser '
        "headers and footers so no local address is printed.</p>",
        '<section aria-labelledby="sec-scenario" class="keep"><h2 id="sec-scenario">Scenario</h2>',
        _dl([("Prepared for", brief["intended_role"]), ("Scenario ID", sid), ("Document ID", brief["document_id"]),
             ("Scenario fingerprint", brief["scenario_fingerprint"]),
             ("Issue week", sc["issue_week"]),
             ("Forecast weeks", ", ".join(sc["forecast_weeks"]) + " (t+2 to t+4)"),
             ("Model", sc["model_version"]), ("Weekly split", src),
             ("Hypothetical stock", f"{prm['stock_pct']}% of planning demand"),
             ("Minimum coverage floor", f"{prm['min_coverage_pct']}%"),
             ("Regional crew budget", f"{prm['total_crews']} hypothetical crews"),
             ("Bed capacity scenario", f"{prm['capacity_pct']}% of a retrospective baseline"),
             ("Intervention scenario", f"{prm['intervention_scenario']} (assumed effect)")]),
        f"<p>{_e(sc['notice'])}</p>", "</section>",
    ]
    for n, key in enumerate(brief["sections_included"], start=1):
        s = brief["sections"][key]
        parts.append(f'<section aria-labelledby="sec-{n}"><h2 id="sec-{n}">{n}. {_e(SECTION_TITLES[key])}</h2>'
                     f'<p class="sec-status">{_e(s["label"])} | DRAFT / NOT SENT | {_e(sid)}</p>'
                     f"{_html_section(key, s, brief, detailed)}</section>")
    parts.append('<section aria-labelledby="sec-verify" class="keep"><h2 id="sec-verify">Human verification required</h2>'
                 f'<p class="sec-status">DRAFT / NOT SENT | {_e(sid)}</p>'
                 + _ul(brief["verification_checklist"], "check")
                 + '<p class="sign">Reviewed by (role):<span class="line"></span> Date:<span class="line"></span></p>'
                 + '<p class="sign">Decision and notes:<span class="line"></span></p></section>')
    if brief["warnings"]:
        parts.append('<section aria-labelledby="sec-warn"><h2 id="sec-warn">Warnings</h2>'
                     + _ul(brief["warnings"]) + "</section>")
    if detailed:
        parts.append('<section aria-labelledby="sec-assume"><h2 id="sec-assume">Assumptions</h2>'
                     + _ul(brief["assumptions"]) + "</section>")
    parts.append('<section aria-labelledby="sec-limit"><h2 id="sec-limit">Limitations</h2>'
                 + _ul(brief["limitations"]) + "</section>")
    parts += ["</main>",
              f"<footer><p>{_e(banner)}</p><p>{_e(sid)} | {_e(brief['document_id'])}</p>"
              "<p>Draft for planning review only. Not sent. No action authorised.</p></footer>",
              "</body>", "</html>"]
    doc = "\n".join(parts) + "\n"
    visible = html.unescape(re.sub(r"<style>.*?</style>|<[^>]+>", "\n", doc, flags=re.S))
    _assert_safe(visible)
    return doc


def render(brief: dict, fmt: str) -> tuple[str, str]:
    """-> (body, media type). JSON is the brief itself; text uses the brief's variant."""
    if fmt == "json":
        return json.dumps(brief, ensure_ascii=False, indent=2) + "\n", MEDIA_TYPES["json"]
    if fmt == "text":
        body = render_short_text(brief) if brief["variant"] == "short" else render_detailed_text(brief)
        return body, MEDIA_TYPES["text"]
    if fmt == "html":
        return render_html(brief), MEDIA_TYPES["html"]
    raise DispatchQueryError("invalid_parameter", "format must be json, text or html.")
