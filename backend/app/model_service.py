"""Owns the portable forecaster for the lifetime of the app.

Nothing from ml/ is imported when this module is imported; the load happens once, in
the FastAPI lifespan (see main.py). Entry point is ml/predict_portable.py, never the
original predict.Forecaster joblib loader.
"""
import logging
import os
import sys
from pathlib import Path

from .config import ML_DIR
from .errors import ApiError

logger = logging.getLogger("dengue_api")

# ForecastError.code -> HTTP status (per ml/integration_guide.md section 8)
_STATUS = {
    "unknown_ward": 404,
    "issue_week_out_of_range": 404,
    "invalid_date": 400,
    "insufficient_history": 422,
    "invalid_input": 422,
}
_MAX_MESSAGE = 300


def load_portable_forecaster(ml_dir: Path = ML_DIR):
    """Default loader: build one PortableForecaster (verifies artifact SHA-256 hashes)."""
    # Conservative thread use for a small local demo (must be set before xgboost loads).
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    ml_path = str(Path(ml_dir).resolve())
    if ml_path not in sys.path:  # no chdir; ml/ modules import each other by bare name
        sys.path.insert(0, ml_path)
    from predict_portable import PortableForecaster

    forecaster = PortableForecaster(base_dir=ml_path)
    try:
        forecaster.model.regressor.set_params(n_jobs=1)
    except Exception:  # thread hint only; never fail startup over it
        logger.warning("Could not set XGBoost n_jobs=1")
    return forecaster


def load_weekly_companion(forecaster):
    """Default weekly-companion loader (ml/phase2). Runs after the Phase 1 forecaster loaded.

    Checks the weekly model files' SHA-256 and their compatibility with the loaded Phase 1
    package: feature list, ward/city categories and the fitted preprocessor's column names.
    """
    ml_path = str(Path(ML_DIR).resolve())
    if ml_path not in sys.path:  # normally already added by load_portable_forecaster
        sys.path.insert(0, ml_path)
    import features  # Phase 1 ml/features.py, the same module the forecaster uses
    from phase2.weekly_model import WeeklyCompanion

    return WeeklyCompanion(
        features_module=features,
        ward_city=forecaster.ward_city,
        phase1_column_names=list(forecaster._pre.get_feature_names_out()),
    )


def _forecast_error_type():
    mod = sys.modules.get("predict")
    return getattr(mod, "ForecastError", None)


SOURCE_COMPANION = "companion"
SOURCE_EQUAL_SPLIT = "equal_split"
WEEKLY_NOTE = (
    "Split of predicted_cases_3wk into weeks t+2, t+3 and t+4. The weekly values add up to "
    "predicted_cases_3wk and never change it, the risk tier or the alert."
)


class ModelService:
    def __init__(self, loader=load_portable_forecaster, weekly_loader=load_weekly_companion):
        self._loader = loader
        self._weekly_loader = weekly_loader
        self.forecaster = None
        self.load_failed = False
        self.weekly = None
        self.weekly_fallback_reason: str | None = "companion_not_loaded"

    def load(self) -> None:
        try:
            self.forecaster = self._loader()
            self.load_failed = False
        except Exception:
            # Details go to the server log only, never to HTTP clients.
            logger.exception("Portable model failed to load")
            self.forecaster = None
            self.load_failed = True
        self._load_weekly()

    def _load_weekly(self) -> None:
        """Optional: Phase 1 keeps working (equal split) if the companion cannot be used."""
        self.weekly = None
        if self.forecaster is None or self._weekly_loader is None:
            self.weekly_fallback_reason = "companion_not_loaded"
            return
        try:
            self.weekly = self._weekly_loader(self.forecaster)
            self.weekly_fallback_reason = None
        except Exception:
            logger.exception("Weekly companion unavailable; weekly values will use the equal split")
            self.weekly_fallback_reason = "companion_unavailable"

    @property
    def ready(self) -> bool:
        return self.forecaster is not None

    def weekly_info(self) -> dict:
        return {
            "available": self.weekly is not None,
            "source": SOURCE_COMPANION if self.weekly is not None else SOURCE_EQUAL_SPLIT,
            "model_version": getattr(self.weekly, "version", None),
            "fallback_reason": self.weekly_fallback_reason,
            "horizon_weeks": [2, 3, 4],
            "reconciled_to": "predicted_cases_3wk",
        }

    def attach_weekly(self, results: list[dict]) -> None:
        """Add a `weekly` block to each (already validated) Phase 1 result, in place.

        Phase 1 fields are never modified. Uses the companion if it loaded, otherwise (or if the
        companion fails for this request) the equal split, and says which one in `source`.
        """
        if not results:
            return
        totals = [float(r["predicted_cases_3wk"]) for r in results]
        values, source, reason = None, SOURCE_EQUAL_SPLIT, self.weekly_fallback_reason
        if self.weekly is not None:
            try:
                values = self.weekly.split(self._feature_rows(results), totals).tolist()
                source, reason = SOURCE_COMPANION, None
            except Exception:
                logger.exception("Weekly companion failed for this request; equal split used")
                values, reason = None, "companion_inference_failed"
        if values is None:
            values = [[t / 3.0, t / 3.0, t - 2.0 * (t / 3.0)] for t in totals]
        version = self.weekly.version if source == SOURCE_COMPANION else None
        for r, v in zip(results, values):
            r["weekly"] = {
                "source": source,
                "model_version": version,
                "fallback_reason": reason,
                "reconciled_to": "predicted_cases_3wk",
                "weeks": [
                    {"horizon_week": h, "forecast_week": fw, "predicted_cases": float(x)}
                    for h, fw, x in zip(r["horizon_weeks"], r["forecast_weeks"], v)
                ],
                "note": WEEKLY_NOTE,
            }

    def _feature_rows(self, results: list[dict]):
        """The Phase 1 feature rows behind these results (same ward and issue week).

        Reads the feature table PortableForecaster built at startup (no recomputation)."""
        import pandas as pd

        keys = [(r["ward_id"], pd.Timestamp(r["issue_week"])) for r in results]
        return self.forecaster._feat.loc[keys].reset_index()

    def call(self, method: str, *args, **kwargs):
        """Run a forecaster method, translating its ForecastError into an ApiError."""
        if self.forecaster is None:
            raise ApiError(503, "model_unavailable", "The forecasting model is not available.")
        try:
            return getattr(self.forecaster, method)(*args, **kwargs)
        except Exception as exc:
            fe = _forecast_error_type()
            if fe is not None and isinstance(exc, fe):
                code = getattr(exc, "code", "invalid_input")
                msg = str(getattr(exc, "message", "Invalid request."))[:_MAX_MESSAGE]
                raise ApiError(_STATUS.get(code, 422), code, msg) from None
            raise  # unexpected: generic 500 handler logs it and hides details
