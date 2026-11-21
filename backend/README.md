# Dengue Ward Forecast API

FastAPI backend serving **historical-replay** dengue forecasts for 60 Bangladesh wards
(five city corporations) from the portable XGBoost model in `../ml/`.

> **Historical replay only.** Forecasts are model estimates computed on bundled data
> that ends 2025-12-29. This is a hackathon prototype, **not a live public-health alert
> system**, and its outputs are **not verified real-world warnings**. Every forecast
> response carries `"mode": "historical_replay"` and a `notice` saying so.

The model predicts the combined case count for weeks t+2, t+3 and t+4. The backend uses
`ml/predict_portable.py` (`PortableForecaster`); it never uses the original
Windows-incompatible joblib loader in `ml/predict.py`. Nothing is retrained.

## Windows 10 setup (PowerShell)

The backend needs the backend **and** ML packages in one environment. Keep it outside the
repository so it is never committed.

```powershell
cd D:\denguehackathon

python -m venv $env:USERPROFILE\venvs\dengue-app          # Python 3.13
& "$env:USERPROFILE\venvs\dengue-app\Scripts\Activate.ps1"
# If scripts are blocked:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

python -m pip install -r backend\requirements.txt -r ml\requirements.txt
```

Verified with Python 3.13.1, FastAPI 0.165.0, uvicorn 0.54.0, numpy 2.5.5, pandas 3.1.1,
scikit-learn 1.6.1, xgboost 3.4.1.

## Run the server (local demo)

```powershell
cd D:\denguehackathon\backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

The model loads once at startup (takes a few seconds; artifact SHA-256 hashes are checked).
Open <http://127.0.0.1:8000/docs> for interactive docs. Stop with Ctrl+C.
No `--reload` is used.

## Run the tests

```powershell
cd D:\denguehackathon\backend
python -m pytest -q                      # 36 tests: foundation + model integration
cd ..; python -m pytest ml\tests\test_portable_api.py ml\tests\test_portable_equivalence.py -q   # 48 portable ML tests
```

The integration tests load the real portable model and compare API output to direct
`predict_portable` inference. They need no network.
(`ml/tests/test_package.py` exercises the original joblib loader, which fails on Windows
by design; it is not part of the backend or portable test set.)

## Endpoints (all read-only GET)

### `GET /health`
```json
{"status": "ok", "api_ready": true, "model_ready": true, "mode": "historical_replay"}
```
`api_ready`: the process is up. `model_ready`: the portable model actually loaded at
startup (`false` if loading failed; the API then answers 503 on model endpoints).

### `GET /meta`
Cities (20/20/10/5/5 wards), all 60 `{ward_id, city}` entries, `valid_issue_weeks`
(`first` 2016-02-01, `last` 2025-12-29, Mondays only), risk tier edges, alert threshold,
`model_version`, plus `mode` and `notice`.

### `GET /forecast/{ward_id}?issue_date=YYYY-MM-DD&include_drivers=true`
```
GET /forecast/DNCC_Ward_12?issue_date=2025-06-16
```
Returns `{"mode", "notice", "forecast": {...}}`. `forecast` is the ML result object
unchanged: `predicted_cases_3wk`, `risk_tier`, `early_alert`, `forecast_weeks`, `drivers`,
`actual` (observed outcome for replay comparison only), `warnings`, `model_version`, etc.

### `GET /forecast?issue_date=YYYY-MM-DD&include_drivers=false`
Returns `{"mode", "notice", "issue_date", "count": 60, "forecasts": [ ... ]}`.

Rules preserved from the ML package: `early_alert` is `predicted_cases_3wk > 25`;
tiers are Low < 4.5, Medium 4.5–<14.5, High 14.5–<30.5, Critical >= 30.5 (provisional,
model-defined; not clinical or official thresholds).

## Errors

All errors use `{"error": {"code", "message", "details"?}}`; tracebacks and file paths
are never returned.

| HTTP | code | When |
| --- | --- | --- |
| 400 | `invalid_date` | not `YYYY-MM-DD`, not a Monday, has a time |
| 404 | `unknown_ward` | ward id not one of the 60 |
| 404 | `issue_week_out_of_range` | no data for that week (e.g. any 2026 date) |
| 422 | `insufficient_history` / `invalid_input` | not enough prior weeks / bad inputs |
| 422 | `validation_error` | e.g. missing `issue_date` |
| 503 | `model_unavailable` | the model failed to load; no prediction is invented |
| 500 | `internal_error` | unexpected failure (details only in the server log) |

## CORS

Allowed origins: `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`,
`http://127.0.0.1:5173` (GET/OPTIONS, no credentials). Override with
`$env:DENGUE_CORS_ORIGINS = "http://localhost:4000"` (comma-separated; `*` is ignored).

## Offline operation and runtime controls

- Fully offline: no database, Redis, hosted AI, weather service or other network calls.
- One worker, bound to 127.0.0.1, no auto-reload, no background jobs, no caching layer.
- The forecaster is created once per process; requests never reload the model.
- `OMP_NUM_THREADS` defaults to 1 and XGBoost `n_jobs` is set to 1 (set `OMP_NUM_THREADS`
  yourself before starting to override).
- `forecast_from_records` (caller-supplied data) is deliberately **not** exposed over HTTP.

## Not implemented

Frontend, authentication, live data, notifications, database.
