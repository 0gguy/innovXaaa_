"""Equivalence of the portable files against EXPECTED outputs recorded from the original pipeline.
Does not need the original joblib. Tolerance: DENGUE_EQ_TOL (default 1e-9 on Linux where the export was made,
1e-4 elsewhere). Tiers and early-alert flags must match exactly on every platform."""
import json, os, sys
from pathlib import Path
import numpy as np, pandas as pd, pytest

PKG = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(PKG))
import features as F
import predict_portable as P

TOL = float(os.environ.get("DENGUE_EQ_TOL", 1e-9 if sys.platform.startswith("linux") else 1e-4))
CFG = json.loads((PKG / "model_config.json").read_text())
EDGES, LABELS = np.array(CFG["risk_tiers"]["edges"]), CFG["risk_tiers"]["labels"]


@pytest.fixture(scope="module")
def fc():
    return P.get_forecaster()


@pytest.fixture(scope="module")
def ref():
    return pd.read_csv(PKG / "reference" / "reference_cases.csv")


def test_rules_unchanged():
    assert list(EDGES) == [4.5, 14.5, 30.5] and LABELS == ["Low", "Medium", "High", "Critical"]
    assert CFG["early_alert"]["threshold"] == 25


def test_reference_covers_all_tiers_cities_seasons(ref):
    assert set(ref.expected_tier) == set(LABELS) and ref.city.nunique() == 5
    assert ref.monsoon.nunique() == 2 and ref.ward_id.nunique() > 20 and ref.expected_alert.any() and (~ref.expected_alert).any()


def test_raw_predictions_match_reference(fc, ref):
    raw, _ = fc._predict(ref[F.FEATURE_COLUMNS], include_drivers=False)
    assert np.abs(raw - ref.expected_raw.to_numpy()).max() <= TOL


def test_tiers_and_alerts_match_reference_exactly(fc, ref):
    raw, _ = fc._predict(ref[F.FEATURE_COLUMNS], include_drivers=False)
    p = np.clip(raw, 0, None)
    assert [LABELS[i] for i in np.searchsorted(EDGES, p, side="right")] == list(ref.expected_tier)
    assert list(p > 25) == list(ref.expected_alert)


def test_public_api_matches_reference(fc, ref):
    for _, r in ref.iterrows():
        out = fc.forecast(r.ward_id, r.date, include_drivers=False)
        assert abs(out["raw_model_output"] - r.expected_raw) <= max(TOL, 6e-5)  # output is rounded to 4 dp
        assert out["risk_tier"] == r.expected_tier and out["early_alert"] == bool(r.expected_alert)


def test_all_4620_test_predictions_match_eval_file(fc):
    nb = pd.read_csv(PKG / "eval" / "test_predictions.csv")
    rows = [(r["ward_id"], r["issue_week"], r["predicted_cases_3wk"], r["risk_tier"], r["early_alert"])
            for w in sorted(nb.issue_week.unique()) for r in fc.forecast_all(w, include_actual=False)]
    got = pd.DataFrame(rows, columns=["ward_id", "issue_week", "p", "tier", "alert"])
    m = nb.merge(got, on=["ward_id", "issue_week"], validate="one_to_one")
    assert len(m) == 4620
    assert np.abs(m.p - m.predicted_cases_3wk).max() < 1e-3          # eval file is rounded
    assert (m.tier == m.predicted_tier).sum() >= 4620 - 1              # see note: 4-dp rounding at an edge
    assert (m.alert == m.early_alert).mean() > 0.9998


def test_json_preprocessor_equals_joblib_preprocessor(ref):
    import joblib
    a = joblib.load(PKG / "dengue_preprocessor.joblib").transform(ref[F.FEATURE_COLUMNS])
    b = P.JsonPreprocessor(json.loads((PKG / "dengue_preprocessor.json").read_text())).transform(ref[F.FEATURE_COLUMNS])
    assert np.array_equal(np.asarray(a), b)


@pytest.mark.parametrize("model_file", ["dengue_xgboost_model.ubj", "dengue_xgboost_model.json"])
def test_each_model_format_gives_same_predictions(model_file, ref):
    from xgboost import XGBRegressor
    import joblib
    r = XGBRegressor(); r.load_model(str(PKG / model_file))
    pre = joblib.load(PKG / "dengue_preprocessor.joblib")
    assert np.abs(r.predict(pre.transform(ref[F.FEATURE_COLUMNS])) - ref.expected_raw.to_numpy()).max() <= TOL


def test_artifact_hash_check_detects_tampering(tmp_path):
    import shutil
    for f in PKG.glob("dengue_*"):
        shutil.copy(f, tmp_path / f.name)
    shutil.copy(PKG / "portable_manifest.json", tmp_path); shutil.copy(PKG / "model_config.json", tmp_path)
    b = bytearray((tmp_path / "dengue_xgboost_model.ubj").read_bytes()); b[100] ^= 1
    (tmp_path / "dengue_xgboost_model.ubj").write_bytes(bytes(b))
    with pytest.raises(P.PortableLoadError, match="SHA-256"):
        P.PortableForecaster(base_dir=tmp_path)


def test_json_fallback_when_joblib_preprocessor_unusable(tmp_path):
    import shutil
    for f in PKG.glob("dengue_*"):
        shutil.copy(f, tmp_path / f.name)
    shutil.copy(PKG / "portable_manifest.json", tmp_path); shutil.copy(PKG / "model_config.json", tmp_path)
    (tmp_path / "dengue_preprocessor.joblib").write_bytes(b"not a pickle")
    m = json.loads((tmp_path / "portable_manifest.json").read_text()); m["artifacts"].pop("dengue_preprocessor.joblib", None)
    (tmp_path / "portable_manifest.json").write_text(json.dumps(m))
    f = P.PortableForecaster(base_dir=tmp_path)
    assert f.artifact_info["preprocessor_file"] == "dengue_preprocessor.json"
    assert f.forecast("DNCC_Ward_12", "2025-06-16")["risk_tier"] in LABELS
