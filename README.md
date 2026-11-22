# Dengue Outlook

Ward-level dengue forecasts for five Bangladesh city corporations, replayed from historical data.
Built for the EDU AI Engineering Hackathon 2026 (Phase 1: "AI for Urban Dengue Outbreak").

> **This is a historical-replay prototype.** The model runs on bundled weekly records that end on
> 2025-12-29. It is not a live 2026 forecast, not an official warning system and not a clinical tool.
> Risk tiers and alerts are our own model-defined categories.

## The problem

The brief's premise is that weather changes show up in dengue cases a few weeks later, so waiting for hospital
numbers means acting late. It asks for a prototype that turns weather data into a 2-to-4-week early-warning
window for individual wards.

## What it does

For any of 60 wards and any historical Monday (the "issue week"), the app estimates the combined number of
dengue cases in weeks +2, +3 and +4. It also shows:

- a risk tier (Low, Medium, High, Critical) and an early-alert flag;
- the cases that were actually recorded later, for comparison;
- which input groups (rainfall, humidity, temperature, recent cases, ward traits, season) pushed the estimate up
  or down;
- all 60 wards for the same week, in five city charts and a searchable list;
- how the model did on past weeks (validation dashboard), in English or Bangla.

| City corporation | Wards |
| --- | --- |
| Dhaka North | 20 |
| Dhaka South | 20 |
| Chattogram | 10 |
| Gazipur | 5 |
| Narayanganj | 5 |

## Run it locally (Windows PowerShell)

Tested with Python 3.13.1 and Node.js 24 (npm 11) on Windows 10. Other versions were not tried. Installing
dependencies needs internet; running the app does not (no API keys, database or model download).

```powershell
git clone https://github.com/0gguy/innovXaaa_.git
cd innovXaaa_

# Python environment (backend and ML share one)
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r backend\requirements.txt -r ml\requirements.txt

# Terminal 1: API
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

When the log says the application has started, <http://127.0.0.1:8000/health> should return
`{"status":"ok","api_ready":true,"model_ready":true,"mode":"historical_replay"}`. Then, in a second PowerShell
window at the repository root:

```powershell
# Terminal 2: dashboard
cd frontend
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The default view is Dhaka North, DNCC Ward 12, issue week of 28 Jul 2025.

- API docs (Swagger) are at <http://127.0.0.1:8000/docs>.
- The backend only accepts browser requests from `localhost` / `127.0.0.1` on ports 3000 and 5173. Change this
  with `DENGUE_CORS_ORIGINS`.
- The frontend reads the API address from `VITE_API_BASE_URL` (default `http://127.0.0.1:8000`, see
  `frontend/.env.example`).
- All versions are pinned in [`backend/requirements.txt`](backend/requirements.txt),
  [`ml/requirements.txt`](ml/requirements.txt) and [`frontend/package-lock.json`](frontend/package-lock.json).

**How long setup takes.** One fresh-clone run on a Windows 10 machine, with empty pip and
npm caches, took about 103 s: clone 13 s, virtual environment 4 s, `pip install` 76 s, `npm install` 7 s, servers
ready in about 3 s. Ports 8000 and 5173 were busy, so that run used 8001 and 3000. It was a single run, and
timings depend on the machine and the network. Time values added here are approximate, they are not precise.

## Data

The dataset is `ml/data/dengue_dataset.csv`: 31,320 rows, 60 wards x 522 consecutive weeks (Mondays,
2016-01-04 to 2025-12-29). Columns are weekly temperature (average, max, min), rainfall, relative humidity,
dengue cases, and three fixed ward attributes (population density, water-logging risk, sanitation score). There
are no missing values or duplicate ward-weeks. The team got it from the organizer's Google Sheet linked in the
brief.

**The data probably is not real surveillance data.** We found signs that it is simulated:

- maximum and minimum temperature are identical in all 60 wards every week;
- weekly rainfall correlates at 0.991 or more between every pair of wards, even across cities;
- cases are close to zero from November to March.

## Features

`ml/features.py` builds the inputs, and both training and the API use it. For issue week *t* it uses only
information from week *t* and earlier:

