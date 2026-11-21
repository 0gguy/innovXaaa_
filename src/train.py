"""Step 2: Train RandomForest on chronological split and save model bundle."""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

DATA_PATH = Path("data/processed_dengue.csv")
VAL_RESULTS_PATH = Path("data/validation_results.csv")
MODEL_PATH = Path("models/dengue_model.joblib")

FEATURE_COLS = [
    "population_density_sqkm", "water_logging_risk_index", "sanitation_score",
    "rainfall_lag_2w", "rainfall_lag_3w", "rainfall_lag_4w",
    "temp_lag_2w", "temp_lag_3w", "temp_lag_4w",
    "humidity_lag_2w", "humidity_lag_3w", "humidity_lag_4w",
    "max_temp_lag_2w", "min_temp_lag_2w",
    "rainfall_sum_2_4w", "temp_mean_2_4w", "humidity_mean_2_4w",
]
TARGET = "dengue_cases"

# Upper bounds (exclusive) for each tier, in order
TIER_THRESHOLDS = {"Low": 2.0, "Medium": 5.0, "High": 10.0, "Critical": float("inf")}


def assign_risk_tier(cases: float) -> str:
    """Map weekly case count to a risk tier."""
    if cases < 2.0:
        return "Low"
    if cases < 5.0:
        return "Medium"
    if cases < 10.0:
        return "High"
    return "Critical"


def chronological_split(df: pd.DataFrame, train_frac: float = 0.8):
    """Earliest 80% of unique dates -> train, rest -> validation (no shuffling)."""
    unique_dates = np.sort(df["date"].unique())
    cutoff_idx = int(len(unique_dates) * train_frac)
    train_dates, val_dates = unique_dates[:cutoff_idx], unique_dates[cutoff_idx:]
    train_df = df[df["date"].isin(train_dates)]
    val_df = df[df["date"].isin(val_dates)]
    return train_df, val_df


def fmt_range(d: pd.DataFrame) -> str:
    return f"{d['date'].min().date()} to {d['date'].max().date()}"


def main() -> None:
    # 1. Load + sort by date
    df = pd.read_csv(DATA_PATH)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date", kind="stable").reset_index(drop=True)

    # 2-3. Split
    train_df, val_df = chronological_split(df)
    train_range, val_range = fmt_range(train_df), fmt_range(val_df)
    print(f"Train: {train_range} | rows: {len(train_df)}")
    print(f"Val:   {val_range} | rows: {len(val_df)}")

    X_train, y_train = train_df[FEATURE_COLS], train_df[TARGET]
    X_val, y_val = val_df[FEATURE_COLS], val_df[TARGET]

    # 4. Train
    model = RandomForestRegressor(
        n_estimators=150, max_depth=14, min_samples_leaf=3,
        random_state=42, n_jobs=-1,
    )
    model.fit(X_train, y_train)

    # 5. Evaluate
    preds = model.predict(X_val)
    mae = mean_absolute_error(y_val, preds)
    rmse = float(np.sqrt(mean_squared_error(y_val, preds)))
    r2 = r2_score(y_val, preds)
    print(f"Validation MAE: {mae:.4f} | RMSE: {rmse:.4f} | R2: {r2:.4f}")

    # 7. Save validation results
    results = pd.DataFrame({
        "date": val_df["date"].values,
        "city": val_df["city"].values,
        "ward_id": val_df["ward_id"].values,
        "actual_cases": y_val.values,
        "predicted_cases": preds,
    })
    results["predicted_tier"] = results["predicted_cases"].apply(assign_risk_tier)
    results["actual_tier"] = results["actual_cases"].apply(assign_risk_tier)
    VAL_RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    results.to_csv(VAL_RESULTS_PATH, index=False)
    print(f"Saved {VAL_RESULTS_PATH}")

    # 8. Save model bundle
    bundle = {
        "model": model,
        "feature_cols": FEATURE_COLS,
        "feature_importances": dict(zip(FEATURE_COLS, model.feature_importances_)),
        "tier_thresholds": TIER_THRESHOLDS,
        "metrics": {
            "mae": mae, "rmse": rmse, "r2": r2,
            "train_range": train_range, "val_range": val_range,
        },
    }
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH, compress=3)
    print(f"Saved {MODEL_PATH}")


if __name__ == "__main__":
    main()