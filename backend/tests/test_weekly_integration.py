"""Weekly companion through the API: opt-in, backward compatible, safe fallback. Offline."""
import copy

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.model_service import load_portable_forecaster, load_weekly_companion

ISSUE = "2025-07-28"
WARD = "DNCC_Ward_12"
HEALTH_READY = {"status": "ok", "api_ready": True, "model_ready": True, "mode": "historical_replay"}


@pytest.fixture(scope="module")
def direct():
    return load_portable_forecaster()


class Counting:
    def __init__(self, fn):
        self.fn, self.calls = fn, 0

    def __call__(self, *a):
        self.calls += 1
        return self.fn(*a)


@pytest.fixture(scope="module")
def loaders(direct):
    return Counting(lambda: direct), Counting(load_weekly_companion)


@pytest.fixture(scope="module")
def live(loaders):
    model_loader, weekly_loader = loaders
    with TestClient(create_app(model_loader=model_loader, weekly_loader=weekly_loader),
                    raise_server_exceptions=False) as c:
        yield c


def app_with(direct, weekly_loader):
    return TestClient(create_app(model_loader=lambda: direct, weekly_loader=weekly_loader),
                      raise_server_exceptions=False)


def check_weekly_block(f, source):
    wk = f["weekly"]
    assert wk["source"] == source
    assert wk["reconciled_to"] == "predicted_cases_3wk"
    assert [w["horizon_week"] for w in wk["weeks"]] == f["horizon_weeks"] == [2, 3, 4]
    assert [w["forecast_week"] for w in wk["weeks"]] == f["forecast_weeks"]
    values = [w["predicted_cases"] for w in wk["weeks"]]
    assert all(v >= 0 for v in values)
    assert abs(sum(values) - f["predicted_cases_3wk"]) < 1e-9
    return wk


def strip_weekly(f):
    g = dict(f)
    g.pop("weekly")
    return g


# ------------------------------------------------------------------ backward compatibility
def test_health_unchanged_and_models_loaded_once(live, loaders):
    for _ in range(3):
        assert live.get("/health").json() == HEALTH_READY
        live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"})
        live.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"})
    assert loaders[0].calls == 1 and loaders[1].calls == 1


def test_default_responses_unchanged(live, direct):
    one = live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE}).json()
    assert one["forecast"] == direct.forecast(WARD, ISSUE) and "weekly" not in one["forecast"]
    allw = live.get("/forecast", params={"issue_date": ISSUE}).json()
    assert allw["forecasts"] == direct.forecast_all(ISSUE)
    assert all("weekly" not in f for f in allw["forecasts"])
    assert set(allw) == {"mode", "notice", "issue_date", "count", "forecasts"}


def test_meta_existing_fields_unchanged_and_reports_companion(live):
    m = live.get("/meta").json()
    assert m["ward_count"] == 60 and m["horizon_weeks"] == [2, 3, 4]
    assert m["risk_tiers"]["edges"] == [4.5, 14.5, 30.5] and m["early_alert"]["threshold"] == 25
    assert m["weekly_companion"] == {
        "available": True, "source": "companion", "model_version": "weekly-xgb-2to4w-1.0.0",
        "fallback_reason": None, "horizon_weeks": [2, 3, 4], "reconciled_to": "predicted_cases_3wk"}


# ------------------------------------------------------------------ weekly values
@pytest.mark.parametrize("ward,week", [("DNCC_Ward_12", "2025-07-28"), ("CCC_Ward_03", "2023-08-07"),
                                       ("GCC_Ward_05", "2025-12-29"), ("NCC_Ward_01", "2016-02-01")])
def test_single_ward_weekly_tied_to_same_forecast(live, direct, ward, week):
    r = live.get(f"/forecast/{ward}", params={"issue_date": week, "include_weekly": "true"})
    assert r.status_code == 200
    f = r.json()["forecast"]
    wk = check_weekly_block(f, "companion")
    assert wk["model_version"] == "weekly-xgb-2to4w-1.0.0" and wk["fallback_reason"] is None
    assert strip_weekly(f) == direct.forecast(ward, week)  # Phase 1 fields identical


def test_all_wards_weekly(live, direct):
    for week in ("2024-06-17", "2025-07-28"):
        body = live.get("/forecast", params={"issue_date": week, "include_weekly": "true"}).json()
        assert body["count"] == 60
        for f in body["forecasts"]:
            check_weekly_block(f, "companion")
        assert [strip_weekly(f) for f in body["forecasts"]] == direct.forecast_all(week)


def test_single_and_all_ward_weekly_agree(live):
    one = live.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"}).json()["forecast"]
    allw = live.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"}).json()["forecasts"]
    assert next(f for f in allw if f["ward_id"] == WARD)["weekly"] == one["weekly"]


