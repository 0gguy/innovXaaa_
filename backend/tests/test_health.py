import subprocess
import sys

ALLOWED = "http://localhost:5173"


def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "api_ready": True, "model_ready": False, "mode": "historical_replay"}


def test_cors_allowed_origin(client):
    r = client.get("/health", headers={"Origin": ALLOWED})
    assert r.headers["access-control-allow-origin"] == ALLOWED


def test_cors_preflight_allowed(client):
    r = client.options("/health", headers={"Origin": ALLOWED, "Access-Control-Request-Method": "GET"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == ALLOWED


def test_cors_disallowed_origin(client):
    r = client.get("/health", headers={"Origin": "http://evil.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


def test_cors_preflight_disallowed_origin(client):
    r = client.options(
        "/health", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert "access-control-allow-origin" not in r.headers


def test_cors_no_wildcard(client):
    r = client.get("/health", headers={"Origin": ALLOWED})
    assert r.headers["access-control-allow-origin"] != "*"


def test_import_loads_no_ml_model():
    code = (
        "import sys; import app.main; "
        "names=('xgboost','sklearn','pandas','numpy','joblib','predict','predict_portable','features'); "
        "bad=[m for m in names if m in sys.modules]; "
        "sys.exit(1 if bad else 0)"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
