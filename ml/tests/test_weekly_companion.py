"""Weekly companion (ml/phase2) against the real Phase 1 package. Offline, no retraining."""
import copy
import json
import shutil
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG))
import features as F                        # noqa: E402
import predict_portable as P                # noqa: E402
from phase2 import weekly_model as W        # noqa: E402

ART = W.ARTIFACTS_DIR
# Peak season, early/late season with negative raw outputs, first valid week, last week.
WEEKS = ["2016-02-01", "2020-07-27", "2023-08-07", "2024-06-17", "2025-07-28", "2025-09-01", "2025-12-29"]
WARDS = ["CCC_Ward_01", "DNCC_Ward_12", "DSCC_Ward_19", "GCC_Ward_02", "NCC_Ward_05"]


@pytest.fixture(scope="module")
def fc():
    return P.get_forecaster()


@pytest.fixture(scope="module")
def comp(fc):
    return W.WeeklyCompanion(features_module=F, ward_city=fc.ward_city,
                             phase1_column_names=list(fc._pre.get_feature_names_out()))


def rows_for(fc, results):
    keys = [(r["ward_id"], pd.Timestamp(r["issue_week"])) for r in results]
    return fc._feat.loc[keys].reset_index()


# ------------------------------------------------------------------ artifacts and integrity
def test_all_three_models_load_with_95_columns(comp):
    assert sorted(comp.boosters) == [2, 3, 4]
    assert all(b.num_features() == 95 for b in comp.boosters.values())
    assert comp.version == "weekly-xgb-2to4w-1.0.0"


def test_manifest_lists_and_matches_every_model():
    m = W.read_manifest(ART)
    assert set(m) == {f"models/weekly_w{h}.ubj" for h in (2, 3, 4)}
    for h in (2, 3, 4):
        assert len(W.verified_model_bytes(ART, m, h)) > 1_000_000


def test_manifest_matches_reviewed_package_hashes():
    # SHA-256 recorded in the reviewed handoff (model_config.json / SHA256SUMS)
    assert W.read_manifest(ART) == {
        "models/weekly_w2.ubj": "65967bccc5b7b68838d028daf39ab4e181becc52aa976a9f92d048885c4a7432",
        "models/weekly_w3.ubj": "4757f5aec155cfe7ff748c0d3c58fc25216fb760d35a6354562f4c084cc58bd6",
        "models/weekly_w4.ubj": "777f7f092297318319ceacc7620258f4f77e67fbb8b3479b2d0c4ab71c54b5c6",
    }


@pytest.fixture()
def art_copy(tmp_path):
    dst = tmp_path / "artifacts"
    shutil.copytree(ART, dst)
    return dst


