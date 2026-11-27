# Dengue Outlook

Ward-level dengue forecasts and planning scenarios for five Bangladesh city corporations, replayed from
historical data. Built by undergraduate CSE students for the EDU AI Engineering Hackathon 2026 (Phase 1: "AI for
Urban Dengue Outbreak"), then extended in Phase 2 with weekly forecasts and planning tools.

> **This is a historical-replay prototype.** The model runs on bundled weekly records that end on
> 2025-12-29. It is not a live 2026 forecast, not an official warning system and not a clinical tool.
> Risk tiers and alerts are our own model-defined categories. Stock levels, crews, hospital capacity and
> intervention effects in the planning sections are scenario inputs we chose, not real inventories or
> measured effects, and no brief is ever sent to anyone.

## Hosted demo

- **Dashboard:** <https://dengue-outlook-dashboard.onrender.com>
- **API (health check):** <https://dengue-outlook-api.onrender.com/health>
- **API docs (Swagger):** <https://dengue-outlook-api.onrender.com/docs>

These were set up for Phase 1. We have not checked whether the hosted dashboard and API include the Phase 2
planning sections and endpoints, so use the local setup below to see the full prototype.

The API runs on Render's free tier and sleeps after about 15 minutes idle. If the dashboard shows a connection
error or loads slowly at first, open the health link above, wait about a minute, then reload the dashboard.

## The problem

The hackathon brief's premise is that weather changes show up in dengue cases a few weeks later, so waiting for
hospital numbers means acting late. It asks for a prototype that turns weather data into a 2-to-4-week
early-warning window for individual wards.

A forecast on its own does not say what to do with it, so in Phase 2 we used the same forecast to try out simple
planning questions: how far a limited stock of saline and test kits would go, where hospital beds might run
short, what spraying crews might change under assumed effects, and what a draft brief for a city or ward team
could look like.

## Data and data analysis

The dataset is `ml/data/dengue_dataset.csv`: 31,320 rows, 60 wards x 522 consecutive weeks (Mondays,
2016-01-04 to 2025-12-29). Columns are weekly temperature (average, max, min), rainfall, relative humidity,
dengue cases, and three fixed ward attributes (population density, water-logging risk, sanitation score). There
are no missing values or duplicate ward-weeks. The team got it from the organizer's Google Sheet linked in the
brief.

| City corporation | Wards |
| --- | --- |
| Dhaka North | 20 |
| Dhaka South | 20 |
| Chattogram | 10 |
| Gazipur | 5 |
| Narayanganj | 5 |

**The data probably is not real surveillance data.** We found signs that it is simulated:

- maximum and minimum temperature are identical in all 60 wards every week;
- weekly rainfall correlates at 0.991 or more between every pair of wards, even across cities;
- cases are close to zero from November to March.

Because of this, everything below describes how the model behaves on this dataset. How it would do on real
surveillance data is unknown.

The planning conversions also come from the data. According to the notes in
`backend/app/planning/parameters.py`, the onsite version of the dataset (not included in this repository) had
saline, diagnostic-kit and hospital-bed columns, and every row matched `round_half_up(k x dengue_cases)` for a
narrow range of `k`. We use one value inside each range (saline 2.38485,
kits 1.16422, beds 0.29844 per case; see `backend/app/planning/parameters.py`). These are dataset-derived planning
conventions, not clinical guidelines.

## Machine learning approach

### Features

`ml/features.py` builds the inputs, and both training and the API use it. For issue week *t* it uses only
information from week *t* and earlier:

- week-*t* weather: temperature (average, max, min), rainfall, humidity;
- rainfall, temperature and humidity lags of 1 to 4 weeks, and rainfall sums over the previous 2, 3 and 4 weeks;
- dengue case counts from weeks t-1 to t-4 and their 4-week mean (week *t*'s own cases are left out);
- month (sine and cosine), the three ward attributes, and city and ward identity.

That is 30 numeric and 2 categorical inputs, or 95 columns after one-hot encoding. Lags are exact calendar
shifts inside one ward, so a ward never sees another ward's history. A forecast needs 4 earlier weeks, so the
first valid issue week is 2016-02-01.

### What the main model predicts

The target is the sum of cases in weeks t+2, t+3 and t+4 for the same ward: one combined number per ward and
issue week. Forecasting this window is the point of the project: it gives a two-to-four-week lead over the cases
themselves, which is the time a city team would need to prepare.

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

### Results

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

### Weekly predictions (Phase 2)

The main model gives one 3-week total, but planning needs to know which week is likely to be busiest. A
**weekly companion** in `ml/phase2/` handles that. It has three more XGBoost models, one each for weeks t+2,
t+3 and t+4, trained on the same 95 input columns. Their outputs are clipped at 0 and rescaled so the three weeks
add up exactly to the main model's total. That means the weekly split never changes the 3-week forecast, the
risk tier or the alert.

If the companion cannot be loaded (a model file's hash does not match, or its features differ from the main
model's), or it fails for one request, the backend falls back to an **equal split** (total / 3 per week). Every
response says which source was used. We have no saved evaluation of the weekly companion on its own, so we
make no accuracy claim for the weekly values.

### From forecast to planning

All four planning endpoints start from the same forecast run for all 60 wards in the chosen issue week, with the
weekly split attached:

- saline and test-kit demand come from the 3-week total;
- bed planning demand comes from the busiest of the three weeks;
- spraying-crew demand comes from the risk tier and population density;
- the intervention scenarios reduce the weekly forecast by assumed percentages.

## Main features

The dashboard has six sections, all using the same city, ward and issue-week selection, with an
English / Bangla switch.

1. **Overview:** the ward estimate with its tier, alert and the weeks it covers, the cases that were actually
   recorded later (for comparison only), TreeSHAP "what shaped this estimate" groups, five city bar charts, a
   searchable ward list, a validation dashboard built from saved evaluation results, and a methodology section.
2. **Weekly Outlook:** the selected ward's total split into weeks +2, +3 and +4, with a note on whether the split
   came from the weekly companion or the equal-split fallback.
3. **Resource Planning:** shares a hypothetical stock of saline and test kits (a percentage of forecast demand,
   per city) and a hypothetical crew budget across wards. It uses a minimum-coverage floor first, then risk
   priority. It shows ward shortfalls.
4. **Hospital Planning:** compares weekly bed planning demand with a hypothetical capacity and moves overflow
   between wards of the same city. It shows where beds would still be short. There are no real hospitals,
   locations or travel times.
5. **Intervention Explorer:** applies assumed low, base and high spraying effects (15%, 35% and 55% maximum
   reduction) to the forecast and compares them side by side. There is also an optional alternative crew
   assignment for comparison. These are assumed effects, not measured or causal ones.
6. **Dispatch Brief:** generates a draft text brief for a city or ward from the same scenario. You can preview it
   and download it as text or printable HTML. Every brief is marked DRAFT / NOT SENT and needs human checking. The
   app never sends anything.

In the planning sections, changing a value only edits a draft; the request is made when you press Apply (or
Generate for the brief), and the result shows the values the backend actually used.

## Technology stack

- **Machine learning:** Python, pandas, NumPy, scikit-learn (preprocessing), XGBoost, TreeSHAP via XGBoost.
  The model is served from native XGBoost files (`ml/predict_portable.py`), with SHA-256 checks.
- **Backend:** FastAPI and uvicorn. The planning modules in `backend/app/planning/` use only the Python standard
  library (exact `Decimal` and `Fraction` arithmetic).
- **Frontend:** React 19, TypeScript, Vite; tests with Vitest and Testing Library.
- **No external services at runtime:** no database, hosted AI, weather API or map service.

All versions are pinned in [`backend/requirements.txt`](backend/requirements.txt),
[`ml/requirements.txt`](ml/requirements.txt) and [`frontend/package-lock.json`](frontend/package-lock.json).

## Repository structure

```text
backend/app/           FastAPI app: routes (main.py), model loading (model_service.py), errors, config
backend/app/planning/  demand conversion, allocation, hospital routing, intervention scenarios, dispatch briefs
backend/scripts/       generate_exports.py (rebuilds or checks the sample briefs in exports/)
backend/tests/         backend and planning tests
ml/                    features.py, model files, predict_portable.py, model_config.json, model_report.md
ml/phase2/             weekly companion (weekly_model.py) and its model files with SHA256SUMS
ml/data/               dengue_dataset.csv
ml/eval/               saved evaluation predictions and metrics
ml/tools/              portable model export, validation-data exporter and its tests
frontend/src/          React + TypeScript app: components, API client and validators, scenario state,
                       English/Bangla text
frontend/public/       hero image, validation/weekly_errors.json
exports/               sample draft briefs produced by the dispatch endpoint
ARCHITECTURE.md        how the parts fit together
```

## Run it locally (Windows PowerShell)

Tested with Python 3.13.1 and Node.js 24 (npm 11) on Windows. Other versions were not tried. Installing
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

Open <http://127.0.0.1:5173>. The default view is Dhaka North, DNCC Ward 12, issue week of 28 Jul 2025. Use the
section buttons under the header to switch between the six sections.

- API docs (Swagger) are at <http://127.0.0.1:8000/docs>.
- The backend only accepts browser requests from `localhost` / `127.0.0.1` on ports 3000 and 5173. Change this
  with `DENGUE_CORS_ORIGINS`.
- The frontend reads the API address from `VITE_API_BASE_URL` (default `http://127.0.0.1:8000`, see
  `frontend/.env.example`).
- Brief downloads link straight to the backend, so they only work while the backend is running.

**How long setup takes.** One fresh-clone run on a Windows 10 machine, with empty pip and
npm caches, took about 103 s: clone 13 s, virtual environment 4 s, `pip install` 76 s, `npm install` 7 s, servers
ready in about 3 s. Ports 8000 and 5173 were busy, so that run used 8001 and 3000. It was a single run before
Phase 2, and timings depend on the machine and the network. Time values here are approximate.

### Validation data file

The validation dashboard in the Overview reads a static file, `frontend/public/validation/weekly_errors.json`,
built from the saved predictions in `ml/eval/`. It does not run the model or use the backend. To check or
rebuild it (standard library only, no retraining):

```powershell
python ml/tools/export_validation_errors.py --check   # read-only: is the committed JSON up to date?
python ml/tools/export_validation_errors.py           # regenerate it
```

## API

Read-only `GET` endpoints. Every response except `/health` has `"mode": "historical_replay"` and a `notice`.
`issue_date` must be a Monday from 2016-02-01 to 2025-12-29, and observed outcomes exist only up to 2025-12-01.
The planning endpoints use the last valid week when `issue_date` is left out.

- `/health`: API status and whether the model loaded.
- `/meta`: cities, wards, valid weeks, tier edges, alert threshold, model versions and weekly companion status.
- `/forecast/{ward_id}?issue_date=YYYY-MM-DD`: one ward (`include_drivers`, `include_weekly`).
- `/forecast?issue_date=YYYY-MM-DD`: all 60 wards.
- `/allocation`: saline, test-kit and crew plan (`stock_pct`, `stock_pct_saline`, `stock_pct_kits`,
  `min_coverage_pct`, `total_crews`).
- `/hospital-routing`: bed planning against hypothetical capacity (`capacity_pct`).
- `/intervention-simulation`: low/base/high assumed-effect scenarios (`total_crews`, `min_coverage_pct`,
  `include_roi_alternative`).
- `/dispatch-brief`: draft city or ward brief (`scope`, `city` or `ward_id`, `audience`, `variant`, `format` of
  `json`, `text` or `html`, the scenario values above, `intervention_scenario`, `download`).

Example: <http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28>. Errors use
`{"error": {"code", "message"}}` (400, 404, 422, 503 or 500). Ranges and behaviour are in
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`backend/README.md`](backend/README.md) (the latter covers the Phase 1
endpoints). Sample briefs are in [`exports/`](exports/README.md).

## Testing

```powershell
cd backend; python -m pytest -q; cd ..                                     # backend + planning: 428 tests
python -m pytest ml\tests\test_portable_api.py ml\tests\test_portable_equivalence.py ml\tests\test_weekly_companion.py -q   # 76 tests
python -m pytest ml/tools/tests -q -p no:cacheprovider                     # 12 tests (exporter)
python backend/scripts/generate_exports.py --check                         # sample briefs still match
cd frontend; npm test; npm run typecheck; npm run lint; npm run build      # 445 tests in 14 files
```

All of these passed in our last runs. They are our own checks, not independent testing. `npm test` runs Vitest
with two workers (`--maxWorkers=2`); with more parallel workers we saw occasional timeouts on our machine.

The supported runtime on Windows is `ml/predict_portable.py`, which loads the trained model from native XGBoost
files; the equivalence tests check that its predictions match the original pipeline. The original joblib loader
(`ml/predict.py`, tested by `ml/tests/test_package.py`) does not load on our Windows setup, so ignore that test
file there.

## Current limitations

- Historical replay only. Nothing here predicts 2026 or a current outbreak.
- The data appear simulated, so accuracy on real surveillance data is unknown.
- Tiers and the alert threshold are our own choices on raw case counts. The alert gives many false alarms on
  the test period.
- No prediction intervals, and the driver bars are not causal.
- Validation numbers are optimistic because validation helped choose the model and threshold.
- The weekly companion has no separate saved evaluation in this repository.
- Planning inputs are hypothetical. Stock percentages are relative to forecast demand, not real inventory. The
  hospital capacity baseline was calibrated on 2016-2023 data and split equally across wards. Crew budgets and
  the low/base/high intervention effects are assumptions, not learned from data.
- Hospital Planning has no hospital names, locations, distances or travel times, and never moves beds between
  cities.
- Dispatch briefs are drafts only. The brief text comes from the backend in English, even on the Bangla page.
- Each planning section keeps its own scenario values; values applied in one section do not carry over to
  another.
- Not tested with screen readers or on real touch devices. The Bangla text has not been reviewed by a native
  speaker, and no Bangla font is bundled.
- Not implemented: real surveillance data, live weather input, uncertainty ranges, a map with ward boundaries,
  expert-defined thresholds, and any real sending of briefs.

## Team and Git history

Responsibilities as given by the team:

- **Masnoon Mohammad Tahseen Islam:** architecture and planning, FastAPI backend, React frontend, portable model
  integration, API tests, end-to-end checks, GitHub coordination.
- **Muhammad Asir Hossain Chowdhury:** dataset analysis, machine-learning workflow, XGBoost development and
  evaluation, model documentation and artifacts, portable model export.
- **S.M. Gazi Salauddin Chowdhury:** weather-lag preprocessing and Random Forest baseline exploration,
  README and operational response documentation, and presentation materials.

Individual commits are in the repository history (the team says the GitHub account `0gguy` is Masnoon's). The
weekly companion models and the intervention scenario parameters come from Asir's reviewed handoff package
(see `ml/phase2/weekly_model.py` and `backend/app/planning/parameters.py`). The experimental weather-lag and
Random Forest work is on the separate branches
[`feat/weather-lag-pipeline`](https://github.com/0gguy/innovXaaa_/tree/feat/weather-lag-pipeline) and
[`feat/train-dengue-model`](https://github.com/0gguy/innovXaaa_/tree/feat/train-dengue-model). It is not merged
and is not part of the running app, which uses the XGBoost model described above. Documentation and
presentation work is not visible in Git.

## AI tools

We used Claude and Claude Code (Anthropic) during development, for the FastAPI backend, the React frontend, model
integration, automated tests, browser checks and documentation drafts. The Claude skills `frontend-design`,
`impeccable` and `unslop` gave design guidance and a lint check (they are instructions, not separate models), and
Playwright CLI was used for browser checks. The hero illustration,
`frontend/public/images/dengue-hero-bg.webp`, was made with ChatGPT image generation (OpenAI); the prompt was not
recorded.

The team guided the project, reviewed the outputs and authorized the commits. The project was not written
entirely by hand, and commits carry no AI co-author trailers. The running app itself calls no AI APIs, weather
services or other hosted services.

## More documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): data flow, model serving, weekly split, planning modules and API.
- [`backend/README.md`](backend/README.md) and [`frontend/README.md`](frontend/README.md): component setup and
  details. Both were written before Phase 2, so their test counts and endpoint lists are out of date.
- [`exports/README.md`](exports/README.md): sample draft briefs and how they are regenerated.
- [`ml/model_report.md`](ml/model_report.md): data, features, split, model selection and metrics.
- [`ml/model_config.json`](ml/model_config.json) and [`ml/portable_manifest.json`](ml/portable_manifest.json):
  tiers, thresholds and artifact hashes.
- [`ml/compatibility_report.md`](ml/compatibility_report.md): original versus portable model equivalence.
- Older ML notes: [`ml/integration_guide.md`](ml/integration_guide.md) examples use the original loader,
  [`ml/README.md`](ml/README.md) targets the same loader and its 37-test suite, and
  [`ml/README_WINDOWS.md`](ml/README_WINDOWS.md) still says "not verified on Windows". None of these works on
  Windows as written; use `predict_portable.py`.
