"""Integration tests against the real portable model (offline, no network)."""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ML_DIR
from app.main import create_app
from app.model_service import load_portable_forecaster

ISSUE = "2025-06-16"
WARD = "DNCC_Ward_12"


@pytest.fixture(scope="module")
def direct():
    """Independent direct use of ml/predict_portable.py, for equivalence checks."""
    return load_portable_forecaster()


class CountingLoader:
    def __init__(self, forecaster):
        self.forecaster, self.calls = forecaster, 0

    def __call__(self):
        self.calls += 1
        return self.forecaster


@pytest.fixture(scope="module")
def loader(direct):
    return CountingLoader(direct)


@pytest.fixture(scope="module")
def live(loader):
    """App with the lifespan running (model loaded at startup)."""
    with TestClient(create_app(model_loader=loader), raise_server_exceptions=False) as c:
        yield c


def test_model_loaded_once_at_startup_and_health_ready(live, loader):
    assert loader.calls == 1
    assert live.get("/health").json() == {
        "status": "ok", "api_ready": True, "model_ready": True, "mode": "historical_replay"}


def test_health_not_ready_before_startup(loader):
    c = TestClient(create_app(model_loader=loader))  # no `with`: lifespan not run
    assert c.get("/health").json()["model_ready"] is False
    assert c.get("/meta").status_code == 503


def test_no_model_reload_per_request(live, loader):
    before = id(live.app.state.model_service.forecaster)
    for _ in range(3):
        live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE})
        live.get("/meta")
    assert loader.calls == 1
    assert id(live.app.state.model_service.forecaster) == before


def test_default_loader_uses_portable_forecaster_not_joblib_pipeline(monkeypatch):
    sys.path.insert(0, str(ML_DIR)) if str(ML_DIR) not in sys.path else None
    import predict
    import predict_portable

    def boom(*a, **k):
        raise AssertionError("original predict.Forecaster.__init__ (joblib loader) was used")

    monkeypatch.setattr(predict.Forecaster, "__init__", boom)
    with TestClient(create_app()) as c:  # real default loader
        assert c.get("/health").json()["model_ready"] is True
        f = c.app.state.model_service.forecaster
        assert isinstance(f, predict_portable.PortableForecaster)
        assert f.artifact_info["model_file"] in ("dengue_xgboost_model.ubj", "dengue_xgboost_model.json")


def test_meta_wards_cities_and_weeks(live, direct):
    r = live.get("/meta")
    assert r.status_code == 200
    m = r.json()
    assert m["mode"] == "historical_replay" and "not verified real-world" in m["notice"]
    assert m["ward_count"] == 60 and len(m["wards"]) == 60
    assert {w["ward_id"] for w in m["wards"]} == set(direct.ward_city)
    counts = {c["city"]: c["ward_count"] for c in m["cities"]}
    assert counts == {"Chattogram": 10, "Dhaka North": 20, "Dhaka South": 20, "Gazipur": 5, "Narayanganj": 5}
    assert m["valid_issue_weeks"]["first"] == "2016-02-01"
    assert m["valid_issue_weeks"]["last"] == "2025-12-29"
    assert m["early_alert"]["threshold"] == 25
    assert m["risk_tiers"]["edges"] == [4.5, 14.5, 30.5]


def test_single_ward_matches_direct_inference(live, direct):
    r = live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE})
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "historical_replay" and body["notice"]
    expected = direct.forecast(WARD, ISSUE)  # defaults: drivers + actual
    assert body["forecast"] == expected  # ML result object passed through unchanged
    assert "drivers" in body["forecast"]


def test_single_ward_drivers_optional(live):
    r = live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_drivers": "false"})
    assert r.status_code == 200 and "drivers" not in r.json()["forecast"]


def test_all_wards_matches_direct_inference(live, direct):
    r = live.get("/forecast", params={"issue_date": ISSUE})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 60 and len(body["forecasts"]) == 60
    assert body["mode"] == "historical_replay"
    assert body["forecasts"] == direct.forecast_all(ISSUE)
    assert all("drivers" not in f for f in body["forecasts"])  # default false for all-ward


