# Dengue Ward Forecast API — backend foundation

> **Status:** foundation only. **ML forecasting is NOT connected yet.**
> This is a **historical-replay prototype** (EDU AI Engineering Hackathon 2026),
> **not a live public-health alert system**.

Currently implemented: `GET /health`, consistent JSON errors, localhost-only CORS.
Not implemented: forecasting endpoints, `/meta`, model loading, database, auth, live data.
(When forecasting is added it is planned to use `ml/predict_portable.py`.)

## Windows 10 setup (PowerShell)

The virtual environment lives **outside** the repository so it is never committed.

```powershell
cd D:\denguehackathon\backend

# 1. Create the environment (Python 3.11+; tested with 3.13)
python -m venv $env:USERPROFILE\venvs\dengue-backend

# 2. Activate it
& "$env:USERPROFILE\venvs\dengue-backend\Scripts\Activate.ps1"
#    If scripts are blocked:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 3. Install dependencies
python -m pip install -r requirements.txt
```

## Run the tests

```powershell
python -m pytest -q
```

## Start the dev server

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000/health> (interactive docs: `/docs`). Stop with Ctrl+C.

## Current `/health` response

```json
{"status": "ok", "api_ready": true, "model_ready": false, "mode": "historical_replay"}
```

`api_ready` means the API process is up. `model_ready` is `false` because no model is
loaded or verified by the backend yet.

## Errors

All errors use one shape; internals (tracebacks, paths) are never returned:

```json
{"error": {"code": "not_found", "message": "Resource not found."}}
```

Codes: `bad_request`, `not_found`, `method_not_allowed`, `validation_error`
(adds a `details` list of `loc`/`msg`/`type`), `internal_error` (HTTP 500).

## CORS

Allowed origins by default: `http://localhost:3000`, `http://127.0.0.1:3000`,
`http://localhost:5173`, `http://127.0.0.1:5173`. Methods: GET/OPTIONS; no credentials.
Override with a comma-separated list, e.g.
`$env:DENGUE_CORS_ORIGINS = "http://localhost:4000"`. A `*` wildcard is ignored.
