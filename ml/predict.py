"""
Dengue 2-4-week ward forecast: inference module for the application backend.

    from predict import forecast, forecast_all
    forecast("DNCC_Ward_12", "2025-06-16")
    forecast_all("2025-06-16")

The model, configuration and historical records are loaded once (on first
use) and reused. Features are built by `features.build_features`, the same
code used to train the model; the backend never assembles features itself.

Every result is a JSON-serializable dict (schema in integration_guide.md).
Invalid requests raise `ForecastError` with a machine-readable `code`.

The organizer data ends 2025-12-29, so forecasts from the bundled data are a
historical replay. `forecast_from_records` accepts newer observations supplied
by the caller (same columns as the organizer CSV).
"""

from __future__ import annotations

import json
import math
import os
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Iterable

import joblib
import numpy as np
import pandas as pd
from xgboost import DMatrix

import features as F

PKG_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = PKG_DIR / "model_config.json"
DEFAULT_DATA = Path(os.environ.get("DENGUE_DATA_PATH", PKG_DIR / "data" / "dengue_dataset.csv"))

DRIVER_NOTE = ("Additive model attributions (XGBoost TreeSHAP) of the raw model output; "
               "they describe how the model reached its number, not causes of dengue.")


class ForecastError(ValueError):
    """Invalid forecast request. `code` is stable and safe to show to clients."""

    def __init__(self, code: str, message: str):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {"error": self.code, "message": self.message}


def _parse_week(issue_date) -> pd.Timestamp:
    if isinstance(issue_date, (pd.Timestamp, datetime, date)):
        ts = pd.Timestamp(issue_date)
    elif isinstance(issue_date, str):
        try:
            ts = pd.Timestamp(datetime.strptime(issue_date.strip(), "%Y-%m-%d"))
        except ValueError:
            raise ForecastError("invalid_date", f"issue_date must be 'YYYY-MM-DD', got {issue_date!r}") from None
    else:
        raise ForecastError("invalid_date", f"issue_date must be a 'YYYY-MM-DD' string or a date, got {type(issue_date).__name__}")
    if ts != ts.normalize():
        raise ForecastError("invalid_date", "issue_date must be a calendar date without a time of day")
    if ts.weekday() != 0:
        raise ForecastError("invalid_date", f"{ts.date()} is not a Monday; weeks in the data are labelled by their Monday")
    return ts


