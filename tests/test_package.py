"""Tests for features.py and predict.py.  Run:  python -m pytest -q tests"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG))
import features as F          # noqa: E402
import predict as P           # noqa: E402

RAW = pd.read_csv(PKG / "data" / "dengue_dataset.csv")
CONFIG = json.loads((PKG / "model_config.json").read_text())


@pytest.fixture(scope="module")
def fc():
    return P.get_forecaster()


@pytest.fixture(scope="module")
def feats():
    return F.build_features(RAW)


def reference_features(raw):
    """Original notebook logic (groupby shift/rolling), used as an independent oracle."""
    df = raw.copy()
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["ward_id", "date"]).reset_index(drop=True)
    g = df.groupby("ward_id")
    for k in range(1, 5):
        df[f"rainfall_lag_{k}w"] = g.rainfall_mm.shift(k)
        df[f"temp_lag_{k}w"] = g.avg_temp_c.shift(k)
        df[f"humidity_lag_{k}w"] = g.relative_humidity_pct.shift(k)
        df[f"dengue_lag_{k}w"] = g.dengue_cases.shift(k)
    for k in (2, 3, 4):
        df[f"rain_roll{k}w_sum"] = g.rainfall_mm.transform(lambda x: x.shift(1).rolling(k).sum())
    df["dengue_roll4w_mean"] = g.dengue_cases.transform(lambda x: x.shift(1).rolling(4).mean())
    df["month_sin"] = np.sin(2 * np.pi * df.date.dt.month / 12)
    df["month_cos"] = np.cos(2 * np.pi * df.date.dt.month / 12)
    df["target"] = g.dengue_cases.shift(-2) + g.dengue_cases.shift(-3) + g.dengue_cases.shift(-4)
    return df


# ---------------------------------------------------------------- features
def test_feature_names_and_order_match_config():
    assert F.FEATURE_COLUMNS == CONFIG["feature_columns"]
    assert len(F.NUMERIC_FEATURES) == 30 and F.CATEGORICAL_FEATURES == ["city", "ward_id"]


def test_features_match_original_definitions(feats):
    ref = reference_features(RAW)
    assert (feats.ward_id.values == ref.ward_id.values).all()
    for c in F.NUMERIC_FEATURES:
        a, b = feats[c].to_numpy(float), ref[c].to_numpy(float)
        assert np.array_equal(np.isnan(a), np.isnan(b)), c
        m = ~np.isnan(a)
        assert np.array_equal(a[m].astype(np.float32), b[m].astype(np.float32)), c
        assert np.abs(a[m] - b[m]).max() < 1e-9, c


def test_target_matches_original_and_is_separate(feats):
    ref = reference_features(RAW)
    t = F.build_target(RAW).to_numpy(float)
    assert np.array_equal(np.isnan(t), np.isnan(ref.target.values))
    assert np.nanmax(np.abs(t - ref.target.values)) == 0
    assert F.TARGET_COLUMN not in feats.columns


@pytest.mark.parametrize("ward", ["CCC_Ward_03", "DNCC_Ward_12", "DSCC_Ward_19", "GCC_Ward_02", "NCC_Ward_05"])
def test_lags_are_exact_calendar_lags_per_ward(feats, ward):
    src = RAW.assign(date=pd.to_datetime(RAW.date)).set_index(["ward_id", "date"])
    rows = feats[(feats.ward_id == ward) & feats.features_complete].sample(10, random_state=1)
    for _, r in rows.iterrows():
        for k in range(1, 5):
            prev = (ward, r.date - pd.Timedelta(weeks=k))
            assert r[f"rainfall_lag_{k}w"] == src.loc[prev, "rainfall_mm"]
            assert r[f"temp_lag_{k}w"] == src.loc[prev, "avg_temp_c"]
            assert r[f"humidity_lag_{k}w"] == src.loc[prev, "relative_humidity_pct"]
            assert r[f"dengue_lag_{k}w"] == src.loc[prev, "dengue_cases"]


def test_no_cross_ward_contamination(feats):
    first = feats.groupby("ward_id").head(4)
    for k in range(1, 5):
        # week j (0-based) of each ward has lag k only if j >= k
        n_defined = first.groupby("ward_id")[f"rainfall_lag_{k}w"].apply(lambda s: s.notna().sum())
        assert (n_defined == 4 - k).all()
    # Changing every other ward's data must not change this ward's features.
    altered = RAW.copy()
    other = altered.ward_id != "DSCC_Ward_04"
    altered.loc[other, ["rainfall_mm", "avg_temp_c", "relative_humidity_pct", "dengue_cases"]] = 999
    a = F.build_features(altered).query("ward_id == 'DSCC_Ward_04'")[F.NUMERIC_FEATURES]
    b = feats.query("ward_id == 'DSCC_Ward_04'")[F.NUMERIC_FEATURES]
    pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True))


def test_gap_in_records_gives_nan_not_wrong_week():
    ward = RAW[RAW.ward_id == "CCC_Ward_01"].copy()
    gap_date = ward.date.iloc[50]
    ward = ward[ward.date != gap_date]
    f = F.build_features(ward)
    after = f[f.date == pd.Timestamp(gap_date) + pd.Timedelta(weeks=1)].iloc[0]
    assert np.isnan(after.rainfall_lag_1w) and not after.features_complete
    assert after.history_weeks_available == 3


def test_features_do_not_use_future_information(feats):
    """Features for week t are unchanged when every record after t is removed or scrambled,
    and when week t's own dengue count is changed."""
    t = pd.Timestamp("2024-08-05")
    trunc = RAW[pd.to_datetime(RAW.date) <= t]
    scrambled = RAW.copy()
    later = pd.to_datetime(scrambled.date) > t
    scrambled.loc[later, ["rainfall_mm", "avg_temp_c", "relative_humidity_pct", "dengue_cases"]] = -1
    scrambled.loc[pd.to_datetime(scrambled.date) == t, "dengue_cases"] = 10_000
    base = feats[feats.date == t].set_index("ward_id")[F.NUMERIC_FEATURES]
    for variant in (trunc, scrambled):
        f = F.build_features(variant)
        pd.testing.assert_frame_equal(f[f.date == t].set_index("ward_id")[F.NUMERIC_FEATURES], base)


