# Integration guide — dengue 2–4-week ward forecast

For the application developer. Model version `dengue-xgb-2to4w-1.1.0`.

## 1. What the model does

For a ward and an **issue week** *t* (a Monday in the data), the model predicts the **total dengue cases in weeks t+2, t+3 and t+4** combined. It uses only information up to week *t*:

* week *t* weather,
* weather and case counts for weeks *t−1 … t−4*,
* the ward's static vulnerability attributes,
* the calendar month.

Week *t*'s own case count is **not** used.

The bundled organizer data runs from **2016-01-04 to 2025-12-29**. Valid issue weeks are **2016-02-01 … 2025-12-29**, because the first four weeks of each ward lack history. Actual outcomes exist for issue weeks up to **2025-12-01**.

> **Historical replay, not live warnings.** Today's date is after the data ends. Every forecast from the bundled data is a replay of a past week. Label it that way in the UI and the video ("Forecast as it would have been issued on <week>"). Never present it as a current November 2026 warning.

## 2. Install

Original testing: Python 3.13 on Linux x86_64. Windows 10 with Python 3.13.1 was verified later (22 Nov 2026) for the **portable** path only; other platforms and Python versions were not tested.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pytest -q tests/test_portable_api.py tests/test_portable_equivalence.py   # expect: 48 passed (Linux and Windows 10)
python -m pytest -q tests/test_package.py          # legacy original-loader suite: 37 passed on Linux; errors on Windows
```

> **Windows: use `predict_portable.py`.** The examples in this guide use the API shared by `predict.py` and `predict_portable.py`. On Windows import from `predict_portable`; the original `predict.py` loader does not load the combined joblib there.

`requirements.txt` pins `scikit-learn==1.6.1` and `xgboost==3.4.1`, the versions the model file was saved with. Don't change them: the original model is a pickled scikit-learn pipeline, and another scikit-learn version may refuse it or behave differently. No network access, external API or GPU is needed.

## 3. Files the backend needs

| File | Purpose |
| --- | --- |
| `predict_portable.py` | **Supported (Windows) inference API**: `forecast`, `forecast_all`, `forecast_from_records`, `get_forecaster` |
| `dengue_xgboost_model.ubj` (fallback `.json`) | Trained XGBoost booster in native format, used by `predict_portable.py` |
| `dengue_preprocessor.joblib` (fallback `.json`) | Small fitted scikit-learn one-hot preprocessor; contains no XGBoost object |
| `portable_manifest.json` | SHA-256 and sizes of the four portable artifacts, checked on every load |
| `predict.py` | Original inference API; `predict_portable.py` inherits its feature, tier and driver logic. **Legacy as an entry point on Windows** |
| `features.py` | Feature builder shared with training. Required by both loaders; don't copy its logic |
| `dengue_xgboost_model.joblib` | Legacy: original trained pipeline (one-hot encoder + XGBoost), 1.3 MB. Not loadable on the project's Windows setup |
| `model_config.json` | Feature order, tiers, alert rule, ward→city map, valid weeks, training ranges, metrics, versions |
| `data/dengue_dataset.csv` | Organizer CSV, the history the forecasts are built from. Set `DENGUE_DATA_PATH` to use another location |
| `eval/*.csv`, `eval/metrics_summary.json` | Precomputed evaluation results for the dashboard (optional) |

Keep these files in one folder. The loaders find the others relative to themselves.

## 4. Load once, then call

```python
from predict_portable import forecast, forecast_all, get_forecaster, ForecastError   # legacy: `from predict import ...` (same API, original loader)

fc = get_forecaster()      # loads model + config + CSV once (~1.4 s on the Linux test machine); later calls reuse it
fc.wards()                 # the 60 valid ward IDs
fc.valid_issue_weeks()     # {'first': '2016-02-01', 'last': '2025-12-29', ...}
```

Call `get_forecaster()` once at server start-up, for example in a FastAPI startup hook or at Flask app creation. The module-level `forecast()` and `forecast_all()` use the same cached instance. Inference never retrains anything.

### One ward, one week

```python
r = forecast("DNCC_Ward_12", "2025-06-16")
r["predicted_cases_3wk"], r["risk_tier"], r["early_alert"]   # 53.66, 'Critical', True
```

Options: `include_drivers=True` (default for one ward) and `include_actual=True` (default).

### All wards for one week (batched)

```python
rows = forecast_all("2025-06-16")            # list of 60 dicts, sorted by ward_id
rows = forecast_all("2025-06-16", include_drivers=True)   # adds drivers (~50 ms instead of ~17 ms)
```

### From newer observations (if you ever get them)

```python
import pandas as pd
records = pd.DataFrame(...)    # same 12 columns as the organizer CSV
r = fc.forecast_from_records(records, "DSCC_Ward_06", "2026-01-05")
```

`records` must hold the issue week and the four previous weeks for that ward. The issue week's `dengue_cases` may be NaN, because it isn't used. No actual outcome is attached. Use this only with genuinely observed data. Never fabricate inputs to make it "live".

### Command line

```bash
python predict_portable.py 2025-06-16 DNCC_Ward_12      # one ward, JSON to stdout
python predict_portable.py 2025-06-16 --all             # all 60 wards
python examples/quickstart.py                           # minimal end-to-end example
# legacy original loader (not for Windows): python predict.py ...  /  python examples/example_inference.py
```

## 5. Output schema (one forecast)

```json
{
  "ward_id": "DNCC_Ward_12",
  "city": "Dhaka North",
  "issue_week": "2025-06-16",
  "horizon_weeks": [2, 3, 4],
  "forecast_weeks": ["2025-06-30", "2025-07-07", "2025-07-14"],
  "predicted_cases_3wk": 53.66,
  "risk_tier": "Critical",
  "early_alert": true,
  "raw_model_output": 53.66,
  "model_version": "dengue-xgb-2to4w-1.1.0",
  "data_source": "bundled_historical_data",
  "warnings": [],
  "drivers": {
    "baseline": 8.005,
    "groups": [{"group": "Rainfall (this week)", "contribution": 15.39}, "... 8 groups, largest |contribution| first"],
    "note": "Additive model attributions ... not causes of dengue."
  },
  "actual": {
    "available": true,
    "actual_cases_3wk": 33,
    "actual_risk_tier": "Critical",
    "note": "Observed outcome ... not an input to the forecast."
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `predicted_cases_3wk` | float ≥ 0 | Predicted total cases over the three forecast weeks (raw output clipped at 0, 4 dp). Round for display only |
| `risk_tier` | `Low` \| `Medium` \| `High` \| `Critical` | Computed from the unrounded `predicted_cases_3wk` (section 6) |
| `early_alert` | bool | `predicted_cases_3wk > 25`; validation-selected outbreak alert (section 6) |
| `raw_model_output` | float | Unclipped model output; can be slightly negative |
| `forecast_weeks` | list of 3 dates | Mondays of weeks t+2, t+3, t+4 |
| `drivers` | object or `null` | Present when requested. `baseline + sum(groups.contribution) = raw_model_output` (±0.02 rounding). `null` if the check fails |
| `actual` | object | Present when `include_actual=True`. `available=false` and `null` values when weeks t+2..t+4 are beyond the data. Show it clearly apart from the prediction |
| `warnings` | list of str | Inputs outside the training range (prediction still returned) |

Driver groups:

* Rainfall (this week)
* Rainfall (previous 1–4 weeks)
* Humidity
* Temperature
* Recent dengue cases
* Ward vulnerability
* Season (month)
* Ward / city identity

Describe them in the UI as "what pushed this forecast up or down", not as causes.

## 6. Risk tiers and alert

Tiers apply to the predicted 3-week total *p*. The lower bound of each tier is inclusive.

| Tier | Rule on *p* | Integer equivalent |
| --- | --- | --- |
| Low | p < 4.5 | 0–4 |
| Medium | 4.5 ≤ p < 14.5 | 5–14 |
| High | 14.5 ≤ p < 30.5 | 15–30 |
| Critical | p ≥ 30.5 | > 30 |

`early_alert` is `p > 25`. Suggested UI rule: **highlight a ward when `risk_tier == "Critical"` or `early_alert` is true**. The model under-predicts the largest outbreaks. Critical alone caught 60% of actual > 30 weeks in the test period; Critical or `early_alert` caught 87%, at the cost of more false alarms (see `model_report.md`).

These tiers are **provisional, model-defined bands on absolute case counts**. They are not clinical or official public-health thresholds.

## 7. Feature names and order

The backend never builds features: the loaders call `features.build_features`. For reference, the model expects these 32 columns in this order (also in `model_config.json → feature_columns`):

```
population_density_sqkm, water_logging_risk_index, sanitation_score,
avg_temp_c, max_temp_c, min_temp_c, rainfall_mm, relative_humidity_pct,
rainfall_lag_1w, rainfall_lag_2w, rainfall_lag_3w, rainfall_lag_4w,
rain_roll2w_sum, rain_roll3w_sum, rain_roll4w_sum,
temp_lag_1w, temp_lag_2w, temp_lag_3w, temp_lag_4w,
humidity_lag_1w, humidity_lag_2w, humidity_lag_3w, humidity_lag_4w,
dengue_lag_1w, dengue_lag_2w, dengue_lag_3w, dengue_lag_4w, dengue_roll4w_mean,
month_sin, month_cos, city, ward_id
```

How each family is built:

* `*_lag_kw` is the same ward's value exactly *k* weeks earlier. The temperature lags use `avg_temp_c` and the humidity lags use `relative_humidity_pct`.
* `rain_rollkw_sum` is the sum of rainfall lags 1..k, so week *t* is excluded.
* `dengue_roll4w_mean` is the mean of case lags 1..4.
* `month_sin` and `month_cos` are sin/cos(2π·month/12).

## 8. Errors

Every invalid request raises `ForecastError`. Use `e.code` for the HTTP status and `e.to_dict()` for the response body.

| `code` | When | Suggested HTTP |
| --- | --- | --- |
| `unknown_ward` | ward_id not one of the 60 IDs (case-sensitive) | 404 |
| `invalid_date` | Not `YYYY-MM-DD`, not a Monday, has a time of day, or wrong type | 400 |
| `issue_week_out_of_range` | No record for that week in the data (e.g. any 2026 date) | 404 |
| `insufficient_history` | Fewer than 4 previous consecutive weeks (2016-01-04…2016-01-25, or gaps in supplied records) | 422 |
| `invalid_input` | Missing columns, non-finite values, or ward/city mismatch in supplied records | 422 |

Example FastAPI wrapper:

```python
from fastapi import FastAPI, HTTPException
from predict_portable import get_forecaster, ForecastError   # legacy: from predict import ...

app = FastAPI()
fc = get_forecaster()
STATUS = {"unknown_ward": 404, "issue_week_out_of_range": 404, "invalid_date": 400}

@app.get("/forecast/{ward_id}/{issue_week}")
def one(ward_id: str, issue_week: str):
    try:
        return fc.forecast(ward_id, issue_week)
    except ForecastError as e:
        raise HTTPException(STATUS.get(e.code, 422), e.to_dict())

@app.get("/forecast/{issue_week}")
def all_wards(issue_week: str):
    try:
        return fc.forecast_all(issue_week)
    except ForecastError as e:
        raise HTTPException(STATUS.get(e.code, 422), e.to_dict())
```

FastAPI isn't in `requirements.txt`; add it if you use it.

## 9. Cost and performance

Measured on a Linux machine in a clean virtual environment, on 2 vCPUs (not re-measured on Windows):

* Startup: 1.35 s (load the model and build the feature table for 31,320 rows once).
* One ward: 7 ms, or 11 ms with drivers.
* All 60 wards: 17 ms, or 52 ms with drivers.
* Peak memory: about 210 MB.
* No API calls and no LLM use.

Cache `forecast_all` results per week if the UI requests the same week repeatedly.

## 10. Known limitations

* **Historical replay only.** The data ends on 2025-12-29, so there are no live 2026 forecasts.
* **Data provenance is uncertain** and looks simulated. Max and min temperature are identical across all wards each week, and rainfall correlates ≥ 0.99 between all wards. Differences between wards come mostly from the static attributes.
* **Absolute counts, not incidence.** No population counts exist, so tiers favour larger or denser wards.
* **Seasonal errors.** In the 2024–2025 test period, the model over-forecasts in June (+4.3 cases on average) and September (+3.5). It under-forecasts the largest outbreaks.
* **Error rates.** In the test period, the `early_alert` rule raised 417 false alarms against 232 correct alerts and missed 36 outbreak weeks.
* **Accuracy varies by city and year.** Test MAE ranges from 2.59 (Narayanganj) to 3.23 (Gazipur). Rolling-origin MAE ranges from 1.89 to 2.83 across years.
* **Not a public-health assessment.** Outputs are model predictions on organizer data and need review by public-health staff before any decision.
