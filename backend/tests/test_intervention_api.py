"""GET /intervention-simulation against the real Phase 1 model, weekly companion and Task 2 crews (offline)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.model_service import load_portable_forecaster
from app.planning import parameters as PP
from app.planning.intervention import ward_effect

ISSUE = "2025-07-28"
CITIES = ["Chattogram", "Dhaka North", "Dhaka South", "Gazipur", "Narayanganj"]


@pytest.fixture(scope="module")
def direct():
    return load_portable_forecaster()


@pytest.fixture(scope="module")
def live(direct):
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        yield c


def get(c, **params):
    return c.get("/intervention-simulation", params={"issue_date": ISSUE, **params})


# ------------------------------------------------------------------ structure and honesty metadata
def test_default_request(live, direct):
    r = live.get("/intervention-simulation")
    assert r.status_code == 200
    b = r.json()
    assert b["mode"] == "historical_replay" and b["notice"]
    assert b["issue_date"] == direct.valid_issue_weeks()["last"] and b["model_version"] == direct.model_version
    p = b["parameters"]
    assert p["total_crews"] == 60 and p["min_coverage_pct"] == 30 and p["include_roi_alternative"] is False
    assert p["scenarios"] == {"low": 0.15, "base": 0.35, "high": 0.55}
    assert b["roi_alternative"] is None


def test_honesty_metadata(live):
    b = get(live).json()
    pol = b["policy"]
    assert pol["causal"] is False and pol["effect_size_basis"] == "assumed_scenario_not_learned"
    assert pol["crew_capacity_status"] == "hypothetical"
    assert pol["crew_assignment_source"] == "task2_minimum_coverage_then_risk_priority"
    assert "t+2, t+3 and t+4" in pol["timing"]
    assert any("does not estimate or establish causal effectiveness" in x for x in b["limitations"])
    assert any(x.startswith("Model-driven") for x in b["assumptions"])
    assert "not financial" in b["parameters"]["roi_definition"]


def test_completeness(live, direct):
    b = get(live).json()
    assert len(b["wards"]) == 60 and {w["ward_id"] for w in b["wards"]} == set(direct.ward_city)
    assert set(b["scenarios"]) == {"low", "base", "high"}
    for s in b["scenarios"].values():
        assert [c["city"] for c in s["cities"]] == CITIES
    assert b["forecast_weeks"] == ["2025-08-11", "2025-08-18", "2025-08-25"]
    for w in b["wards"]:
        assert set(w["scenarios"]) == {"low", "base", "high"} and len(w["baseline_weekly_cases"]) == 3


# ------------------------------------------------------------------ consistency with earlier layers
def test_baseline_matches_phase1_weekly_and_allocation(live, direct):
    b = get(live).json()
    weekly = {f["ward_id"]: f for f in live.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"})
              .json()["forecasts"]}
    alloc = live.get("/allocation", params={"issue_date": ISSUE}).json()
    a = {w["ward_id"]: w for w in alloc["wards"]}
    for w in b["wards"]:
        f = weekly[w["ward_id"]]
        assert w["predicted_cases_3wk"] == f["predicted_cases_3wk"]
        assert all(abs(x - y["predicted_cases"]) < 1e-4 for x, y in zip(w["baseline_weekly_cases"], f["weekly"]["weeks"]))
        assert w["baseline_planning_units"]["saline"] == a[w["ward_id"]]["saline"]["demand"]
        assert w["baseline_planning_units"]["kits"] == a[w["ward_id"]]["kits"]["demand"]
        assert w["baseline_planning_units"]["peak_bed_planning_units"] == a[w["ward_id"]]["bed_plan"]["bed_planning_demand"]
        assert w["crews"]["assigned"] == a[w["ward_id"]]["crews"]["assigned"]
        assert w["crews"]["scenario_demand"] == a[w["ward_id"]]["crews"]["scenario_demand"]
    assert b["crews"]["assigned"] == alloc["region"]["crews"]["assigned"]
    assert b["crews"]["unassigned"] == alloc["region"]["crews"]["unassigned"]
    # Phase 1 itself is unchanged by running the simulator.
    assert live.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == direct.forecast_all(ISSUE)


def test_hospital_routing_unaffected(live):
    before = live.get("/hospital-routing", params={"issue_date": ISSUE, "capacity_pct": 75}).json()
    get(live, total_crews=200, include_roi_alternative="true")
    assert live.get("/hospital-routing", params={"issue_date": ISSUE, "capacity_pct": 75}).json() == before


# ------------------------------------------------------------------ live regression fixtures
# Expected values recomputed from the formula on the real model (Task 4A design report figures agree).
@pytest.mark.parametrize("issue,expected", [
    ("2025-07-28", {"low": (55.1616, 0.919, 132, 65), "base": (128.7105, 2.145, 304, 149), "high": (202.2593, 3.371, 478, 239)}),
    ("2023-08-07", {"low": (75.509, 1.258, 182, 86), "base": (176.1876, 2.936, 423, 213), "high": (276.8662, 4.614, 666, 327)}),
])
def test_live_regression(live, issue, expected):
    b = live.get("/intervention-simulation", params={"issue_date": issue, "total_crews": 60}).json()
    for s, (avoided, roi, saline, kits) in expected.items():
        r = b["scenarios"][s]["region"]
        assert abs(r["projected_cases_avoided"] - avoided) < 2e-3
        assert r["projected_cases_avoided_per_assigned_crew"] == roi
        assert (r["saline"]["projected_units_avoided"], r["kits"]["projected_units_avoided"]) == (saline, kits)
        assert r["assigned_crews"] == 60


def test_ward_values_recompute_from_formula(live):
    b = get(live, total_crews=150).json()
    for w in b["wards"]:
        for s, m in PP.INTERVENTION_SCENARIOS.items():
            e = ward_effect(w["baseline_weekly_cases"], w["crews"]["assigned"], w["population_density_sqkm"], m)
            assert abs(w["scenarios"][s]["projected_cases_avoided"] - e.avoided_total) < 2e-3   # 4-dp inputs
            assert all(0 <= x <= 0.55 for x in w["scenarios"][s]["effective_reduction_by_week"])


def test_region_reconciles_and_scenarios_ordered(live):
    b = get(live, total_crews=120).json()
    for s in ("low", "base", "high"):
        r, cities = b["scenarios"][s]["region"], b["scenarios"][s]["cities"]
        assert r["assigned_crews"] == sum(c["assigned_crews"] for c in cities) == b["crews"]["assigned"]
        assert abs(r["projected_cases_avoided"] - sum(c["projected_cases_avoided"] for c in cities)) < 1e-3
        for item in ("saline", "kits"):
            assert r[item]["projected_units_avoided"] == sum(c[item]["projected_units_avoided"] for c in cities) >= 0
        for k in range(3):
            assert r["weekly_bed_planning_units"][k]["projected_units_avoided"] == sum(
                c["weekly_bed_planning_units"][k]["projected_units_avoided"] for c in cities)
    vals = [b["scenarios"][s]["region"]["projected_cases_avoided"] for s in ("low", "base", "high")]
    assert vals == sorted(vals)


def test_roi_alternative(live):
    b = get(live, include_roi_alternative="true").json()
    alt = b["roi_alternative"]
    assert alt["status"] == "hypothetical_assumption_dependent"
    assert alt["city_pools"] == b["crews"]["city_pools"] and alt["assigned_crews"] == b["crews"]["assigned"]
    caps = {w["ward_id"]: w["crews"]["scenario_demand"] for w in b["wards"]}
    city_of = {w["ward_id"]: w["city"] for w in b["wards"]}
    for c, pool in alt["city_pools"].items():
        assert sum(x["alternative_crews"] for x in alt["wards"] if x["city"] == c) == pool
    assert all(0 <= x["alternative_crews"] <= caps[x["ward_id"]] and city_of[x["ward_id"]] == x["city"] for x in alt["wards"])
    for s in ("low", "base", "high"):
        reg = alt["comparison"][s]["region"]
        assert reg["alternative_projected_cases_avoided"] >= reg["primary_projected_cases_avoided"]
        assert reg["primary_projected_cases_avoided"] == b["scenarios"][s]["region"]["projected_cases_avoided"]
    assert alt["comparison"]["base"]["region"]["difference_pct"] == 3.5     # small; reported, not overstated


def test_zero_crews(live):
    b = get(live, total_crews=0).json()
    for s in ("low", "base", "high"):
        r = b["scenarios"][s]["region"]
        assert r["projected_cases_avoided"] == 0 and r["projected_cases_avoided_per_assigned_crew"] is None
    assert all(w["scenarios"]["high"]["projected_cases_avoided"] == 0 for w in b["wards"])


def test_large_budget_reports_unassigned(live):
    b = get(live, total_crews=10_000).json()
    assert b["crews"]["assigned"] + b["crews"]["unassigned"] == 10_000 and b["crews"]["unassigned"] > 0
    assert any("unassigned" in w for w in b["warnings"])
    assert all(w["crews"]["next_crew_status"] in ("at_cap", "ineligible") for w in b["wards"])


def test_deterministic(live):
    assert get(live, total_crews=33, include_roi_alternative="true").json() == \
        get(live, total_crews=33, include_roi_alternative="true").json()


def test_repeated_requests_after_initialisation(live):
    """Benchmark only when DENGUE_PERF_ASSERT=1; never a gate in the default suite."""
    get(live)
    times = []
    for crews in (0, 30, 60, 120, 240):
        t = time.perf_counter()
        assert get(live, total_crews=crews).status_code == 200
        times.append(time.perf_counter() - t)
    if os.environ.get("DENGUE_PERF_ASSERT") == "1":
        assert sorted(times)[len(times) // 2] < 0.2


# ------------------------------------------------------------------ validation and errors
@pytest.mark.parametrize("params", [{"total_crews": -1}, {"total_crews": 10_001}, {"total_crews": "x"},
                                    {"min_coverage_pct": -1}, {"min_coverage_pct": 51}, {"min_coverage_pct": 2.5},
                                    {"include_roi_alternative": "maybe"}])
def test_invalid_parameters(live, params):
    r = get(live, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("params", [{"total_crews": 0}, {"total_crews": 10_000}, {"min_coverage_pct": 0},
                                    {"min_coverage_pct": 50}, {"include_roi_alternative": "true"},
                                    {"include_roi_alternative": "false"}])
def test_boundary_parameters_accepted(live, params):
    assert get(live, **params).status_code == 200


@pytest.mark.parametrize("date,status,code", [("2025-07-29", 400, "invalid_date"), ("bad", 400, "invalid_date"),
                                              ("2026-01-05", 404, "issue_week_out_of_range"),
                                              ("2016-01-04", 422, "insufficient_history")])
def test_invalid_issue_dates(live, date, status, code):
    r = live.get("/intervention-simulation", params={"issue_date": date})
    assert r.status_code == status and r.json()["error"]["code"] == code


def test_model_unavailable():
    def failing():
        raise RuntimeError("C:\\secret\\model.ubj corrupt")

    with TestClient(create_app(model_loader=failing), raise_server_exceptions=False) as c:
        r = c.get("/intervention-simulation", params={"issue_date": ISSUE})
        assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable" and "secret" not in r.text


def test_companion_fallback(direct):
    def broken(_f):
        raise RuntimeError("weekly unavailable")

    with TestClient(create_app(model_loader=lambda: direct, weekly_loader=broken)) as c:
        b = c.get("/intervention-simulation", params={"issue_date": ISSUE}).json()
    assert b["weekly_source"] == "equal_split" and any("equal split" in w for w in b["warnings"])
    for w in b["wards"]:
        x = w["baseline_weekly_cases"]
        assert abs(x[0] - x[1]) < 1e-4 and abs(x[1] - x[2]) < 1e-4
    r = b["scenarios"]["base"]["region"]
    assert r["projected_cases_avoided"] > 0 and r["assigned_crews"] == 60


def test_internal_data_error_is_controlled(direct, monkeypatch):
    from app import model_service

    monkeypatch.setattr(model_service.ModelService, "ward_densities", lambda self, results: {})
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        r = c.get("/intervention-simulation", params={"issue_date": ISSUE})
    assert r.status_code == 500 and r.json()["error"]["code"] == "planning_data_invalid"
    assert "Traceback" not in r.text and "density" not in r.text and "C:\\" not in r.text


def test_no_internal_leakage_or_misleading_fields(live):
    r = get(live, include_roi_alternative="true")
    for leak in ("drivers", "raw_model_output", "rainfall", "dengue_lag", "features_complete", "actual_cases",
                 "denguehackathon", "Traceback"):
        assert leak not in r.text

    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield k
                yield from keys(v)
        elif isinstance(o, list):
            for v in o:
                yield from keys(v)
    for k in set(keys(r.json())):
        for word in ("actual", "proven", "saved", "lives", "prevented", "patient", "cost", "money"):
            assert word not in k.lower(), k


def test_existing_endpoints_unchanged(live, direct):
    assert live.get("/health").json() == {"status": "ok", "api_ready": True, "model_ready": True,
                                          "mode": "historical_replay"}
    get(live, total_crews=90)
    assert live.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == direct.forecast_all(ISSUE)
    assert live.get(f"/forecast/DNCC_Ward_12", params={"issue_date": ISSUE}).json()["forecast"] == \
        direct.forecast("DNCC_Ward_12", ISSUE)
    alloc = live.get("/allocation", params={"issue_date": ISSUE, "stock_pct": 60}).json()
    ncc = [w["saline"]["allocated"] for w in alloc["wards"] if w["city"] == "Narayanganj"]
    assert ncc == [73, 46, 14, 12, 12]
    assert "weekly_companion" in live.get("/meta").json()
