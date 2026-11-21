"""
Single source of truth for dengue forecasting features and target.

Used by BOTH the training notebook (dengue_analysis_final.ipynb) and the
inference module (predict.py). Do not re-implement this logic elsewhere.

Conventions
-----------
* One row = one ward x one week. `date` is the week label in the organizer CSV
  (always a Monday). "Week t" below means the row whose date is t.
* A forecast is issued for week t once week t's weather and week t-1's case
  counts are known. Features only use weeks <= t.
* Target = dengue cases in weeks t+2, t+3 and t+4 (summed). It is built by a
  separate function, `build_target`, which is never called at inference time.
* Lags are calendar lags: "lag 3w" is the value exactly 21 days earlier for the
  same ward. If that week is missing from the data, the lag is NaN (it is never
  taken from a different ward or a different week).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

FEATURE_SET_VERSION = "1.0.0"

KEY_COLUMNS = ["date", "city", "ward_id"]

REQUIRED_RAW_COLUMNS = [
    "date",
    "city",
    "ward_id",
    "population_density_sqkm",
    "water_logging_risk_index",
    "sanitation_score",
    "avg_temp_c",
    "max_temp_c",
    "min_temp_c",
    "rainfall_mm",
    "relative_humidity_pct",
    "dengue_cases",
]

LAG_WEEKS = (1, 2, 3, 4)
ROLLING_RAIN_WINDOWS = (2, 3, 4)

# Number of consecutive weeks (including the issue week) needed for every
# feature to be defined: issue week + 4 previous weeks.
MIN_HISTORY_WEEKS = 1 + max(LAG_WEEKS)

TARGET_COLUMN = "future_dengue_cases_2_4w"
TARGET_HORIZON_WEEKS = (2, 3, 4)

# Exact order used when the original model was trained (notebook cell 52).
NUMERIC_FEATURES = [
    # Ward vulnerability (static)
    "population_density_sqkm",
    "water_logging_risk_index",
    "sanitation_score",
    # Issue-week weather
    "avg_temp_c",
    "max_temp_c",
    "min_temp_c",
    "rainfall_mm",
    "relative_humidity_pct",
    # Historical rainfall
    "rainfall_lag_1w",
    "rainfall_lag_2w",
    "rainfall_lag_3w",
    "rainfall_lag_4w",
    "rain_roll2w_sum",
    "rain_roll3w_sum",
    "rain_roll4w_sum",
    # Historical temperature (lags of avg_temp_c)
    "temp_lag_1w",
    "temp_lag_2w",
    "temp_lag_3w",
    "temp_lag_4w",
    # Historical humidity (lags of relative_humidity_pct)
    "humidity_lag_1w",
    "humidity_lag_2w",
    "humidity_lag_3w",
    "humidity_lag_4w",
    # Historical dengue cases (weeks t-1 .. t-4; week t itself is NOT used)
    "dengue_lag_1w",
    "dengue_lag_2w",
    "dengue_lag_3w",
    "dengue_lag_4w",
    "dengue_roll4w_mean",
    # Seasonality
    "month_sin",
    "month_cos",
]

CATEGORICAL_FEATURES = ["city", "ward_id"]

FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES

# Source column for each lagged family (matches the original model).
_LAG_SOURCES = {
    "rainfall_lag_{k}w": "rainfall_mm",
    "temp_lag_{k}w": "avg_temp_c",
    "humidity_lag_{k}w": "relative_humidity_pct",
    "dengue_lag_{k}w": "dengue_cases",
}

# Raw columns whose missing value makes a row unusable at issue time.
_ISSUE_WEEK_INPUTS = [
    "population_density_sqkm",
    "water_logging_risk_index",
    "sanitation_score",
    "avg_temp_c",
    "max_temp_c",
    "min_temp_c",
    "rainfall_mm",
    "relative_humidity_pct",
]


class FeatureError(ValueError):
    """Raised when raw records cannot be turned into valid features."""


def prepare_records(df: pd.DataFrame) -> pd.DataFrame:
    """Validate raw records and return a copy sorted by ward_id, date.

    Checks required columns, parses dates, rejects duplicate ward-weeks and
    rejects a ward that appears under more than one city.
    """
    missing = [c for c in REQUIRED_RAW_COLUMNS if c not in df.columns]
    if missing:
        raise FeatureError(f"Missing required columns: {missing}")

    out = df[REQUIRED_RAW_COLUMNS].copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    if out["date"].isna().any():
        raise FeatureError("Some 'date' values could not be parsed.")
    out["city"] = out["city"].astype(str)
    out["ward_id"] = out["ward_id"].astype(str)

    dup = out.duplicated(subset=["ward_id", "date"])
    if dup.any():
        raise FeatureError(
            f"{int(dup.sum())} duplicate (ward_id, date) rows found."
        )

    cities_per_ward = out.groupby("ward_id")["city"].nunique()
    if (cities_per_ward > 1).any():
        bad = cities_per_ward[cities_per_ward > 1].index.tolist()
        raise FeatureError(f"Wards mapped to more than one city: {bad}")

    return out.sort_values(["ward_id", "date"]).reset_index(drop=True)


def _calendar_shift(df: pd.DataFrame, column: str, weeks: int) -> pd.Series:
    """Value of `column` exactly `weeks` weeks earlier (weeks>0) or later
    (weeks<0) for the same ward. NaN if that ward-week is not in the data.

    Implemented as a merge on (ward_id, date +/- 7*weeks days), so a gap in
    the records can never pull a value from the wrong week or ward.
    """
    src = df[["ward_id", "date", column]].copy()
    src["date"] = src["date"] + pd.Timedelta(weeks=weeks)
    merged = df[["ward_id", "date"]].merge(
        src, on=["ward_id", "date"], how="left", validate="one_to_one"
    )
    return merged[column].astype("float64").values


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build the model's input features for every row of `df`.

    Uses only information from the same ward at the same or earlier weeks.
    Never reads future dengue cases and never builds the target.

    Returns a DataFrame sorted by (ward_id, date) with columns:
        date, city, ward_id, <FEATURE_COLUMNS in model order>,
        history_weeks_available, features_complete
    `features_complete` is True only when every numeric feature is finite.
    Rows with features_complete == False must not be sent to the model.
    """
    rec = prepare_records(df)
    out = rec[KEY_COLUMNS].copy()

    for col in _ISSUE_WEEK_INPUTS:
        out[col] = rec[col]

    shifted = {}
    for template, source in _LAG_SOURCES.items():
        for k in LAG_WEEKS:
            name = template.format(k=k)
            shifted[name] = _calendar_shift(rec, source, k)
    for name, values in shifted.items():
        out[name] = values

    # Rolling rainfall sums over the previous k weeks (week t excluded).
    # Equivalent to groupby(ward).shift(1).rolling(k).sum() on continuous data.
    for k in ROLLING_RAIN_WINDOWS:
        cols = [f"rainfall_lag_{j}w" for j in range(1, k + 1)]
        out[f"rain_roll{k}w_sum"] = out[cols].sum(axis=1, min_count=k)

    dengue_cols = [f"dengue_lag_{j}w" for j in LAG_WEEKS]
    out["dengue_roll4w_mean"] = out[dengue_cols].mean(axis=1, skipna=False)

    month = rec["date"].dt.month
    out["month_sin"] = np.sin(2 * np.pi * month / 12)
    out["month_cos"] = np.cos(2 * np.pi * month / 12)

    # Explicit history bookkeeping: how many of the previous 4 weeks exist.
    present = np.column_stack(
        [~np.isnan(_calendar_shift(rec.assign(_one=1.0), "_one", k))
         for k in LAG_WEEKS]
    )
    out["history_weeks_available"] = present.sum(axis=1).astype(int)

    numeric = out[NUMERIC_FEATURES].astype("float64")
    out["features_complete"] = np.isfinite(numeric.to_numpy()).all(axis=1)

    ordered = KEY_COLUMNS + [c for c in FEATURE_COLUMNS if c not in KEY_COLUMNS]
    extra = ["history_weeks_available", "features_complete"]
    return out[ordered + extra]


def build_target(df: pd.DataFrame) -> pd.Series:
    """Training/evaluation target: cases in weeks t+2, t+3, t+4 (summed).

    Returned in the same (ward_id, date) order as `build_features`.
    NaN when any of those three weeks is missing. NEVER call at inference.
    """
    rec = prepare_records(df)
    parts = [_calendar_shift(rec, "dengue_cases", -h) for h in TARGET_HORIZON_WEEKS]
    target = parts[0] + parts[1] + parts[2]
    return pd.Series(target, name=TARGET_COLUMN)


def build_model_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Features + target, restricted to rows where both are fully defined.

    Equivalent to the original notebook's cell 54 (dropna on features+target).
    """
    feats = build_features(df)
    feats[TARGET_COLUMN] = build_target(df).values
    ok = feats["features_complete"] & feats[TARGET_COLUMN].notna()
    return feats.loc[ok].reset_index(drop=True)
