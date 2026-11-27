import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import APP_MODE, APP_TITLE, APP_VERSION, REPLAY_NOTICE, get_cors_origins
from .errors import ApiError, register_error_handlers
from .model_service import ModelService, load_portable_forecaster, load_weekly_companion
from .planning import parameters as PP
from .planning.allocate import AllocationInputError
from .planning.demand import PlanningDataError
from .planning.hospital import HospitalInputError
from .planning.scenario import build_hospital_routing, build_plan
from .schemas import HealthResponse

logger = logging.getLogger("dengue_api")


def _envelope(**payload) -> dict:
    return {"mode": APP_MODE, "notice": REPLAY_NOTICE, **payload}


def create_app(model_loader=load_portable_forecaster, weekly_loader=load_weekly_companion) -> FastAPI:
    """Build the app. `model_loader` / `weekly_loader` are test hooks; models load once, at startup.

    The weekly companion is optional: if `weekly_loader` fails (or is None) Phase 1 is unaffected
    and weekly values use the equal split, reported as source "equal_split".
    """
    service = ModelService(model_loader, weekly_loader)

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
            weekly_companion=service.weekly_info(),
        )

    # include_weekly (default false) adds a `weekly` block to each forecast: the same ward and issue
    # week, split into t+2, t+3, t+4 and reconciled to predicted_cases_3wk. Without it, responses are
    # exactly as before.
    @app.get("/forecast/{ward_id}")
    def forecast_ward(ward_id: str, issue_date: str = Query(...), include_drivers: bool = True,
                      include_weekly: bool = False) -> dict:
        result = service.call("forecast", ward_id, issue_date, include_drivers=include_drivers)
        if include_weekly:
            service.attach_weekly([result])
        return _envelope(forecast=result)

    @app.get("/forecast")
    def forecast_all(issue_date: str = Query(...), include_drivers: bool = False,
                     include_weekly: bool = False) -> dict:
        results = service.call("forecast_all", issue_date, include_drivers=include_drivers)
        if include_weekly:
            service.attach_weekly(results)
        return _envelope(issue_date=issue_date, count=len(results), forecasts=results)

    @app.get("/allocation")
    def allocation(
        issue_date: str | None = Query(None, description="Monday issue week; default: last valid issue week"),
        stock_pct: int = Query(PP.STOCK_PCT_DEFAULT, ge=PP.STOCK_PCT_MIN, le=PP.STOCK_PCT_MAX),
        stock_pct_saline: int | None = Query(None, ge=PP.STOCK_PCT_MIN, le=PP.STOCK_PCT_MAX),
        stock_pct_kits: int | None = Query(None, ge=PP.STOCK_PCT_MIN, le=PP.STOCK_PCT_MAX),
        min_coverage_pct: int = Query(PP.MIN_COVERAGE_PCT_DEFAULT, ge=PP.MIN_COVERAGE_PCT_MIN,
                                      le=PP.MIN_COVERAGE_PCT_MAX),
        total_crews: int = Query(PP.TOTAL_CREWS_DEFAULT, ge=0, le=PP.TOTAL_CREWS_MAX),
    ) -> dict:
        """Minimum Coverage + Risk Priority plan for all wards (planning scenario, not inventory)."""
        if issue_date is None:
            issue_date = service.call("valid_issue_weeks")["last"]
        results = service.call("forecast_all", issue_date, include_drivers=False, include_actual=False)
        service.attach_weekly(results)
        densities = service.ward_densities(results)
        try:
            plan = build_plan(results, densities, stock_pct=stock_pct, min_coverage_pct=min_coverage_pct,
                              total_crews=total_crews, stock_pct_saline=stock_pct_saline,
                              stock_pct_kits=stock_pct_kits)
        except (PlanningDataError, AllocationInputError):
            logger.exception("Allocation plan could not be built")
            raise ApiError(500, "planning_data_invalid",
                           "The forecast data could not be converted into a resource plan.") from None
        return _envelope(issue_date=results[0]["issue_week"], model_version=results[0]["model_version"], **plan)

    @app.get("/hospital-routing")
    def hospital_routing(
        issue_date: str | None = Query(None, description="Monday issue week; default: last valid issue week"),
        capacity_pct: int = Query(PP.CAPACITY_PCT_DEFAULT, ge=PP.CAPACITY_PCT_MIN, le=PP.CAPACITY_PCT_MAX),
    ) -> dict:
        """Within-city overflow routing of weekly bed planning units against hypothetical capacity."""
        if issue_date is None:
            issue_date = service.call("valid_issue_weeks")["last"]
        results = service.call("forecast_all", issue_date, include_drivers=False, include_actual=False)
        service.attach_weekly(results)
        densities = service.ward_densities(results)
        try:
            body = build_hospital_routing(results, densities, capacity_pct=capacity_pct)
        except (PlanningDataError, HospitalInputError):
            logger.exception("Hospital routing could not be built")
            raise ApiError(500, "planning_data_invalid",
                           "The forecast data could not be converted into a hospital routing plan.") from None
        return _envelope(issue_date=results[0]["issue_week"], model_version=results[0]["model_version"], **body)

    return app


app = create_app()
