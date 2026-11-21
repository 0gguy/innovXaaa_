from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import APP_MODE, APP_TITLE, APP_VERSION, REPLAY_NOTICE, get_cors_origins
from .errors import register_error_handlers
from .model_service import ModelService, load_portable_forecaster
from .schemas import HealthResponse


def _envelope(**payload) -> dict:
    return {"mode": APP_MODE, "notice": REPLAY_NOTICE, **payload}


def create_app(model_loader=load_portable_forecaster) -> FastAPI:
    """Build the app. `model_loader` is a test hook; the model loads once, at startup."""
    service = ModelService(model_loader)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        service.load()
        yield

    app = FastAPI(title=APP_TITLE, version=APP_VERSION, lifespan=lifespan)
    app.state.model_service = service

    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_cors_origins(),
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )
    register_error_handlers(app)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        """API liveness plus whether the portable model actually loaded at startup."""
        return HealthResponse(status="ok", api_ready=True, model_ready=service.ready, mode=APP_MODE)

    @app.get("/meta")
    def meta() -> dict:
        """Wards, cities and valid issue weeks, taken from the loaded ML package."""
        service.call("wards")  # 503 if the model is unavailable
        f = service.forecaster
        by_city: dict[str, list[str]] = {}
        for ward in f.wards():
            by_city.setdefault(f.ward_city[ward], []).append(ward)
        cities = [{"city": c, "ward_count": len(w), "wards": w} for c, w in sorted(by_city.items())]
        return _envelope(
            model_version=f.model_version,
            cities=cities,
            wards=[{"ward_id": w, "city": f.ward_city[w]} for w in f.wards()],
            ward_count=len(f.ward_city),
            valid_issue_weeks=f.valid_issue_weeks(),
            horizon_weeks=f.config["horizon_weeks"],
            risk_tiers={
                "labels": f.tier_labels,
                "edges": [float(e) for e in f.tier_edges],
                "rule": f.config["risk_tiers"]["rule"],
            },
            early_alert={"threshold": f.alert_threshold, "rule": f.config["early_alert"]["rule"]},
        )

    @app.get("/forecast/{ward_id}")
    def forecast_ward(ward_id: str, issue_date: str = Query(...), include_drivers: bool = True) -> dict:
        result = service.call("forecast", ward_id, issue_date, include_drivers=include_drivers)
        return _envelope(forecast=result)

    @app.get("/forecast")
    def forecast_all(issue_date: str = Query(...), include_drivers: bool = False) -> dict:
        results = service.call("forecast_all", issue_date, include_drivers=include_drivers)
        return _envelope(issue_date=issue_date, count=len(results), forecasts=results)

    return app


app = create_app()
