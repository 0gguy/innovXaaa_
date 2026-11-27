"""GET /allocation against the real Phase 1 model and weekly companion (offline)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.model_service import load_portable_forecaster

ISSUE = "2025-07-28"
CITY_WARDS = {"Chattogram": 10, "Dhaka North": 20, "Dhaka South": 20, "Gazipur": 5, "Narayanganj": 5}


@pytest.fixture(scope="module")
def direct():
    return load_portable_forecaster()


@pytest.fixture(scope="module")
def live(direct):
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        yield c


def get(c, **params):
    return c.get("/allocation", params={"issue_date": ISSUE, **params})


# ------------------------------------------------------------------ structure and defaults
def test_default_request(live, direct):
    r = live.get("/allocation")
    assert r.status_code == 200
    b = r.json()
    assert b["mode"] == "historical_replay" and b["notice"]
    assert b["issue_date"] == direct.valid_issue_weeks()["last"]
    p = b["parameters"]
    assert p["stock_pct"] == {"saline": 100, "kits": 100} and p["min_coverage_pct"] == 30
    assert p["total_crews"] == 60 and p["rounding"] == "ROUND_HALF_UP"
    assert p["coefficients"] == {"saline": "2.38485", "kits": "1.16422", "beds": "0.29844"}
    assert p["crew_rule"]["status"] == "hypothetical_scenario"
    assert any("not verified municipal inventory" in a for a in b["assumptions"]) and b["limitations"]


def test_sixty_wards_five_cities_complete(live, direct):
    b = get(live, stock_pct=60).json()
    assert b["weekly_source"] == "companion" and b["model_version"] == direct.model_version
    assert len(b["wards"]) == 60 and {w["ward_id"] for w in b["wards"]} == set(direct.ward_city)
    assert {c["city"]: c["ward_count"] for c in b["cities"]} == CITY_WARDS
    for w in b["wards"]:
        assert w["city"] == direct.ward_city[w["ward_id"]]
        assert set(w) == {"ward_id", "city", "priority_rank_in_city", "priority", "saline", "kits", "crews",
                          "bed_plan", "exceeds_observed_range"}
        assert set(w["priority"]) == {"risk_tier", "early_alert", "population_density_sqkm", "predicted_cases_3wk"}


def test_phase1_values_and_priority_consistent(live, direct):
    b = get(live).json()
    p1 = {f["ward_id"]: f for f in direct.forecast_all(ISSUE)}
    for w in b["wards"]:
        f = p1[w["ward_id"]]
        assert w["priority"]["risk_tier"] == f["risk_tier"]
        assert w["priority"]["early_alert"] == f["early_alert"]
        assert w["priority"]["predicted_cases_3wk"] == f["predicted_cases_3wk"]
    for c in CITY_WARDS:
        ranks = [w["priority_rank_in_city"] for w in b["wards"] if w["city"] == c]
        assert ranks == list(range(1, CITY_WARDS[c] + 1))


def test_narayanganj_regression_fixture(live):
    b = get(live, stock_pct=60).json()
    ncc = [w for w in b["wards"] if w["city"] == "Narayanganj"]
    assert [w["ward_id"] for w in ncc] == ["NCC_Ward_05", "NCC_Ward_01", "NCC_Ward_04", "NCC_Ward_02", "NCC_Ward_03"]
    assert [w["saline"]["demand"] for w in ncc] == [73, 64, 46, 40, 40]
    assert [w["saline"]["allocated"] for w in ncc] == [73, 46, 14, 12, 12]
    city = next(c for c in b["cities"] if c["city"] == "Narayanganj")
    assert (city["saline"]["demand"], city["saline"]["stock"], city["saline"]["allocated"]) == (263, 157, 157)
    assert [w["bed_plan"]["bed_planning_demand"] for w in ncc] == [3, 3, 2, 2, 2]
    assert [w["crews"]["scenario_demand"] for w in ncc] == [4, 6, 5, 2, 2]


# ------------------------------------------------------------------ invariants on the real 60 wards
@pytest.mark.parametrize("pct,floor,crews", [(30, 30, 0), (45, 0, 7), (60, 30, 60), (77, 50, 150), (100, 30, 500)])
def test_invariants_real_data(live, pct, floor, crews):
    b = get(live, stock_pct=pct, min_coverage_pct=floor, total_crews=crews).json()
    for r in ("saline", "kits"):
        for c in b["cities"]:
            s = c[r]
            assert s["stock"] == pct * s["demand"] // 100
            assert s["allocated"] == min(s["stock"], s["demand"]) and s["unallocated"] == s["stock"] - s["allocated"]
            wards = [w[r] for w in b["wards"] if w["city"] == c["city"]]
            assert sum(w["allocated"] for w in wards) == s["allocated"]
        for w in b["wards"]:
            e = w[r]
            assert isinstance(e["allocated"], int) and 0 <= e["allocated"] <= e["demand"]
            assert e["deficit"] == e["demand"] - e["allocated"]
            assert e["critical_deficit"] == (e["deficit"] > 0)
            assert e["severity"] == ("no_deficit" if e["deficit"] == 0 else
                                     "below_floor" if e["allocated"] < e["floor"] else "partial")
        assert b["region"][r]["allocated"] == sum(c[r]["allocated"] for c in b["cities"])
    rc = b["region"]["crews"]
    assert rc["assigned"] + rc["unassigned"] == crews == rc["total_crews"]
    assert all(0 <= w["crews"]["assigned"] <= w["crews"]["scenario_demand"] <= 6 for w in b["wards"])
    if pct == 100:
        assert b["region"]["saline"]["deficit"] == 0 and b["region"]["kits"]["deficit"] == 0


def test_slider_monotone_on_real_data(live):
    prev = None
    for pct in (30, 31, 50, 59, 60, 61, 90, 99, 100):
        cur = {w["ward_id"]: w["saline"]["allocated"] for w in get(live, stock_pct=pct).json()["wards"]}
        assert prev is None or all(cur[k] >= prev[k] for k in cur)
        prev = cur


def test_stock_overrides(live):
    b = get(live, stock_pct=100, stock_pct_saline=30, stock_pct_kits=70).json()
    assert b["parameters"]["stock_pct"] == {"saline": 30, "kits": 70}
    assert b["region"]["kits"]["stock"] == sum(70 * c["kits"]["demand"] // 100 for c in b["cities"])


def test_beds_are_planning_demand_with_weekly_peak(live):
    b = get(live).json()
    weekly = {f["ward_id"]: f for f in live.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"})
              .json()["forecasts"]}
    for w in b["wards"]:
        bp = w["bed_plan"]
        weeks = weekly[w["ward_id"]]["weekly"]["weeks"]
        peak = max(weeks, key=lambda x: x["predicted_cases"])
        assert bp["peak_forecast_week"] == peak["forecast_week"] and bp["weekly_source"] == "companion"
        assert abs(bp["peak_week_expected_cases"] - peak["predicted_cases"]) < 1e-4
    assert b["region"]["beds"] == {"planning_demand": sum(w["bed_plan"]["bed_planning_demand"] for w in b["wards"]),
                                   "capacity_and_routing": "not_computed"}
    assert "allocated" not in str(b["cities"][0]["beds"])


def test_response_deterministic(live):
    assert get(live, stock_pct=55, total_crews=33).json() == get(live, stock_pct=55, total_crews=33).json()


def test_repeated_slider_requests_after_initialisation(live):
    """Warm, repeated slider requests succeed. The 200 ms median budget is a benchmark, not a gate:
    it is asserted only when DENGUE_PERF_ASSERT=1, so slower or busy machines do not fail the suite."""
    get(live)
    times = []
    for pct in (30, 50, 70, 90, 100):
        t = time.perf_counter()
        assert get(live, stock_pct=pct, total_crews=200).status_code == 200
        times.append(time.perf_counter() - t)
    if os.environ.get("DENGUE_PERF_ASSERT") == "1":
        assert sorted(times)[len(times) // 2] < 0.2      # median under 200 ms (opt-in benchmark)


# ------------------------------------------------------------------ validation and errors
@pytest.mark.parametrize("params", [
    {"stock_pct": 29}, {"stock_pct": 101}, {"stock_pct_saline": 29}, {"stock_pct_kits": 101},
    {"min_coverage_pct": -1}, {"min_coverage_pct": 51}, {"total_crews": -1}, {"total_crews": 10_001},
    {"stock_pct": "abc"}, {"stock_pct": 50.5},
])
def test_invalid_parameters(live, params):
    r = get(live, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("params", [{"stock_pct": 30}, {"stock_pct": 100}, {"min_coverage_pct": 0},
                                    {"min_coverage_pct": 50}, {"total_crews": 0}, {"total_crews": 10_000}])
def test_boundary_parameters_accepted(live, params):
    assert get(live, **params).status_code == 200


@pytest.mark.parametrize("date,status,code", [("2025-07-29", 400, "invalid_date"), ("bad", 400, "invalid_date"),
                                              ("2026-01-05", 404, "issue_week_out_of_range"),
                                              ("2016-01-04", 422, "insufficient_history")])
def test_invalid_issue_dates(live, date, status, code):
    r = live.get("/allocation", params={"issue_date": date})
    assert r.status_code == status and r.json()["error"]["code"] == code


def test_model_unavailable():
    def failing():
        raise RuntimeError("C:\\secret\\model.ubj corrupt")

    with TestClient(create_app(model_loader=failing), raise_server_exceptions=False) as c:
        for params in ({}, {"issue_date": ISSUE}):
            r = c.get("/allocation", params=params)
            assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"
            assert "secret" not in r.text


def test_companion_fallback_uses_equal_split(direct):
    def broken(_f):
        raise RuntimeError("weekly unavailable")

    with TestClient(create_app(model_loader=lambda: direct, weekly_loader=broken)) as c:
        b = c.get("/allocation", params={"issue_date": ISSUE, "stock_pct": 60}).json()
    assert b["weekly_source"] == "equal_split"
    assert all(w["bed_plan"]["weekly_source"] == "equal_split" and w["bed_plan"]["peak_horizon_week"] == 2
               for w in b["wards"])
    ncc = [w for w in b["wards"] if w["city"] == "Narayanganj"]
    assert [w["saline"]["allocated"] for w in ncc] == [73, 46, 14, 12, 12]   # consumables independent of split


def test_internal_data_error_is_controlled_and_leaks_nothing(direct, monkeypatch):
    from app import model_service

    monkeypatch.setattr(model_service.ModelService, "ward_densities", lambda self, results: {})
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        r = c.get("/allocation", params={"issue_date": ISSUE})
    assert r.status_code == 500 and r.json()["error"]["code"] == "planning_data_invalid"
    assert "Traceback" not in r.text and "density" not in r.text and "C:\\" not in r.text


def test_no_internal_model_data_exposed(live):
    text = get(live).text
    for leak in ("drivers", "raw_model_output", "rainfall", "dengue_lag", "features_complete", "actual_cases",
                 "denguehackathon", "Traceback"):
        assert leak not in text


def test_existing_endpoints_unchanged(live, direct):
    assert live.get("/health").json() == {"status": "ok", "api_ready": True, "model_ready": True,
                                          "mode": "historical_replay"}
    get(live, stock_pct=40)
    assert live.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == direct.forecast_all(ISSUE)
    assert live.get(f"/forecast/DNCC_Ward_12", params={"issue_date": ISSUE}).json()["forecast"] == \
        direct.forecast("DNCC_Ward_12", ISSUE)
