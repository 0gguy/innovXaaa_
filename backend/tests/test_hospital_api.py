"""GET /hospital-routing against the real Phase 1 model and weekly companion (offline)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.model_service import load_portable_forecaster
from app.planning import parameters as PP

ISSUE = "2023-08-07"
CITY_WARDS = {"Chattogram": 10, "Dhaka North": 20, "Dhaka South": 20, "Gazipur": 5, "Narayanganj": 5}
INT_FIELDS = ("hypothetical_capacity", "bed_planning_demand", "locally_assigned", "transfer_units", "transfer_edges",
              "sending_wards", "receiving_wards", "occupied_after_routing", "unmet_after_routing",
              "spare_after_routing", "wards_with_unmet")


@pytest.fixture(scope="module")
def direct():
    return load_portable_forecaster()


@pytest.fixture(scope="module")
def live(direct):
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        yield c


def get(c, **params):
    return c.get("/hospital-routing", params={"issue_date": ISSUE, **params})


def assert_consistent(b):
    city_of = {w["ward_id"]: w["city"] for w in b["wards"]}
    caps = {w["ward_id"]: w["hypothetical_capacity"] for w in b["wards"]}
    assert [w["horizon_week"] for w in b["weeks"]] == [2, 3, 4]
    for k, wk in enumerate(b["weeks"]):
        for t in wk["transfers"]:
            assert city_of[t["from_ward"]] == city_of[t["to_ward"]] == t["city"]
            assert t["from_ward"] != t["to_ward"] and t["units"] > 0
            assert t["horizon_week"] == wk["horizon_week"] and t["forecast_week"] == wk["forecast_week"]
        for c in wk["cities"]:
            ctr = [t for t in wk["transfers"] if t["city"] == c["city"]]
            rows = [w["weeks"][k] for w in b["wards"] if w["city"] == c["city"]]
            assert c["transfer_units"] == sum(t["units"] for t in ctr) == sum(x["transferred_out"] for x in rows) \
                == sum(x["transferred_in"] for x in rows)
            assert c["transfer_edges"] == len(ctr) == len({(t["from_ward"], t["to_ward"]) for t in ctr})
            assert c["sending_wards"] == len({t["from_ward"] for t in ctr}) == sum(x["transferred_out"] > 0 for x in rows)
            assert c["receiving_wards"] == len({t["to_ward"] for t in ctr}) == sum(x["transferred_in"] > 0 for x in rows)
            assert c["bed_planning_demand"] == c["locally_assigned"] + c["transfer_units"] + c["unmet_after_routing"]
            assert c["occupied_after_routing"] <= c["hypothetical_capacity"]
            overflow = sum(x["bed_planning_demand"] - x["locally_assigned"] for x in rows)
            spare = sum(caps[w["ward_id"]] - w["weeks"][k]["locally_assigned"] for w in b["wards"]
                        if w["city"] == c["city"])
            assert c["transfer_units"] == min(overflow, spare)           # maximum under complete connectivity
        for f in INT_FIELDS:
            assert wk["region"][f] == sum(c[f] for c in wk["cities"])
        assert wk["region"]["unmet_after_routing"] >= 0
    for w in b["wards"]:
        for x in w["weeks"]:
            assert x["bed_planning_demand"] == x["locally_assigned"] + x["transferred_out"] + x["unmet_after_routing"]
            assert x["occupied_after_routing"] == x["locally_assigned"] + x["transferred_in"] <= caps[w["ward_id"]]
            assert x["locally_assigned"] == min(x["bed_planning_demand"], caps[w["ward_id"]])


# ------------------------------------------------------------------ requests
def test_default_request(live, direct):
    r = live.get("/hospital-routing")
    assert r.status_code == 200
    b = r.json()
    assert b["mode"] == "historical_replay" and b["notice"]
    assert b["issue_date"] == direct.valid_issue_weeks()["last"] and b["model_version"] == direct.model_version
    assert b["parameters"]["capacity_pct"] == 100
    assert b["parameters"]["city_baseline_beds"] == PP.HOSPITAL_CITY_BASELINE_BEDS
    assert b["parameters"]["baseline_status"] == "hypothetical_retrospective_scenario"
    assert b["policy"]["name"] == "within_city_overflow_routing"
    assert not any("retrospective" in w for w in b["warnings"])     # 2025 issue week: after the baseline years
    assert_consistent(b)


def test_regression_2023_08_07_at_75_pct(live):
    b = get(live, capacity_pct=75).json()
    assert b["weekly_source"] == "companion"
    assert any("retrospective" in w for w in b["warnings"])
    assert [w["forecast_week"] for w in b["weeks"]] == ["2023-08-21", "2023-08-28", "2023-09-04"]
    assert b["capacity"]["region_hypothetical_capacity"] == sum(75 * v // 100 for v in PP.HOSPITAL_CITY_BASELINE_BEDS.values())
    assert_consistent(b)
    assert sum(len(w["transfers"]) for w in b["weeks"]) > 0          # transfers occur in this scenario
    assert any(w["region"]["unmet_after_routing"] > 0 for w in b["weeks"])
    dn = next(c for c in b["weeks"][2]["cities"] if c["city"] == "Dhaka North")
    assert (dn["hypothetical_capacity"], dn["locally_assigned"] + dn["transfer_units"]) == (65, 65)
    assert dn["sending_wards"] == len({t["from_ward"] for t in b["weeks"][2]["transfers"] if t["city"] == "Dhaka North"})


def test_sixty_wards_five_cities(live, direct):
    b = get(live).json()
    assert len(b["wards"]) == 60 and {w["ward_id"] for w in b["wards"]} == set(direct.ward_city)
    assert {c["city"]: c["ward_count"] for c in b["capacity"]["cities"]} == CITY_WARDS
    for w in b["weeks"]:
        assert [c["city"] for c in w["cities"]] == sorted(CITY_WARDS)
    assert set(b["headline_week_by_city"]) == set(CITY_WARDS)
    for w in b["wards"]:
        assert w["city"] == direct.ward_city[w["ward_id"]] and len(w["weeks"]) == 3


@pytest.mark.parametrize("pct", [25, 50, 75, 100, 150, 200])
def test_invariants_across_capacity_scenarios(live, pct):
    b = get(live, capacity_pct=pct).json()
    for c in b["capacity"]["cities"]:
        assert c["hypothetical_capacity"] == pct * PP.HOSPITAL_CITY_BASELINE_BEDS[c["city"]] // 100
    assert_consistent(b)


def test_capacity_monotone_and_unmet_non_increasing(live):
    prev_cap = prev_unmet = None
    for pct in (25, 26, 50, 74, 75, 100, 150, 199, 200):
        b = get(live, capacity_pct=pct).json()
        cap = {w["ward_id"]: w["hypothetical_capacity"] for w in b["wards"]}
        unmet = [w["region"]["unmet_after_routing"] for w in b["weeks"]]
        if prev_cap:
            assert all(cap[k] >= prev_cap[k] for k in cap)
            assert all(u <= p for u, p in zip(unmet, prev_unmet))
        prev_cap, prev_unmet = cap, unmet


def test_max_weekly_demand_matches_allocation_bed_plan(live):
    routing = get(live).json()
    alloc = live.get("/allocation", params={"issue_date": ISSUE}).json()
    t2 = {w["ward_id"]: w["bed_plan"]["bed_planning_demand"] for w in alloc["wards"]}
    for w in routing["wards"]:
        assert max(x["bed_planning_demand"] for x in w["weeks"]) == w["max_weekly_bed_planning_demand"] == t2[w["ward_id"]]


def test_headline_week_rule_on_real_data(live):
    b = get(live, capacity_pct=75).json()
    for city, hw in b["headline_week_by_city"].items():
        rows = [(w["horizon_week"], next(c for c in w["cities"] if c["city"] == city)) for w in b["weeks"]]
        best = min(rows, key=lambda r: (-r[1]["unmet_after_routing"], -r[1]["bed_planning_demand"], r[0]))
        assert hw["horizon_week"] == best[0]


def test_deterministic(live):
    assert get(live, capacity_pct=80).json() == get(live, capacity_pct=80).json()


def test_repeated_requests_after_initialisation(live):
    """Benchmark only when DENGUE_PERF_ASSERT=1; never a gate in the default suite."""
    get(live)
    times = []
    for pct in (25, 75, 100, 150, 200):
        t = time.perf_counter()
        assert get(live, capacity_pct=pct).status_code == 200
        times.append(time.perf_counter() - t)
    if os.environ.get("DENGUE_PERF_ASSERT") == "1":
        assert sorted(times)[len(times) // 2] < 0.2


# ------------------------------------------------------------------ validation and errors
@pytest.mark.parametrize("value", [24, 201, -5, "abc", 50.5, ""])
def test_invalid_capacity_pct(live, value):
    r = get(live, capacity_pct=value)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("value", [25, 200])
def test_capacity_pct_bounds_accepted(live, value):
    assert get(live, capacity_pct=value).status_code == 200


@pytest.mark.parametrize("date,status,code", [("2023-08-08", 400, "invalid_date"), ("bad", 400, "invalid_date"),
                                              ("2026-01-05", 404, "issue_week_out_of_range"),
                                              ("2016-01-04", 422, "insufficient_history")])
def test_invalid_issue_dates(live, date, status, code):
    r = live.get("/hospital-routing", params={"issue_date": date})
    assert r.status_code == status and r.json()["error"]["code"] == code


def test_model_unavailable():
    def failing():
        raise RuntimeError("C:\\secret\\model.ubj corrupt")

    with TestClient(create_app(model_loader=failing), raise_server_exceptions=False) as c:
        for params in ({}, {"issue_date": ISSUE}):
            r = c.get("/hospital-routing", params=params)
            assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"
            assert "secret" not in r.text


def test_companion_fallback(direct):
    def broken(_f):
        raise RuntimeError("weekly unavailable")

    with TestClient(create_app(model_loader=lambda: direct, weekly_loader=broken)) as c:
        b = c.get("/hospital-routing", params={"issue_date": ISSUE, "capacity_pct": 60}).json()
        alloc = c.get("/allocation", params={"issue_date": ISSUE}).json()
    assert b["weekly_source"] == "equal_split" and any("equal split" in w for w in b["warnings"])
    assert_consistent(b)
    for w in b["wards"]:
        d = [x["bed_planning_demand"] for x in w["weeks"]]
        assert d[0] == d[1] == d[2]
    t2 = {w["ward_id"]: w["bed_plan"]["bed_planning_demand"] for w in alloc["wards"]}
    assert all(w["max_weekly_bed_planning_demand"] == t2[w["ward_id"]] for w in b["wards"])


def test_internal_data_error_is_controlled(direct, monkeypatch):
    from app import model_service

    monkeypatch.setattr(model_service.ModelService, "ward_densities", lambda self, results: {})
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        r = c.get("/hospital-routing", params={"issue_date": ISSUE})
    assert r.status_code == 500 and r.json()["error"]["code"] == "planning_data_invalid"
    assert "Traceback" not in r.text and "density" not in r.text and "C:\\" not in r.text


def _keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


def test_no_internal_or_misleading_fields(live):
    r = get(live)
    for leak in ("drivers", "raw_model_output", "rainfall", "dengue_lag", "features_complete", "actual_cases",
                 "denguehackathon", "Traceback"):
        assert leak not in r.text
    # No field implies real patients, hospitals or geography (the words may appear only in disclaimers).
    for key in set(_keys(r.json())):
        for word in ("patient", "hospital_name", "distance", "travel", "latitude", "longitude", "admission"):
            assert word not in key.lower(), key


def test_existing_endpoints_unchanged(live, direct):
    assert live.get("/health").json() == {"status": "ok", "api_ready": True, "model_ready": True,
                                          "mode": "historical_replay"}
    get(live, capacity_pct=40)
    assert live.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == direct.forecast_all(ISSUE)
    alloc = live.get("/allocation", params={"issue_date": ISSUE}).json()
    assert alloc["region"]["beds"]["capacity_and_routing"] == "not_computed"
    assert "weekly_companion" in live.get("/meta").json()
