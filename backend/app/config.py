"""Backend settings. Plain defaults, optionally overridden by environment variables."""
import os

APP_TITLE = "Dengue Ward Forecast API"
APP_VERSION = "0.1.0"
APP_MODE = "historical_replay"

DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def get_cors_origins() -> list[str]:
    """Allowed browser origins. Override with DENGUE_CORS_ORIGINS (comma-separated).

    A wildcard "*" is ignored on purpose; list explicit origins instead.
    """
    raw = os.environ.get("DENGUE_CORS_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    origins = [o.strip() for o in raw.split(",") if o.strip() and o.strip() != "*"]
    return origins or list(DEFAULT_CORS_ORIGINS)