- week-*t* weather: temperature (average, max, min), rainfall, humidity;
- rainfall, temperature and humidity lags of 1 to 4 weeks, and rainfall sums over the previous 2, 3 and 4 weeks;
- dengue case counts from weeks t-1 to t-4 and their 4-week mean (week *t*'s own cases are left out);
- month (sine and cosine), the three ward attributes, and city and ward identity.

That is 30 numeric and 2 categorical inputs, or 95 columns after one-hot encoding. Lags are exact calendar
shifts inside one ward, so a ward never sees another ward's history. A forecast needs 4 earlier weeks, so the
first valid issue week is 2016-02-01.

The target is the sum of cases in weeks t+2, t+3 and t+4 for the same ward: one combined number, not three
weekly forecasts.

## Model

We use an XGBoost regressor (500 trees, learning rate 0.03, max depth 5). It had the lowest validation MAE of
the four models we compared, and it supports exact TreeSHAP explanations.

| Model | Validation MAE |
| --- | --- |
| XGBoost | 2.1371 |
| Hist Gradient Boosting | 2.2004 |
| Extra Trees | 2.2503 |
| Random Forest | 2.5142 |
| Predict the mean | 10.2024 |

We also tried a log1p target, sample weights, adding week-*t* cases, and a randomized search (25 settings, 4
chronological folds). None beat the validation MAE of 2.1371. Details are in
[`ml/model_report.md`](ml/model_report.md).

**Split.** Weeks are split by time, never at random, with a 4-week gap before each cutoff so that no target
window reaches into the next period:

| Period | Issue weeks | Rows |
| --- | --- | --- |
| Train | 2016-02-01 to 2022-11-21 | 21,360 |
| Validation | 2022-12-26 to 2024-05-13 | 4,380 |
| Test | 2024-06-17 to 2025-12-01 | 4,620 |

The final model is refitted on train plus validation (25,740 rows). Validation was used to choose the model and
the alert threshold. The test period is the held-out evaluation. The saved files do not show how many times the
test set was evaluated.

**Risk tiers and alert.** On the predicted total *p* (clipped at 0): Low `p < 4.5`, Medium `4.5 <= p < 14.5`,
High `14.5 <= p < 30.5`, Critical `p >= 30.5`. The early alert is raised when `p > 25`, the value with the best
validation F1 for spotting observed totals above 30. These are provisional bands on absolute case counts, not
official thresholds.

## Results

On the 4,620 test ward-weeks (clipped predictions, as the API serves them), in cases per ward per 3-week window:

- MAE 2.776, RMSE 4.922, R-squared 0.813. Without clipping: MAE 2.786, RMSE 4.923.
- A seasonal baseline (ward x week-of-year average) has MAE 3.223, so the model is 13.9% lower. Repeating last
  week's cases three times gives 7.220.
- Exact risk tier right 81.3% of the time, and within one tier 99.2%.
- Validation MAE and RMSE were 2.137 and 4.373. They look better partly because validation also guided
  model and threshold choice.

The early alert on test (predicted above 25 versus observed above 30) has precision 0.357 and recall 0.866. It
fired 649 times: 232 were real, 417 were false alerts, and it missed 36 of the 268 ward-weeks above 30.

Known weaknesses: the model over-forecasts June (+4.3 cases on average) and September (+3.5), tends to
under-forecast the largest outbreaks, and error varies by city (MAE 2.59 for Narayanganj to 3.23 for Gazipur).
There are no prediction intervals.

## The website

- **Controls:** city, ward and issue week. The ward card shows the estimate, tier, alert and the weeks it covers.
  It also shows the observed later total and the difference. Observed values are never model inputs.
- **What shaped this estimate:** TreeSHAP contributions grouped into 8 input groups, in cases. They explain how
  the model reached its number; they do not show that rain or heat causes dengue.
- **Five city charts and a ward list:** one bar per ward, on a shared scale, coloured by tier, with a bell and a
  dashed line for the alert level. A click or Enter selects the ward. The list can be searched, filtered by city
  and sorted. The charts are not a map.
- **English / Bangla** switch without reloading. The Bangla text uses a font already on the device and has not
  been reviewed by a native speaker.
- **Validation dashboard:** weekly MAE or RMSE for the Test weeks (default) or the Validation weeks, with the
  pooled value as a dashed line, a table of the same numbers, and a separate yearly rolling-origin table. Pooled
  RMSE is computed over all rows, not by averaging weekly RMSEs. Validation results carry a note that they may be
  optimistic.
- **Methodology and limits** section at the bottom.

The validation dashboard reads a static file, `frontend/public/validation/weekly_errors.json`, built from the
saved predictions in `ml/eval/`. It does not run the model or use the backend. To check or rebuild it (standard
library only, no retraining):

```powershell
python ml/tools/export_validation_errors.py --check   # read-only: is the committed JSON up to date?
python ml/tools/export_validation_errors.py           # regenerate it
```

## API

Read-only `GET` endpoints. Every response has `"mode": "historical_replay"`. `issue_date` must be a Monday from
2016-02-01 to 2025-12-29, and observed outcomes exist only up to 2025-12-01.

- `/health`: API status and whether the model loaded.
- `/meta`: cities, wards, valid weeks, tier edges, alert threshold, model version.
- `/forecast/{ward_id}?issue_date=YYYY-MM-DD&include_drivers=true`: one ward.
- `/forecast?issue_date=YYYY-MM-DD&include_drivers=false`: all 60 wards.

Example: <http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28>. Errors use
`{"error": {"code", "message"}}` (400, 404, 422, 503 or 500); see [`backend/README.md`](backend/README.md).

## Tests

```powershell
cd backend; python -m pytest -q; cd ..                                                   # 36 tests
python -m pytest ml\tests\test_portable_api.py ml\tests\test_portable_equivalence.py -q  # 48 tests
python -m pytest ml/tools/tests -q -p no:cacheprovider                                   # 12 tests (exporter)
cd frontend; npm test; npm run typecheck; npm run lint; npm run build                    # 127 tests
```

All of these passed in our last runs. They are our own checks, not independent testing.

The supported runtime on Windows is `ml/predict_portable.py`, which loads the trained model from native XGBoost
files; the equivalence tests check that its predictions match the original pipeline. The original joblib loader
(`ml/predict.py`, tested by `ml/tests/test_package.py`) does not load on our Windows setup, so ignore that test
file there.

## Project layout

```text
backend/app/        FastAPI app (routes, model loading, errors)
ml/                 features.py, model files, predict_portable.py, model_config.json, model_report.md
ml/data/            dengue_dataset.csv
ml/eval/            saved evaluation predictions and metrics
ml/tools/           portable model export, validation-data exporter and its tests
frontend/src/       React + TypeScript app (components, API client, English/Bangla text)
frontend/public/    hero image, validation/weekly_errors.json
ARCHITECTURE.md     short technical report
```

## Team and Git history

Responsibilities as given by the team:

- **Masnoon Mohammad Tahseen Islam:** architecture and planning, FastAPI backend, React frontend, portable model
  integration, API tests, end-to-end checks, GitHub coordination.
- **Muhammad Asir Hossain Chowdhury:** dataset analysis, machine-learning workflow, XGBoost development and
  evaluation, model documentation and artifacts, portable model export.
- **S.M. Gazi Salauddin Chowdhury:**  weather-lag preprocessing and Random Forest baseline exploration,
README and operational response documentation, and presentation materials.
Individual commits are in the repository history (the team says the GitHub account `0gguy` is Masnoon's). The
experimental weather-lag and Random Forest work is on the separate branches
[`feat/weather-lag-pipeline`](https://github.com/0gguy/innovXaaa_/tree/feat/weather-lag-pipeline) and
[`feat/train-dengue-model`](https://github.com/0gguy/innovXaaa_/tree/feat/train-dengue-model). It is not merged
and is not part of the running app, which uses the XGBoost model described above. Documentation and
presentation work is not visible in Git.

## AI tools

AI assistance: Claude and Claude Code (Anthropic) were used for development support, including code
suggestions, debugging, testing and documentation. In detail:

- **Claude:** the FastAPI backend, React frontend, model integration, automated tests, browser checks and
  documentation drafts. 
- **Claude skills** (`frontend-design`, `impeccable`, `unslop`) gave design guidance and a lint check; they
  are instructions, not separate models. Playwright CLI was also used which is not an AI model.
- **ChatGPT image generation (OpenAI)** made the hero illustration, `frontend/public/images/dengue-hero-bg.webp`
  (prompt not recorded).

The team guided the project, reviewed the outputs and authorized the commits. The project was not written
entirely by hand, and commits carry no AI co-author trailers. **The running app uses no external AI APIs** and
makes no calls to weather or other hosted services. Compute and runtime details are in
[`ARCHITECTURE.md`](ARCHITECTURE.md).
## Limitations and future work

- Historical replay only. Nothing here predicts 2026 or a current outbreak.
- The data appear simulated, so accuracy on real surveillance data is unknown.
- Tiers and the alert threshold are our own choices on raw case counts. The alert gives many false alarms on
  the test period.
- No prediction intervals, and the driver bars are not causal.
- Validation numbers are optimistic because validation helped choose the model and threshold.
- Not implemented: real surveillance data, live weather input, uncertainty ranges, a map with ward boundaries,
  expert-defined thresholds, a bundled Bangla font and a native-speaker review of the Bangla text.

## More documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): data flow, validation, API and compute.
- [`backend/README.md`](backend/README.md) and [`frontend/README.md`](frontend/README.md): component setup and
  details.
- [`ml/model_report.md`](ml/model_report.md): data, features, split, model selection and metrics.
- [`ml/model_config.json`](ml/model_config.json) and [`ml/portable_manifest.json`](ml/portable_manifest.json):
  tiers, thresholds and artifact hashes.
- [`ml/compatibility_report.md`](ml/compatibility_report.md): original versus portable model equivalence.
- Older ML notes: [`ml/integration_guide.md`](ml/integration_guide.md) examples use the original loader,
  [`ml/README.md`](ml/README.md) targets the same loader and its 37-test suite, and
  [`ml/README_WINDOWS.md`](ml/README_WINDOWS.md) still says "not verified on Windows". None of these works on
  Windows as written; use `predict_portable.py`.