# ----------------------------------------------------------------- predict
def test_tier_boundaries(fc):
    cases = {0: "Low", 4.0: "Low", 4.4999: "Low", 4.5: "Medium", 14.4999: "Medium", 14.5: "High",
             30.0: "High", 30.4999: "High", 30.5: "Critical", 92: "Critical"}
    for v, label in cases.items():
        assert fc.tier(v) == label, v
    for bad in (-0.1, float("nan"), float("inf")):
        with pytest.raises(P.ForecastError):
            fc.tier(bad)


def test_output_schema_and_json(fc):
    r = fc.forecast("DNCC_Ward_12", "2025-06-16")
    for key in ("ward_id", "city", "issue_week", "horizon_weeks", "forecast_weeks", "predicted_cases_3wk",
                "risk_tier", "early_alert", "model_version", "actual", "drivers"):
        assert key in r
    assert r["horizon_weeks"] == [2, 3, 4]
    assert r["forecast_weeks"] == ["2025-06-30", "2025-07-07", "2025-07-14"]
    assert r["risk_tier"] in ("Low", "Medium", "High", "Critical")
    assert r["predicted_cases_3wk"] >= 0
    json.dumps(r)


def test_drivers_reproduce_model_output(fc):
    for ward, week in [("CCC_Ward_01", "2025-06-16"), ("NCC_Ward_02", "2025-01-06"), ("GCC_Ward_04", "2024-09-02")]:
        r = fc.forecast(ward, week)
        d = r["drivers"]
        total = d["baseline"] + sum(g["contribution"] for g in d["groups"])
        assert abs(total - r["raw_model_output"]) < 0.02


def test_matches_notebook_test_predictions(fc):
    nb = pd.read_csv(PKG / "eval" / "test_predictions.csv")
    got = []
    for week in sorted(nb.issue_week.unique()):
        for r in fc.forecast_all(week):
            got.append((r["ward_id"], r["issue_week"], r["predicted_cases_3wk"], r["risk_tier"], r["actual"]["actual_cases_3wk"]))
    got = pd.DataFrame(got, columns=["ward_id", "issue_week", "pred", "tier", "actual"])
    m = nb.merge(got, on=["ward_id", "issue_week"], validate="one_to_one")
    assert len(m) == len(nb) == 4620
    assert np.abs(m.pred - m.predicted_cases_3wk).max() < 1e-3
    assert (m.actual == m.actual_cases_3wk).all()
    # tiers agree except possibly where the notebook's 4-dp rounding sits exactly on an edge
    assert (m.tier == m.predicted_tier).mean() > 0.999


def test_forecast_from_records_equals_bundled(fc):
    week = pd.Timestamp("2025-07-14")
    recs = RAW[(RAW.ward_id == "DSCC_Ward_06") & (pd.to_datetime(RAW.date) <= week)].tail(5).copy()
    recs.loc[pd.to_datetime(recs.date) == week, "dengue_cases"] = np.nan   # week-t cases not needed
    a = fc.forecast_from_records(recs, "DSCC_Ward_06", "2025-07-14")
    b = fc.forecast("DSCC_Ward_06", "2025-07-14")
    assert a["predicted_cases_3wk"] == b["predicted_cases_3wk"] and a["risk_tier"] == b["risk_tier"]
    assert "actual" not in a and a["data_source"] == "caller_supplied_records"


