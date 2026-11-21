from fastapi import HTTPException, Query
from fastapi.testclient import TestClient

from app.main import create_app


def _assert_error(body, code):
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str)


def _app_with_test_routes():
    """Throwaway routes registered only inside tests to exercise the handlers."""
    app = create_app()

    @app.get("/_t/validate")
    def validate(n: int = Query(...)):
        return {"n": n}

    @app.get("/_t/http")
    def http():
        raise HTTPException(status_code=400, detail="C:\\secret\\path leaked")

    @app.get("/_t/boom")
    def boom():
        raise RuntimeError("secret C:\\Users\\user\\key.txt")

    return TestClient(app, raise_server_exceptions=False)


def test_unknown_route_json_404(client):
    r = client.get("/nope")
    assert r.status_code == 404
    _assert_error(r.json(), "not_found")


def test_method_not_allowed(client):
    r = client.post("/health")
    assert r.status_code == 405
    _assert_error(r.json(), "method_not_allowed")


def test_validation_error_is_safe():
    c = _app_with_test_routes()
    r = c.get("/_t/validate", params={"n": "C:\\private\\abc"})
    assert r.status_code == 422
    _assert_error(r.json(), "validation_error")
    assert "private" not in r.text
    assert r.json()["error"]["details"][0]["loc"] == ["query", "n"]
    assert c.get("/_t/validate").status_code == 422


def test_http_exception_detail_not_leaked():
    r = _app_with_test_routes().get("/_t/http")
    assert r.status_code == 400
    _assert_error(r.json(), "bad_request")
    assert "secret" not in r.text


def test_unexpected_error_hides_internals():
    r = _app_with_test_routes().get("/_t/boom")
    assert r.status_code == 500
    _assert_error(r.json(), "internal_error")
    for leak in ("Traceback", "secret", "RuntimeError", "C:\\", ".py"):
        assert leak not in r.text
