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


def _forecast_error_type():
    mod = sys.modules.get("predict")
    return getattr(mod, "ForecastError", None)


class ModelService:
    def __init__(self, loader=load_portable_forecaster):
        self._loader = loader
        self.forecaster = None
        self.load_failed = False

    def load(self) -> None:
        try:
            self.forecaster = self._loader()
            self.load_failed = False
        except Exception:
            # Details go to the server log only, never to HTTP clients.
            logger.exception("Portable model failed to load")
            self.forecaster = None
            self.load_failed = True

    @property
    def ready(self) -> bool:
        return self.forecaster is not None

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
