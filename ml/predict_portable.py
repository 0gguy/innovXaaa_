"""
Windows-compatible candidate inference module (same public API as predict.py).

    from predict_portable import forecast, forecast_all, forecast_from_records
    forecast("DNCC_Ward_12", "2025-06-16")

What is different from predict.py
---------------------------------
predict.py loads ONE pickle that contains a scikit-learn Pipeline *and* an XGBoost
memory snapshot (`dengue_xgboost_model.joblib`). On the Windows machine that
snapshot failed to unserialize. This module loads the same already-trained model
from separate, portable parts:

  1. dengue_xgboost_model.ubj     native XGBoost model (fallback: dengue_xgboost_model.json)
  2. dengue_preprocessor.joblib   fitted scikit-learn preprocessor, a small pickle that
                                  contains no XGBoost object (fallback: dengue_preprocessor.json)

Everything else (feature building, validation, tiers, early alert, drivers, output schema,
error codes) is inherited unchanged from predict.Forecaster. Nothing is retrained or refitted.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

import features as F
from predict import DEFAULT_DATA, ForecastError, Forecaster  # noqa: F401  (ForecastError re-exported)

PKG_DIR = Path(__file__).resolve().parent
DEFAULT_MANIFEST = PKG_DIR / "portable_manifest.json"


class PortableLoadError(RuntimeError):
    """A portable artifact is missing, altered or cannot be loaded."""


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class JsonPreprocessor:
    """Pickle-free reimplementation of the fitted ColumnTransformer.

    Numeric columns pass through; each categorical column is one-hot encoded with the
    categories fitted in the original pipeline (unknown value -> all zeros). Output is a
    dense float64 array in the same column order as the original preprocessor.
    """

    def __init__(self, spec: dict):
        self.numeric = list(spec["numeric_features"])
        self.categorical = list(spec["categorical_features"])
        self.categories = {c: [str(v) for v in spec["categories"][c]] for c in self.categorical}
        self.input_columns = list(spec["input_columns"])
        self._names = np.array(spec["output_feature_names"], dtype=object)
        if spec.get("sparse_output"):
            raise PortableLoadError("JSON preprocessor only supports the dense layout the model was trained with")
        self.n_features_in_ = len(self.input_columns)
        self.feature_names_in_ = np.array(self.input_columns, dtype=object)

    def get_feature_names_out(self):
        return self._names.copy()

    def transform(self, X: pd.DataFrame) -> np.ndarray:
        blocks = [X[self.numeric].to_numpy(dtype="float64")]
        for col in self.categorical:
            values = X[col].astype(str).to_numpy()
            cats = np.array(self.categories[col], dtype=object)
            blocks.append((values[:, None] == cats[None, :]).astype("float64"))
        return np.hstack(blocks)


class PortablePipeline:
    """preprocessor -> native XGBoost regressor, same call pattern as the old sklearn Pipeline."""

    def __init__(self, preprocessor, regressor: XGBRegressor):
        self.preprocessor, self.regressor = preprocessor, regressor

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self.regressor.predict(self.preprocessor.transform(X))


class PortableForecaster(Forecaster):
    """Forecaster whose model is loaded from portable files. Public methods are inherited."""

    def __init__(self, data_path=None, base_dir=None, manifest_path=None, preprocessor: str = "auto",
                 verify_hashes: bool = True, config_path=None):
        self.base_dir = Path(base_dir or PKG_DIR)
        self.config_path = Path(config_path or self.base_dir / "model_config.json")
        self.config = json.loads(self.config_path.read_text())
        self.model_version = self.config["model_version"]
        self._check_config()

        manifest_file = Path(manifest_path or self.base_dir / "portable_manifest.json")
        if not manifest_file.exists():
            raise PortableLoadError(f"portable_manifest.json not found in {manifest_file.parent}")
        self.manifest = json.loads(manifest_file.read_text())
        if verify_hashes:
            self._verify_hashes()

        self.artifact_info: dict = {}
        regressor = self._load_regressor()
        pre = self._load_preprocessor(preprocessor)
        self.model = PortablePipeline(pre, regressor)
        self._pre = pre
        self._booster = regressor.get_booster()
        self._driver_index = self._build_driver_index()

        self.ward_city = self.config["ward_city"]
        self.tier_labels = self.config["risk_tiers"]["labels"]
        self.tier_edges = np.asarray(self.config["risk_tiers"]["edges"], dtype=float)
        self.alert_threshold = float(self.config["early_alert"]["threshold"])
        self.ranges = self.config["numeric_ranges_train"]

        self.data_path = Path(data_path or DEFAULT_DATA)
        raw = pd.read_csv(self.data_path)
        self._feat = F.build_features(raw).set_index(["ward_id", "date"]).sort_index()
        actual = F.build_target(raw)          # ground truth for historical replay only; never a feature
        keys = F.prepare_records(raw)[["ward_id", "date"]]
        self._actual = pd.Series(actual.values, index=pd.MultiIndex.from_frame(keys)).sort_index()
        self.data_first_week = self._feat.index.get_level_values("date").min()
        self.data_last_week = self._feat.index.get_level_values("date").max()

    # ------------------------------------------------------------------ loading
    def _verify_hashes(self):
        problems = []
        for name, meta in self.manifest["artifacts"].items():
            path = self.base_dir / name
            if not path.exists():
                problems.append(f"{name}: missing")
            elif path.stat().st_size != meta["bytes"] or _sha256(path) != meta["sha256"]:
                problems.append(f"{name}: size/SHA-256 differs from portable_manifest.json "
                                f"(expected {meta['bytes']:,} bytes, found {path.stat().st_size:,})")
        if problems:
            raise PortableLoadError(
                "Artifact check failed:\n  " + "\n  ".join(problems) +
                "\nBinary files were probably altered by Git line-ending conversion or an incomplete copy. "
                "Use the supplied .gitattributes (marks these files as binary) and copy the files again.")

    def _load_regressor(self) -> XGBRegressor:
        errors = []
        for name in self.manifest["load_order"]["model"]:
            path = self.base_dir / name
            try:
                reg = XGBRegressor()
                reg.load_model(str(path))
                n_expected = self.manifest["model"]["num_features"]
                if reg.get_booster().num_features() != n_expected:
                    raise PortableLoadError(f"{name}: expected {n_expected} input features, got {reg.get_booster().num_features()}")
                self.artifact_info["model_file"] = name
                return reg
            except Exception as exc:               # try the next format, but remember why
                errors.append(f"{name}: {type(exc).__name__}: {str(exc).strip().splitlines()[0][:200]}")
        raise PortableLoadError("Could not load the XGBoost model from any portable file:\n  " + "\n  ".join(errors) +
                                "\nRun  python tools/windows_diagnose.py  and send diagnose_report.txt.")

    def _load_preprocessor(self, mode: str):
        errors = []
        if mode in ("auto", "joblib"):
            try:
                import joblib
                pre = joblib.load(self.base_dir / "dengue_preprocessor.joblib")   # trusted project artifact
                if list(pre.feature_names_in_) != F.FEATURE_COLUMNS:
                    raise PortableLoadError("preprocessor input columns do not match features.FEATURE_COLUMNS")
                self.artifact_info["preprocessor_file"] = "dengue_preprocessor.joblib"
                return pre
            except Exception as exc:
                errors.append(f"dengue_preprocessor.joblib: {type(exc).__name__}: {str(exc).strip().splitlines()[0][:200]}")
                if mode == "joblib":
                    raise PortableLoadError("; ".join(errors)) from exc
        spec = json.loads((self.base_dir / "dengue_preprocessor.json").read_text())
        if spec["input_columns"] != F.FEATURE_COLUMNS:
            raise PortableLoadError("dengue_preprocessor.json input columns do not match features.FEATURE_COLUMNS")
        self.artifact_info["preprocessor_file"] = "dengue_preprocessor.json"
        if errors:
            self.artifact_info["preprocessor_fallback_reason"] = errors[0]
        return JsonPreprocessor(spec)


_instance: PortableForecaster | None = None
_lock = threading.Lock()


def get_forecaster() -> PortableForecaster:
    """Process-wide forecaster, created on first use."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = PortableForecaster()
    return _instance


def forecast(ward_id: str, issue_date, **kwargs) -> dict:
    return get_forecaster().forecast(ward_id, issue_date, **kwargs)


def forecast_all(issue_date, **kwargs) -> list[dict]:
    return get_forecaster().forecast_all(issue_date, **kwargs)


def forecast_from_records(records: pd.DataFrame, ward_id: str, issue_date, **kwargs) -> dict:
    return get_forecaster().forecast_from_records(records, ward_id, issue_date, **kwargs)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Dengue 2-4-week ward forecast, portable model files (historical replay)")
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