def test_representative_low_and_high_periods(fc):
    low = fc.forecast("NCC_Ward_02", "2025-01-06")
    assert low["risk_tier"] == "Low" and not low["early_alert"]
    high_rows = fc.forecast_all("2024-08-05")
    assert any(r["risk_tier"] in ("High", "Critical") for r in high_rows)
    assert sum(r["actual"]["actual_cases_3wk"] for r in high_rows) > sum(r["actual"]["actual_cases_3wk"] for r in fc.forecast_all("2025-01-06"))


def test_forecast_all_returns_60_sorted_wards(fc):
    rows = fc.forecast_all("2025-12-29")
    assert len(rows) == 60 and [r["ward_id"] for r in rows] == sorted(CONFIG["ward_city"])
    assert all(r["actual"]["available"] is False for r in rows)      # t+4 is after the data ends


def test_deterministic(fc):
    assert fc.forecast("CCC_Ward_07", "2023-07-03") == fc.forecast("CCC_Ward_07", "2023-07-03")


@pytest.mark.parametrize("ward", ["XYZ_Ward_99", "ccc_ward_01", "", None, 5])
def test_rejects_unknown_ward(fc, ward):
    with pytest.raises(P.ForecastError) as e:
        fc.forecast(ward, "2025-06-16")
    assert e.value.code == "unknown_ward"


@pytest.mark.parametrize("bad,code", [("2025-06-17", "invalid_date"), ("16/06/2025", "invalid_date"), ("", "invalid_date"),
                                      (20250616, "invalid_date"), ("2026-11-16", "issue_week_out_of_range"),
                                      ("2015-12-28", "issue_week_out_of_range")])
def test_rejects_bad_dates(fc, bad, code):
    with pytest.raises(P.ForecastError) as e:
        fc.forecast("CCC_Ward_01", bad)
    assert e.value.code == code


@pytest.mark.parametrize("week", ["2016-01-04", "2016-01-11", "2016-01-18", "2016-01-25"])
def test_rejects_incomplete_history(fc, week):
    with pytest.raises(P.ForecastError) as e:
        fc.forecast("CCC_Ward_01", week)
    assert e.value.code == "insufficient_history"
    with pytest.raises(P.ForecastError):
        fc.forecast_all(week)
    assert fc.forecast("CCC_Ward_01", "2016-02-01")["issue_week"] == "2016-02-01"


def test_rejects_missing_or_nonfinite_supplied_inputs(fc):
    week = pd.Timestamp("2025-07-14")
    base = RAW[(RAW.ward_id == "DSCC_Ward_06") & (pd.to_datetime(RAW.date) <= week)].tail(5).copy()
    short = base.tail(4)
    with pytest.raises(P.ForecastError) as e:
        fc.forecast_from_records(short, "DSCC_Ward_06", "2025-07-14")
    assert e.value.code == "insufficient_history"
    for col, val in [("rainfall_mm", np.nan), ("relative_humidity_pct", np.inf)]:
        bad = base.copy()
        bad.loc[pd.to_datetime(bad.date) == week, col] = val
        with pytest.raises(P.ForecastError) as e:
            fc.forecast_from_records(bad, "DSCC_Ward_06", "2025-07-14")
        assert e.value.code == "invalid_input"
    nolag = base.copy()
    nolag.iloc[1, nolag.columns.get_loc("dengue_cases")] = np.nan     # a past case count is required
    with pytest.raises(P.ForecastError):
        fc.forecast_from_records(nolag, "DSCC_Ward_06", "2025-07-14")
    with pytest.raises(P.ForecastError) as e:
        fc.forecast_from_records(base.drop(columns=["rainfall_mm"]), "DSCC_Ward_06", "2025-07-14")
    assert e.value.code == "invalid_input"


def test_out_of_range_inputs_produce_warning(fc):
    week = pd.Timestamp("2025-07-14")
    recs = RAW[(RAW.ward_id == "DSCC_Ward_06") & (pd.to_datetime(RAW.date) <= week)].tail(5).copy()
    recs.loc[pd.to_datetime(recs.date) == week, "rainfall_mm"] = 900.0
    r = fc.forecast_from_records(recs, "DSCC_Ward_06", "2025-07-14")
    assert any("rainfall_mm" in w for w in r["warnings"])


def test_inference_speed(fc):
    fc.forecast_all("2025-06-16")
    t0 = time.perf_counter()
    for _ in range(20):
        fc.forecast_all("2025-06-16")
    assert (time.perf_counter() - t0) / 20 < 0.5
