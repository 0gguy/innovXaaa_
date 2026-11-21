from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import APP_MODE, APP_TITLE, APP_VERSION, get_cors_origins
from .errors import register_error_handlers
from .schemas import HealthResponse


def create_app() -> FastAPI:
    app = FastAPI(title=APP_TITLE, version=APP_VERSION)

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
        """API liveness only. model_ready stays False until the ML model is integrated."""
        return HealthResponse(status="ok", api_ready=True, model_ready=False, mode=APP_MODE)

    return app


app = create_app()