def test_tier_and_alert_rules_hold_for_every_ward(live):
    for date in ("2024-09-02", "2025-06-16"):
        for f in live.get("/forecast", params={"issue_date": date}).json()["forecasts"]:
            p = f["predicted_cases_3wk"]
            tier = "Low" if p < 4.5 else "Medium" if p < 14.5 else "High" if p < 30.5 else "Critical"
            assert f["risk_tier"] == tier
            assert f["early_alert"] is (p > 25)


def test_tier_boundaries_and_alert_threshold_exact(direct):
    assert [direct.tier(v) for v in (0, 4.49, 4.5, 14.49, 14.5, 30.49, 30.5)] == [
        "Low", "Low", "Medium", "Medium", "High", "High", "Critical"]
    assert direct.alert_threshold == 25.0


def test_unknown_ward(live):
    r = live.get("/forecast/NOPE_Ward_99", params={"issue_date": ISSUE})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "unknown_ward"


@pytest.mark.parametrize("bad", ["not-a-date", "2025-06-17", "2025-06-16T10:00:00", "16-06-2025"])
def test_invalid_date(live, bad):
    for url in (f"/forecast/{WARD}", "/forecast"):
        r = live.get(url, params={"issue_date": bad})
        assert r.status_code == 400, (url, bad)
        assert r.json()["error"]["code"] == "invalid_date"


@pytest.mark.parametrize("date", ["2026-01-05", "2015-01-05"])
def test_out_of_range(live, date):
    for url in (f"/forecast/{WARD}", "/forecast"):
        r = live.get(url, params={"issue_date": date})
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "issue_week_out_of_range"


def test_insufficient_history(live):
    r = live.get(f"/forecast/{WARD}", params={"issue_date": "2016-01-04"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "insufficient_history"


def test_missing_issue_date_is_validation_error(live):
    for url in (f"/forecast/{WARD}", "/forecast"):
        r = live.get(url)
        assert r.status_code == 422
        assert r.json()["error"]["code"] == "validation_error"


def test_error_responses_leak_no_paths(live):
    texts = [
        live.get("/forecast/X", params={"issue_date": ISSUE}).text,
        live.get("/forecast", params={"issue_date": "2026-01-05"}).text,
    ]
    for t in texts:
        assert "Traceback" not in t and "C:\\" not in t and "denguehackathon" not in t


def test_model_unavailable_when_load_fails():
    def failing_loader():
        raise RuntimeError("C:\\secret\\ml\\model.ubj corrupt")

    with TestClient(create_app(model_loader=failing_loader), raise_server_exceptions=False) as c:
        assert c.get("/health").json() == {
            "status": "ok", "api_ready": True, "model_ready": False, "mode": "historical_replay"}
        for url, params in (("/meta", None), (f"/forecast/{WARD}", {"issue_date": ISSUE}),
                            ("/forecast", {"issue_date": ISSUE})):
            r = c.get(url, params=params)
            assert r.status_code == 503
            assert r.json()["error"]["code"] == "model_unavailable"
            assert "secret" not in r.text and "C:\\" not in r.text


def test_unexpected_inference_error_is_safe():
    class Broken:
        def forecast(self, *a, **k):
            raise RuntimeError("secret C:\\Users\\user\\x.py Traceback")

    with TestClient(create_app(model_loader=Broken), raise_server_exceptions=False) as c:
        r = c.get(f"/forecast/{WARD}", params={"issue_date": ISSUE})
        assert r.status_code == 500
        assert r.json()["error"]["code"] == "internal_error"
        for leak in ("secret", "Traceback", "C:\\", ".py", "RuntimeError"):
            assert leak not in r.text


def test_cors_on_forecast_endpoints(live):
    ok = live.get("/forecast/" + WARD, params={"issue_date": ISSUE}, headers={"Origin": "http://localhost:5173"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    bad = live.get("/meta", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_endpoints_are_read_only(live):
    for url in ("/meta", f"/forecast/{WARD}", "/forecast", "/health"):
        assert live.post(url).status_code == 405
    assert live.get("/forecast_from_records").status_code == 404
