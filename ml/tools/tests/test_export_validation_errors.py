"""Tests for ml/tools/export_validation_errors.py (reads only saved evaluation CSVs; no model is run).

Run from the repository root:  python -m pytest ml/tools/tests -q -p no:cacheprovider
"""
import importlib.util
import json
import math
import shutil
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "export_validation_errors.py"
spec = importlib.util.spec_from_file_location("export_validation_errors", TOOL)
exp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exp)


def test_committed_json_matches_a_fresh_export():
    assert exp.OUT.read_text(encoding="utf-8") == exp.render(exp.build())


def test_split_counts_dates_and_separation():
    d = json.loads(exp.OUT.read_text(encoding="utf-8"))
    v, t = d["splits"]["validation"], d["splits"]["test"]
    assert (v["predictions"], v["issue_weeks"], v["first_issue_week"], v["last_issue_week"]) == (4380, 73, "2022-12-26", "2024-05-13")
    assert (t["predictions"], t["issue_weeks"], t["first_issue_week"], t["last_issue_week"]) == (4620, 77, "2024-06-17", "2025-12-01")
    assert v["last_issue_week"] < t["first_issue_week"]
    for s in (v, t):
        assert len(s["weekly"]) == s["issue_weeks"]
        assert all(w["n"] == 60 for w in s["weekly"])
        dates = [w["issue_week"] for w in s["weekly"]]
        assert dates == sorted(dates)
    assert [y["year"] for y in d["rolling_origin"]["years"]] == [2020, 2021, 2022, 2023, 2024, 2025]
    assert "Not a percentage" in d["error_unit"] and "clipped" in d["prediction_basis"].lower()


def test_pooled_metrics_match_the_documented_summary():
    d = json.loads(exp.OUT.read_text(encoding="utf-8"))
    ms = json.loads((exp.EVAL / "metrics_summary.json").read_text(encoding="utf-8"))
    assert d["splits"]["validation"]["pooled"]["mae"] == pytest.approx(ms["validation"]["MAE"], abs=1e-4)
    assert d["splits"]["validation"]["pooled"]["rmse"] == pytest.approx(ms["validation"]["RMSE"], abs=1e-4)
    assert d["splits"]["test"]["pooled"]["mae"] == pytest.approx(ms["test"]["MAE (clipped, as served)"], abs=1e-4)
    assert d["splits"]["test"]["pooled"]["rmse"] == pytest.approx(ms["test"]["RMSE (clipped, as served)"], abs=1e-4)


def test_pooled_rmse_is_not_the_mean_of_weekly_rmse():
    t = json.loads(exp.OUT.read_text(encoding="utf-8"))["splits"]["test"]
    mean_weekly_rmse = sum(w["rmse"] for w in t["weekly"]) / len(t["weekly"])
    assert abs(mean_weekly_rmse - t["pooled"]["rmse"]) > 1.0
    # MAE is a plain mean, so averaging equal-sized weeks reproduces the pooled MAE
    assert sum(w["mae"] for w in t["weekly"]) / len(t["weekly"]) == pytest.approx(t["pooled"]["mae"], abs=1e-4)


def test_weekly_values_are_recomputed_correctly_for_one_week():
    rows = [r for r in exp.read_rows("test_predictions.csv", ("ward_id", "issue_week", "actual_cases_3wk", "predicted_cases_3wk")) if r["issue_week"].isoformat() == "2024-07-01"]
    assert len(rows) == 60
    mae = sum(abs(r["pred"] - r["actual"]) for r in rows) / 60
    rmse = math.sqrt(sum((r["pred"] - r["actual"]) ** 2 for r in rows) / 60)
    w = next(w for w in json.loads(exp.OUT.read_text(encoding="utf-8"))["splits"]["test"]["weekly"] if w["issue_week"] == "2024-07-01")
    assert w["mae"] == pytest.approx(mae, abs=1e-6) and w["rmse"] == pytest.approx(rmse, abs=1e-6)


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    dst = tmp_path / "eval"
    shutil.copytree(exp.EVAL, dst)
    monkeypatch.setattr(exp, "EVAL", dst)
    return dst


def test_fails_loudly_when_a_row_is_missing(sandbox):
    p = sandbox / "test_predictions.csv"
    lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
    p.write_text("".join(lines[:-1]), encoding="utf-8")
    with pytest.raises(SystemExit, match="expected 4620 rows"):
        exp.build()


def test_fails_loudly_on_a_malformed_value(sandbox):
    p = sandbox / "validation_predictions.csv"
    text = p.read_text(encoding="utf-8").replace("0.1574", "n/a", 1)
    p.write_text(text, encoding="utf-8")
    with pytest.raises(SystemExit, match="malformed"):
        exp.build()


def test_fails_loudly_on_a_wrong_validation_model_label(sandbox):
    p = sandbox / "validation_predictions.csv"
    text = p.read_text(encoding="utf-8").replace("XGBoost trained on train period only", "XGBoost trained on train + validation", 1)
    p.write_text(text, encoding="utf-8")
    with pytest.raises(SystemExit, match="model label"):
        exp.build()


def _swap_one_ward(path, week, old, new):
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    hit = [i for i, l in enumerate(lines) if l.startswith(f"{old},") and f",{week}," in l]
    assert len(hit) == 1
    lines[hit[0]] = lines[hit[0]].replace(old, new, 1)
    path.write_text("".join(lines), encoding="utf-8")


def test_fails_loudly_when_a_week_has_a_different_ward_set(sandbox):
    # still 60 distinct wards in that week, but one id is not the usual ward
    _swap_one_ward(sandbox / "test_predictions.csv", "2024-07-01", "CCC_Ward_01", "CCC_Ward_99")
    with pytest.raises(SystemExit, match="ward set in week 2024-07-01"):
        exp.build()


def test_fails_loudly_when_validation_and_test_ward_sets_differ(sandbox):
    # every test week consistently uses another ward id, so each split alone is valid but the two disagree
    p = sandbox / "test_predictions.csv"
    p.write_text(p.read_text(encoding="utf-8").replace("CCC_Ward_01,", "CCC_Ward_99,"), encoding="utf-8")
    with pytest.raises(SystemExit, match="ward sets differ"):
        exp.build()


def test_reference_metric_tolerance_is_tight_but_not_unreasonable(sandbox):
    p = sandbox / "metrics_summary.json"
    base = json.loads(p.read_text(encoding="utf-8"))
    ok = json.loads(json.dumps(base))
    ok["test"]["RMSE (clipped, as served)"] += 4e-6  # about the size of 4-decimal rounding noise: accepted
    p.write_text(json.dumps(ok), encoding="utf-8")
    exp.build()
    bad = json.loads(json.dumps(base))
    bad["test"]["RMSE (clipped, as served)"] += 5e-5  # a real discrepancy: rejected
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(SystemExit, match="differ from"):
        exp.build()


def test_fails_loudly_when_metrics_disagree(sandbox):
    p = sandbox / "metrics_summary.json"
    ms = json.loads(p.read_text(encoding="utf-8"))
    ms["test"]["RMSE (clipped, as served)"] += 0.01
    p.write_text(json.dumps(ms), encoding="utf-8")
    with pytest.raises(SystemExit, match="differ from"):
        exp.build()
