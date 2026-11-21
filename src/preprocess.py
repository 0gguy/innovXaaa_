import pandas as pd


def main():
    # 1. Load the Excel dataset
    input_path = "data/hackathon_preli_dataset.xlsx"
    df = pd.read_excel(input_path, sheet_name="bangladesh_dengue_large_dataset")
    df["date"] = pd.to_datetime(df["date"])

    # 2. Sort strictly by ward_id and date ascending so time flows forward per ward
    df = df.sort_values(["ward_id", "date"]).reset_index(drop=True)
    rows_before = len(df)

    # 3. Group by ward_id so weather from one ward NEVER leaks into another ward
    grouped = df.groupby("ward_id")

    # 2-to-4-week mosquito breeding cycle lags (each row = 1 week)
    for lag in [2, 3, 4]:
        df[f"rainfall_lag_{lag}w"] = grouped["rainfall_mm"].shift(lag)
        df[f"temp_lag_{lag}w"] = grouped["avg_temp_c"].shift(lag)
        df[f"humidity_lag_{lag}w"] = grouped["relative_humidity_pct"].shift(lag)

    df["max_temp_lag_2w"] = grouped["max_temp_c"].shift(2)
    df["min_temp_lag_2w"] = grouped["min_temp_c"].shift(2)

    # Combined 2-to-4-week incubation window summaries
    df["rainfall_sum_2_4w"] = (
        df["rainfall_lag_2w"] + df["rainfall_lag_3w"] + df["rainfall_lag_4w"]
    )
    df["temp_mean_2_4w"] = df[
        ["temp_lag_2w", "temp_lag_3w", "temp_lag_4w"]
    ].mean(axis=1)
    df["humidity_mean_2_4w"] = df[
        ["humidity_lag_2w", "humidity_lag_3w", "humidity_lag_4w"]
    ].mean(axis=1)

    # 4. Keep identifiers, static ward vulnerability columns, lag features, and target
    keep_cols = [
        "date",
        "city",
        "ward_id",
        "population_density_sqkm",
        "water_logging_risk_index",
        "sanitation_score",
        "rainfall_lag_2w",
        "rainfall_lag_3w",
        "rainfall_lag_4w",
        "temp_lag_2w",
        "temp_lag_3w",
        "temp_lag_4w",
        "humidity_lag_2w",
        "humidity_lag_3w",
        "humidity_lag_4w",
        "max_temp_lag_2w",
        "min_temp_lag_2w",
        "rainfall_sum_2_4w",
        "temp_mean_2_4w",
        "humidity_mean_2_4w",
        "dengue_cases",
    ]
    df_clean = df[keep_cols].dropna().reset_index(drop=True)

    # 5. Save processed dataset
    output_path = "data/processed_dengue.csv"
    df_clean.to_csv(output_path, index=False)

    print(f"Rows before: {rows_before} -> Rows after dropping initial lag NaNs: {len(df_clean)}")
    print(f"Saved clean dataset to: {output_path}")
    print("Feature columns:", [c for c in keep_cols if c not in ["date", "city", "ward_id", "dengue_cases"]])


if __name__ == "__main__":
    main()