def test_weekly_is_deterministic(live):
    params = {"issue_date": ISSUE, "include_weekly": "true"}
    first = live.get("/forecast", params=params).json()
    for _ in range(2):
        assert live.get("/forecast", params=params).json() == first


# ------------------------------------------------------------------ invalid input: existing conventions
@pytest.mark.parametrize("url,params,status,code", [
    ("/forecast/NOPE_Ward_99", {"issue_date": ISSUE}, 404, "unknown_ward"),
    (f"/forecast/{WARD}", {"issue_date": "2025-07-29"}, 400, "invalid_date"),
    ("/forecast", {"issue_date": "not-a-date"}, 400, "invalid_date"),
    (f"/forecast/{WARD}", {"issue_date": "2026-01-05"}, 404, "issue_week_out_of_range"),
    ("/forecast", {"issue_date": "2015-01-05"}, 404, "issue_week_out_of_range"),
    (f"/forecast/{WARD}", {"issue_date": "2016-01-04"}, 422, "insufficient_history"),
    (f"/forecast/{WARD}", {"issue_date": ISSUE, "include_weekly": "maybe"}, 422, "validation_error"),
])
def test_invalid_inputs_rejected_with_existing_errors(live, url, params, status, code):
    r = live.get(url, params={**params, "include_weekly": params.get("include_weekly", "true")})
    assert r.status_code == status
    assert r.json()["error"]["code"] == code


# ------------------------------------------------------------------ fallback
def test_companion_failure_keeps_phase1_and_uses_equal_split(direct):
    def broken(_forecaster):
        raise RuntimeError("C:\\secret\\weekly_w2.ubj: SHA-256 differs")

    with app_with(direct, broken) as c:
        assert c.get("/health").json() == HEALTH_READY
        m = c.get("/meta").json()["weekly_companion"]
        assert m["available"] is False and m["source"] == "equal_split"
        assert m["fallback_reason"] == "companion_unavailable" and m["model_version"] is None
        assert c.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == direct.forecast_all(ISSUE)
        f = c.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"}).json()["forecast"]
        wk = check_weekly_block(f, "equal_split")
        assert wk["model_version"] is None and wk["fallback_reason"] == "companion_unavailable"
        third = f["predicted_cases_3wk"] / 3
        assert all(abs(w["predicted_cases"] - third) < 1e-9 for w in wk["weeks"])
        assert strip_weekly(f) == direct.forecast(WARD, ISSUE)
        assert "secret" not in c.get("/meta").text


def test_corrupted_artifact_falls_back(direct, tmp_path):
    import shutil

    from phase2 import weekly_model as W

    art = tmp_path / "artifacts"
    shutil.copytree(W.ARTIFACTS_DIR, art)
    p = art / "models" / "weekly_w2.ubj"
    p.write_bytes(p.read_bytes()[:-10] + b"0123456789")

    def loader(f):
        import features
        return W.WeeklyCompanion(features_module=features, artifacts_dir=art, ward_city=f.ward_city)

    with app_with(direct, loader) as c:
        assert c.get("/meta").json()["weekly_companion"]["fallback_reason"] == "companion_unavailable"
        body = c.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"}).json()
        assert all(f["weekly"]["source"] == "equal_split" for f in body["forecasts"])


def test_companion_disabled(direct):
    with app_with(direct, None) as c:
        assert c.get("/meta").json()["weekly_companion"]["fallback_reason"] == "companion_not_loaded"
        f = c.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"}).json()["forecast"]
        check_weekly_block(f, "equal_split")


def test_inference_failure_for_one_request_falls_back(direct):
    class Flaky:
        version = "test"

        def split(self, *a, **k):
            raise RuntimeError("boom")

    with app_with(direct, lambda f: Flaky()) as c:
        r = c.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"})
        assert r.status_code == 200
        wk = check_weekly_block(r.json()["forecast"], "equal_split")
        assert wk["fallback_reason"] == "companion_inference_failed" and wk["model_version"] is None
        assert "boom" not in r.text


def test_phase1_failure_still_503_and_no_companion_load():
    weekly = Counting(load_weekly_companion)

    def failing():
        raise RuntimeError("model corrupt")

    with TestClient(create_app(model_loader=failing, weekly_loader=weekly), raise_server_exceptions=False) as c:
        r = c.get(f"/forecast/{WARD}", params={"issue_date": ISSUE, "include_weekly": "true"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"
    assert weekly.calls == 0


def test_weekly_block_does_not_leak_into_later_default_responses(live, direct):
    snapshot = copy.deepcopy(direct.forecast_all(ISSUE))
    live.get("/forecast", params={"issue_date": ISSUE, "include_weekly": "true"})
    assert live.get("/forecast", params={"issue_date": ISSUE}).json()["forecasts"] == snapshot