class Forecaster:
    """Loads the model once and serves forecasts. Thread-safe for reads."""

    def __init__(self, data_path: str | Path | None = None, model_path: str | Path | None = None,
                 config_path: str | Path | None = None):
        self.config_path = Path(config_path or DEFAULT_CONFIG)
        self.config = json.loads(self.config_path.read_text())
        self.model_version = self.config["model_version"]
        self._check_config()

        self.model_path = Path(model_path or (self.config_path.parent / self.config["model_file"]))
        # The model file is a trusted artifact produced by dengue_analysis_final.ipynb.
        self.model = joblib.load(self.model_path)
        self._pre = self.model.named_steps["preprocessor"]
        self._booster = self.model.named_steps["model"].get_booster()
        self._driver_index = self._build_driver_index()

        self.ward_city: dict[str, str] = self.config["ward_city"]
        self.tier_labels = self.config["risk_tiers"]["labels"]
        self.tier_edges = np.asarray(self.config["risk_tiers"]["edges"], dtype=float)
        self.alert_threshold = float(self.config["early_alert"]["threshold"])
        self.ranges = self.config["numeric_ranges_train"]

        self.data_path = Path(data_path or DEFAULT_DATA)
        raw = pd.read_csv(self.data_path)
        self._feat = F.build_features(raw).set_index(["ward_id", "date"]).sort_index()
        # Ground truth for historical replay only. Never used to build features.
        actual = F.build_target(raw)
        keys = F.prepare_records(raw)[["ward_id", "date"]]
        self._actual = pd.Series(actual.values, index=pd.MultiIndex.from_frame(keys)).sort_index()
        self.data_first_week = self._feat.index.get_level_values("date").min()
        self.data_last_week = self._feat.index.get_level_values("date").max()

    # ------------------------------------------------------------------ setup
    def _check_config(self):
        cfg = self.config
        if cfg["feature_columns"] != F.FEATURE_COLUMNS:
            raise RuntimeError("model_config.json feature_columns do not match features.FEATURE_COLUMNS")
        if cfg["numeric_features"] != F.NUMERIC_FEATURES or cfg["categorical_features"] != F.CATEGORICAL_FEATURES:
            raise RuntimeError("model_config.json feature groups do not match features.py")
        if cfg["horizon_weeks"] != list(F.TARGET_HORIZON_WEEKS):
            raise RuntimeError("model_config.json horizon does not match features.py")

    def _build_driver_index(self):
        groups = self.config["driver_groups"]
        names = list(self._pre.get_feature_names_out())
        if len(names) != self._booster.num_features():
            raise RuntimeError("Preprocessor output width does not match the booster")

        def source(n):
            base = n.split("__", 1)[1]
            for c in F.CATEGORICAL_FEATURES:
                if base.startswith(c + "_"):
                    return c
            return base

        col_group = np.array([next(g for g, fs in groups.items() if source(n) in fs) for n in names])
        return {g: np.flatnonzero(col_group == g) for g in groups}

    # -------------------------------------------------------------- utilities
    def tier(self, predicted_cases: float) -> str:
        """Risk tier for a clipped predicted 3-week total (see model_config.json)."""
        if not math.isfinite(predicted_cases) or predicted_cases < 0:
            raise ForecastError("invalid_input", f"predicted value must be finite and >= 0, got {predicted_cases}")
        return self.tier_labels[int(np.searchsorted(self.tier_edges, predicted_cases, side="right"))]

    def wards(self) -> list[str]:
        return sorted(self.ward_city)

    def valid_issue_weeks(self) -> dict:
        return dict(self.config["valid_issue_weeks"])

    def _check_ward(self, ward_id):
        if not isinstance(ward_id, str) or ward_id not in self.ward_city:
            raise ForecastError("unknown_ward", f"Unknown ward_id {ward_id!r}. Valid wards: {len(self.ward_city)} IDs such as 'CCC_Ward_01'.")

    def _rows_for(self, feat_rows: pd.DataFrame, context: str) -> pd.DataFrame:
        """Validate engineered rows before they reach the model."""
        for (ward, week), row in feat_rows.iterrows():
            if not bool(row["features_complete"]):
                missing = [c for c in F.NUMERIC_FEATURES if not np.isfinite(row[c])]
                if int(row["history_weeks_available"]) == F.MIN_HISTORY_WEEKS - 1:
                    raise ForecastError("invalid_input", f"{ward} {week.date()}: missing or non-finite inputs: {missing}")
                raise ForecastError(
                    "insufficient_history",
                    f"{ward} {week.date()}: {F.MIN_HISTORY_WEEKS} consecutive weeks of records (issue week + 4 previous) are required; "
                    f"{int(row['history_weeks_available'])} of the 4 previous weeks are present. Missing or non-finite: {missing[:6]}{'...' if len(missing) > 6 else ''}")
            if row["city"] != self.ward_city[ward]:
                raise ForecastError("invalid_input", f"{ward} belongs to {self.ward_city[ward]}, records say {row['city']} ({context})")
        X = feat_rows.reset_index()[F.FEATURE_COLUMNS]
        num = X[F.NUMERIC_FEATURES].to_numpy(dtype=float)
        if not np.isfinite(num).all():
            raise ForecastError("invalid_input", "Non-finite feature values reached the model")
        return X

    def _range_warnings(self, X_row: pd.Series) -> list[str]:
        out = []
        for c, r in self.ranges.items():
            v = float(X_row[c])
            if v < r["min"] or v > r["max"]:
                out.append(f"{c}={v:g} is outside the training range [{r['min']:g}, {r['max']:g}]")
        return out

    def _predict(self, X: pd.DataFrame, include_drivers: bool):
        raw = self.model.predict(X).astype(float)
        drivers = None
        if include_drivers:
            contrib = self._booster.predict(DMatrix(self._pre.transform(X)), pred_contribs=True)
            gap = np.abs(contrib.sum(axis=1) - raw)
            drivers = []
            for i in range(len(X)):
                if gap[i] > 1e-3:      # attribution does not reproduce the output: do not report it
                    drivers.append(None)
                    continue
                groups = [{"group": g, "contribution": round(float(contrib[i, idx].sum()), 3)} for g, idx in self._driver_index.items()]
                groups.sort(key=lambda d: abs(d["contribution"]), reverse=True)
                drivers.append({"baseline": round(float(contrib[i, -1]), 3), "groups": groups, "note": DRIVER_NOTE})
        return raw, drivers

    def _result(self, ward, week, raw_value, drivers, warnings, include_actual, source):
        predicted = max(0.0, float(raw_value))
        res = {
            "ward_id": ward,
            "city": self.ward_city[ward],
            "issue_week": str(week.date()),
            "horizon_weeks": list(F.TARGET_HORIZON_WEEKS),
            "forecast_weeks": [str((week + pd.Timedelta(weeks=h)).date()) for h in F.TARGET_HORIZON_WEEKS],
            "predicted_cases_3wk": round(predicted, 4),
            "risk_tier": self.tier(predicted),
            "early_alert": bool(predicted > self.alert_threshold),
            "raw_model_output": round(float(raw_value), 4),
            "model_version": self.model_version,
            "data_source": source,
            "warnings": warnings,
        }
        if drivers is not None:
            res["drivers"] = drivers
        if include_actual:
            actual = None
            if source == "bundled_historical_data":
                v = self._actual.get((ward, week), np.nan)
                actual = None if pd.isna(v) else int(v)
            res["actual"] = {
                "available": actual is not None,
                "actual_cases_3wk": actual,
                "actual_risk_tier": self.tier(float(actual)) if actual is not None else None,
                "note": "Observed outcome from the historical data, for comparison only; not an input to the forecast.",
            }
        return res

    # ------------------------------------------------------------------- API
    def forecast(self, ward_id: str, issue_date, include_drivers: bool = True, include_actual: bool = True) -> dict:
        """Forecast for one ward and issue week from the bundled historical data."""
        self._check_ward(ward_id)
        week = _parse_week(issue_date)
        if (ward_id, week) not in self._feat.index:
            raise ForecastError("issue_week_out_of_range",
                                f"No record for {ward_id} in week {week.date()}. Bundled data covers "
                                f"{self.data_first_week.date()}..{self.data_last_week.date()}; forecasts need "
                                f"{self.config['valid_issue_weeks']['first']}..{self.config['valid_issue_weeks']['last']}.")
        rows = self._feat.loc[[(ward_id, week)]]
        X = self._rows_for(rows, "bundled data")
        raw, drivers = self._predict(X, include_drivers)
        warnings = self._range_warnings(X.iloc[0])
        return self._result(ward_id, week, raw[0], drivers[0] if drivers else None, warnings,
                            include_actual, "bundled_historical_data")

    def forecast_all(self, issue_date, include_drivers: bool = False, include_actual: bool = True) -> list[dict]:
        """Forecast every ward for one issue week (one batched model call)."""
        week = _parse_week(issue_date)
        try:
            rows = self._feat.xs(week, level="date", drop_level=False)
        except KeyError:
            raise ForecastError("issue_week_out_of_range",
                                f"No records for week {week.date()}. Bundled data covers {self.data_first_week.date()}..{self.data_last_week.date()}.") from None
        missing = sorted(set(self.ward_city) - set(rows.index.get_level_values("ward_id")))
        if missing:
            raise ForecastError("insufficient_history", f"Week {week.date()} is missing records for wards: {missing}")
        rows = rows.sort_index()
        X = self._rows_for(rows, "bundled data")
        raw, drivers = self._predict(X, include_drivers)
        out = []
        for i, (ward, _) in enumerate(rows.index):
            out.append(self._result(ward, week, raw[i], drivers[i] if drivers else None,
                                    self._range_warnings(X.iloc[i]), include_actual, "bundled_historical_data"))
        return out

    def forecast_from_records(self, records: pd.DataFrame, ward_id: str, issue_date,
                              include_drivers: bool = True) -> dict:
        """Forecast from caller-supplied observations (e.g. weeks newer than the bundled data).

        `records` needs the organizer CSV columns for at least the issue week and the
        4 previous weeks of this ward. `dengue_cases` for the issue week itself is
        not used and may be NaN. No ground truth is attached.
        """
        self._check_ward(ward_id)
        week = _parse_week(issue_date)
        missing_cols = [c for c in F.REQUIRED_RAW_COLUMNS if c not in records.columns]
        if missing_cols:
            raise ForecastError("invalid_input", f"records are missing columns: {missing_cols}")
        recs = records.copy()
        recs["date"] = pd.to_datetime(recs["date"], errors="coerce")
        if recs["date"].isna().any():
            raise ForecastError("invalid_input", "records contain unparseable dates")
        recs = recs[(recs["ward_id"].astype(str) == ward_id) & (recs["date"] <= week)]
        if recs.empty or not (recs["date"] == week).any():
            raise ForecastError("insufficient_history", f"records contain no row for {ward_id} in week {week.date()}")
        try:
            feats = F.build_features(recs)
        except F.FeatureError as e:
            raise ForecastError("invalid_input", str(e)) from None
        rows = feats.set_index(["ward_id", "date"]).loc[[(ward_id, week)]]
        X = self._rows_for(rows, "supplied records")
        raw, drivers = self._predict(X, include_drivers)
        return self._result(ward_id, week, raw[0], drivers[0] if drivers else None,
                            self._range_warnings(X.iloc[0]), False, "caller_supplied_records")


_instance: Forecaster | None = None
_lock = threading.Lock()


def get_forecaster() -> Forecaster:
    """Process-wide Forecaster, created on first use."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = Forecaster()
    return _instance


def forecast(ward_id: str, issue_date, **kwargs) -> dict:
    return get_forecaster().forecast(ward_id, issue_date, **kwargs)


def forecast_all(issue_date, **kwargs) -> list[dict]:
    return get_forecaster().forecast_all(issue_date, **kwargs)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Dengue 2-4-week ward forecast (historical replay)")
    ap.add_argument("issue_date", help="Monday of the issue week, YYYY-MM-DD")
    ap.add_argument("ward_id", nargs="?", help="ward ID; omit with --all")
    ap.add_argument("--all", action="store_true", help="forecast all 60 wards")
    args = ap.parse_args()
    try:
        result = forecast_all(args.issue_date) if args.all else forecast(args.ward_id, args.issue_date)
        print(json.dumps(result, indent=2))
    except ForecastError as e:
        print(json.dumps(e.to_dict(), indent=2))
        raise SystemExit(2)