def test_corrupted_model_is_rejected(art_copy, fc):
    p = art_copy / "models" / "weekly_w3.ubj"
    data = bytearray(p.read_bytes())
    data[len(data) // 2] ^= 0xFF
    p.write_bytes(bytes(data))
    with pytest.raises(W.ArtifactIntegrityError, match="weekly_w3.ubj"):
        W.WeeklyCompanion(features_module=F, artifacts_dir=art_copy, ward_city=fc.ward_city)


def test_missing_model_missing_entry_and_missing_manifest_are_rejected(art_copy):
    (art_copy / "models" / "weekly_w4.ubj").unlink()
    with pytest.raises(W.ArtifactIntegrityError, match="missing"):
        W.WeeklyCompanion(features_module=F, artifacts_dir=art_copy)
    lines = (art_copy / "SHA256SUMS").read_text().splitlines()
    (art_copy / "SHA256SUMS").write_text("\n".join(l for l in lines if "weekly_w2" not in l) + "\n")
    with pytest.raises(W.ArtifactIntegrityError, match="not listed"):
        W.WeeklyCompanion(features_module=F, artifacts_dir=art_copy)
    (art_copy / "SHA256SUMS").unlink()
    with pytest.raises(W.ArtifactIntegrityError, match="manifest is missing"):
        W.WeeklyCompanion(features_module=F, artifacts_dir=art_copy)


def test_manifest_with_crlf_line_endings_still_verifies(art_copy):
    text = (art_copy / "SHA256SUMS").read_text()
    (art_copy / "SHA256SUMS").write_bytes(text.replace("\n", "\r\n").encode())
    assert len(W.WeeklyCompanion(features_module=F, artifacts_dir=art_copy).boosters) == 3


# ------------------------------------------------------------------ compatibility with Phase 1
def test_feature_order_and_categories_match_phase1(fc):
    cfg = W.load_config()
    assert cfg["numeric_features"] == F.NUMERIC_FEATURES == fc.config["numeric_features"]
    assert cfg["feature_set_version"] == F.FEATURE_SET_VERSION == fc.config["feature_set_version"]
    assert cfg["wards"] == sorted(fc.ward_city)
    assert cfg["cities"] == sorted(set(fc.ward_city.values()))
    names = W.expected_column_names(cfg)
    assert names == [str(n) for n in fc._pre.get_feature_names_out()]  # loaded preprocessor (joblib or json)
    spec = json.loads((PKG / "dengue_preprocessor.json").read_text())
    assert names == spec["output_feature_names"]
    assert len(names) == 95


def _features_variant(**overrides):
    mod = types.SimpleNamespace(NUMERIC_FEATURES=list(F.NUMERIC_FEATURES), FEATURE_SET_VERSION=F.FEATURE_SET_VERSION,
                                CATEGORICAL_FEATURES=list(F.CATEGORICAL_FEATURES),
                                TARGET_HORIZON_WEEKS=F.TARGET_HORIZON_WEEKS)
    for k, v in overrides.items():
        setattr(mod, k, v)
    return mod


@pytest.mark.parametrize("override", [
    {"NUMERIC_FEATURES": list(reversed(F.NUMERIC_FEATURES))},
    {"NUMERIC_FEATURES": F.NUMERIC_FEATURES[:-1]},
    {"FEATURE_SET_VERSION": "2.0.0"},
    {"CATEGORICAL_FEATURES": ["ward_id", "city"]},
    {"TARGET_HORIZON_WEEKS": (1, 2, 3)},
])
def test_feature_drift_is_rejected(override):
    with pytest.raises(W.FeatureMismatchError):
        W.WeeklyCompanion(features_module=_features_variant(**override))


def test_category_and_column_drift_is_rejected(fc):
    extra = dict(fc.ward_city, NEW_Ward_01="Dhaka North")
    with pytest.raises(W.FeatureMismatchError, match="ward"):
        W.WeeklyCompanion(features_module=F, ward_city=extra)
    moved = dict(fc.ward_city, CCC_Ward_01="Gazipur", GCC_Ward_01="Chattogram")
    W.check_compatibility(F, W.load_config(), moved)  # same sets: allowed here, Phase 1 checks ward->city
    names = list(fc._pre.get_feature_names_out())
    names[30], names[31] = names[31], names[30]
    with pytest.raises(W.FeatureMismatchError, match="column layout"):
        W.WeeklyCompanion(features_module=F, phase1_column_names=names)


def test_unknown_category_rejected_at_inference(comp, fc):
    rows = rows_for(fc, fc.forecast_all("2025-07-28", include_actual=False)[:2])
    rows.loc[0, "ward_id"] = "XYZ_Ward_99"
    with pytest.raises(ValueError, match="unseen"):
        comp.split(rows, [10.0, 10.0])


def test_incomplete_rows_rejected(comp, fc):
    rows = rows_for(fc, fc.forecast_all("2025-07-28", include_actual=False)[:2])
    rows.loc[1, "features_complete"] = False
    with pytest.raises(ValueError, match="incomplete"):
        comp.split(rows, [10.0, 10.0])


# ------------------------------------------------------------------ predictions
@pytest.mark.parametrize("week", WEEKS)
def test_weekly_nonnegative_and_sums_to_phase1_total(comp, fc, week):
    results = fc.forecast_all(week, include_actual=False)
    totals = np.array([r["predicted_cases_3wk"] for r in results])
    weekly = comp.split(rows_for(fc, results), totals)
    assert weekly.shape == (60, 3)
    assert (weekly >= 0).all()
    np.testing.assert_allclose(weekly.sum(axis=1), totals, rtol=0, atol=1e-9)


def test_low_season_negative_raw_outputs_are_clipped(comp, fc):
    results = fc.forecast_all("2025-12-29", include_actual=False)
    raw = comp.raw_weekly(rows_for(fc, results))
    assert (raw < 0).any()  # the case the clipping exists for
    weekly = comp.split(rows_for(fc, results), [r["predicted_cases_3wk"] for r in results])
    assert (weekly >= 0).all()


def test_matches_asir_reference_values(comp, fc):
    """Reviewed package examples/weekly_baseline_2025-09-01.csv (Asir's environment, 4 dp)."""
    ref = {"CCC_Ward_01": (11.1589, 7.6859, 8.7698), "DNCC_Ward_12": (11.8614, 8.0673, 8.7248),
           "NCC_Ward_05": (10.6941, 6.509, 7.5871)}
    results = [fc.forecast(w, "2025-09-01", include_drivers=False, include_actual=False) for w in ref]
    weekly = comp.split(rows_for(fc, results), [r["predicted_cases_3wk"] for r in results])
    np.testing.assert_allclose(weekly, np.array(list(ref.values())), atol=1e-4)


def test_deterministic_repeated_calls(comp, fc):
    results = fc.forecast_all("2025-07-28", include_actual=False)
    rows = rows_for(fc, results)
    totals = [r["predicted_cases_3wk"] for r in results]
    first = comp.split(rows, totals)
    for _ in range(3):
        assert np.array_equal(comp.split(rows, totals), first)
    again = W.WeeklyCompanion(features_module=F)  # fresh load gives the same numbers
    assert np.array_equal(again.split(rows, totals), first)


def test_phase1_outputs_unchanged_by_companion(comp, fc):
    for week in ("2023-08-07", "2025-07-28"):
        before = fc.forecast_all(week)
        snapshot = copy.deepcopy(before)
        comp.split(rows_for(fc, before), [r["predicted_cases_3wk"] for r in before])
        assert before == snapshot
        assert fc.forecast_all(week) == snapshot
    for ward in WARDS:
        a = fc.forecast(ward, "2025-07-28")
        comp.split(rows_for(fc, [a]), [a["predicted_cases_3wk"]])
        assert fc.forecast(ward, "2025-07-28") == a


# ------------------------------------------------------------------ reconciliation and fallback
def test_equal_split_fallback():
    out = W.equal_split([0.0, 3.0, 34.2615])
    np.testing.assert_allclose(out, [[0, 0, 0], [1, 1, 1], [34.2615 / 3] * 3])
    np.testing.assert_allclose(out.sum(axis=1), [0.0, 3.0, 34.2615], atol=1e-12)


def test_reconcile_edge_cases():
    out = W.reconcile(np.array([[-1.0, -2.0, -0.5], [0.0, 2.0, 2.0], [5.0, -1.0, 5.0]]), [9.0, 4.0, 0.0])
    np.testing.assert_allclose(out, [[3, 3, 3], [0, 2, 2], [0, 0, 0]])
    assert (out >= 0).all()
    with pytest.raises(ValueError):
        W.reconcile(np.ones((1, 3)), [-1.0])
    with pytest.raises(ValueError):
        W.reconcile(np.ones((1, 3)), [float("nan")])
    with pytest.raises(ValueError):
        W.reconcile(np.ones((2, 3)), [1.0])
