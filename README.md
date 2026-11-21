# Dengue Outlook

**Ward-level dengue forecasting for Bangladesh's city corporations, replayed from historical data.**
Built for the EDU AI Engineering Hackathon 2026, Phase 1 challenge "AI for Urban Dengue Outbreak".

> **Historical replay prototype.** All forecasts are produced by a trained model replaying bundled
> weekly records that end on 2025-12-29. This is **not** a live 2026 outbreak forecast, **not** an
> official public-health warning system, and **not** a clinical decision tool. Risk tiers and alerts
> are provisional, model-defined categories.

## 1. Project overview

Dengue outbreaks in Dhaka and Chattogram arrive after a lag: rain fills drains and containers, mosquitoes
breed, and cases appear weeks later. City corporations that react to hospital admissions act late. The
hackathon brief asks for a prototype that turns weather data into a **2-to-4-week early-warning window** for
individual wards.

Dengue Outlook is that prototype. For any of **60 wards in 5 city corporations** and any historical Monday
issue week it estimates the **combined number of dengue cases in weeks +2, +3 and +4**, assigns one of four
risk tiers, flags an early alert, and shows which input groups (rainfall, humidity, temperature, recent
cases, ward vulnerability, season) pushed the estimate up or down. The intended audience is public-health
officers; because the data are historical, the application demonstrates the method, not live decisions.

| City corporation | Wards |
| --- | --- |
| Dhaka North | 20 |
| Dhaka South | 20 |
| Chattogram | 10 |
| Gazipur | 5 |
| Narayanganj | 5 |

## 2. Quick start (Windows PowerShell)

**Verified with Python 3.13.1 and Node.js 24 (npm 11) on Windows 10.** Other versions were not tested.
The application needs no internet access, API keys, database or model download once dependencies are
installed; installing the dependencies itself needs internet access for any package that is not cached. A
fresh-clone check of these commands is recorded below.

```powershell
# 1. Get the code
git clone https://github.com/0gguy/innovXaaa_.git
cd innovXaaa_

# 2. Python environment (ML + backend share one environment)
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r backend\requirements.txt -r ml\requirements.txt

# 3. Start the API (terminal 1, from the repository root)
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Wait until the log says the application has started, then check <http://127.0.0.1:8000/health>. It should
return `{"status":"ok","api_ready":true,"model_ready":true,"mode":"historical_replay"}`.

Open a **second** PowerShell window in the repository root:

```powershell
# 4. Start the dashboard (terminal 2)
cd frontend
npm install
npm run dev
```

Open **<http://127.0.0.1:5173>**. The default view is Dhaka North, DNCC Ward 12, issue week of 28 Jul 2025.

| Item | Value |
| --- | --- |
| Backend | `http://127.0.0.1:8000` (Swagger UI at `/docs`) |
| Frontend | `http://127.0.0.1:5173` |
| CORS | The backend allows only `localhost` / `127.0.0.1` on ports 3000 and 5173 (GET and OPTIONS, no credentials). Override with the `DENGUE_CORS_ORIGINS` environment variable; `*` is ignored. |
| API URL for the frontend | `VITE_API_BASE_URL`, default `http://127.0.0.1:8000` (see `frontend/.env.example`) |

Dependency files: [`backend/requirements.txt`](backend/requirements.txt),
[`ml/requirements.txt`](ml/requirements.txt) and [`frontend/package.json`](frontend/package.json) with
[`frontend/package-lock.json`](frontend/package-lock.json). All versions are pinned.

**Fresh-clone verification (22 November 2026).** On Windows 10 with Python 3.13.1 and Node.js 24.11.1, the
commands above were applied to a new clone of the published GitHub commit `922f1b8` in a temporary folder, with a new
virtual environment and empty pip and npm caches (the venv's `python.exe` was called directly instead of
`Activate.ps1`). No source files were edited. The full fresh setup, measured from just before `git clone` until
`/health` reported `model_ready: true` and the dashboard server answered, took **61.2 seconds** (clone 6 s,
virtual environment 4 s, `pip install` 40 s, `npm install` 8 s), below the brief's 180-second target. This is
one run on one machine and network; other machines may be slower, and the dependency downloads need internet. A
separate **warm start** with dependencies already installed took 2.9 seconds; it is not a setup time. The
test checked out application commit `922f1b8` and used the setup instructions from the root README that was
committed afterwards. The documentation itself was not part of that tested checkout, and the commit that adds it
was not itself cloned and tested. The later frontend redesign described in section 3 (ward charts, English/Bangla
switch, hero image, redesigned forecast card and methodology) came after that test and was **not** included in the
61.2-second measurement.

## 3. Features

All of the following are implemented and covered by the tests described in section 8.

- **Weather-lag feature pipeline** (`ml/features.py`): per-ward lags of rainfall, temperature and humidity
  for 1 to 4 weeks, rolling rainfall sums over 2, 3 and 4 weeks, recent-case lags, and seasonality.
- **Trained XGBoost regression model** with dynamic inference for any ward and historical issue week.
- **Four risk tiers** (Low, Medium, High, Critical) and an **early alert** (predicted combined cases > 25).
- **FastAPI backend** with four read-only endpoints and consistent JSON errors.
- **React + TypeScript dashboard:** city, ward and issue-week selectors; a ward forecast card that leads with the
  estimated combined cases, the risk tier on a four-band scale and the early-alert status; the observed outcome
  shown beside the forecast as a historical comparison; and plain-language "what shaped this estimate" contributions
  (TreeSHAP groups that raised or lowered the estimate, with a collapsed technical-detail box and a note that they
  are attributions, not causes).
- **Five city-wise ward bar charts:** one chart per city corporation (Chattogram 10 wards, Dhaka North 20, Dhaka
  South 20, Gazipur 5, Narayanganj 5; 60 bars in total). Each bar is one ward: the X axis is the ward number and the
  Y axis is the predicted combined dengue cases for weeks +2 to +4 for the selected issue week, on one shared scale
  so cities can be compared. Bars are coloured by the backend's risk tier, early-alert wards carry a bell and a
  dashed line marks the alert threshold. Hovering or focusing a bar shows its ward, cases, tier and alert status;
  clicking it opens that ward's forecast. The selected ward has an outlined bar and a dark label, and the 20-ward
  charts scroll sideways on narrow screens. Below the charts, the all-ward summary, a per-city breakdown and a
  searchable, sortable ward list remain. The charts are **not a map**: no ward coordinates or boundaries exist in the
  data, and bar order has no geographic meaning.
- **English | বাংলা switch:** the whole interface can be switched between English and Bangla without reloading;
  the selected city, ward and week are kept and no new API requests are made. Bangla text uses a font already
  installed on the device (no Bangla font file is bundled yet), and the Bangla wording has not been reviewed by a
  native speaker.
- **Methodology and limits section:** four short blocks (how the model works, understanding the forecast, risk tiers
  and the early alert, accuracy and limits) with expandable technical detail. It keeps the false-alert counts, the
  absence of prediction intervals, the uncertain data provenance and the non-causal nature of TreeSHAP visible.
- **Hero background:** a subtle, locally bundled, AI-generated illustration (`frontend/public/images/dengue-hero-bg.webp`)
  behind the header at 55% opacity over the deep teal, which remains the fallback. It is an illustrative visual,
  not a photograph of a real outbreak (see section 10). The "Not a live warning system" historical-replay notice
  stays in the header.
- **Windows-compatible portable model loading** (`ml/predict_portable.py`) with SHA-256 artifact checks.
- Handled UI states: loading, backend unreachable, model unavailable, per-request errors with retry, and
  stale-response protection when selections change quickly.

## 4. Architecture overview

```text
Historical dataset                         ml/data/dengue_dataset.csv  (60 wards x 522 weeks)
        |  ml/features.py  (per-ward lags, rolling sums, calendar features)
        v
Trained XGBoost model                      ml/dengue_xgboost_model.ubj (+ .json fallback)
        |  ml/predict_portable.py  (hash-checked, loaded once)
        v
FastAPI backend (backend/app)              /health  /meta  /forecast/{ward_id}  /forecast
        |  JSON over HTTP on 127.0.0.1:8000
        v
React dashboard (frontend/src)             http://127.0.0.1:5173
```

At backend startup the portable forecaster is loaded once, builds the feature table from the bundled CSV,
and then serves every request from memory. The browser only calls the local backend.
A fuller write-up (Mermaid diagram, validation split, model-selection rationale and cost controls) is in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## 5. Forecasting methodology

Details and checks are in [`ml/model_report.md`](ml/model_report.md).

- **Data:** 31,320 rows, 60 wards x 522 consecutive weeks (Mondays 2016-01-04 to 2025-12-29), with
  `avg_temp_c`, `max_temp_c`, `min_temp_c`, `rainfall_mm`, `relative_humidity_pct`, `dengue_cases` and
  three static ward attributes (`population_density_sqkm`, `water_logging_risk_index`, `sanitation_score`).
- **Target:** the sum of cases in weeks t+2, t+3 and t+4 for the same ward, where *t* is the issue week
  (one combined number, not three weekly forecasts).
- **Features (32 model inputs):** week-*t* weather; weather lags for t-1 to t-4; rolling rainfall sums over
  2, 3 and 4 weeks; case lags for t-1 to t-4 and a 4-week case mean; month (sine and cosine); the static ward
  attributes; and city and ward identity. Week *t*'s own case count is excluded. All lags are computed
  within one ward, so no ward sees another ward's history.
- **Chronological validation:** issue weeks are split by time with a 4-week purge before each cutoff.

  | Period | Issue weeks | Rows |
  | --- | --- | --- |
  | Train | 2016-02-01 to 2022-11-21 | 21,360 |
  | Validation | 2022-12-26 to 2024-05-13 | 4,380 |
  | Test | 2024-06-17 to 2025-12-01 | 4,620 |

  The final model is refitted on train plus validation (25,740 rows) and evaluated once on the test period.
- **Model selection (validation MAE):** XGBoost 2.137, Hist Gradient Boosting 2.200, Extra Trees 2.250,
  Random Forest 2.514, mean baseline 10.202.
- **Risk tiers** on the predicted combined total *p* (clipped at 0): Low `p < 4.5`; Medium `4.5 <= p < 14.5`;
  High `14.5 <= p < 30.5`; Critical `p >= 30.5`. These are provisional, model-defined bands on absolute case
  counts, not clinical or official thresholds.
- **Early alert:** raised when predicted combined cases are **above 25**. The cut-off was chosen as the best
  validation F1 for detecting observed totals above 30.
- **Driver explanations:** XGBoost TreeSHAP attributions, grouped into 8 input groups. They describe how the
  model reached its number; they are not causal effects.

## 6. Model evaluation

All figures come from the held-out **test period: 4,620 ward-weeks** (60 wards x 77 issue weeks, 2024-06-17 to
2025-12-01), as recorded in [`ml/eval/metrics_summary.json`](ml/eval/metrics_summary.json) and
`ml/model_report.md`.

| Measure (combined weeks +2 to +4 cases) | Test result |
| --- | --- |
| MAE (clipped at 0, as served) | 2.776 |
| RMSE (clipped, as served) | 4.922 |
| R-squared | 0.813 |
| Seasonal baseline MAE (ward x week-of-year mean) | 3.223 (model is 13.9% lower after clipping) |
| Last-week persistence MAE (3 x last week) | 7.220 |
| Exact risk-tier accuracy | 0.813 (within one tier: 0.992) |

For reference, the unclipped (raw) model output scores MAE 2.786, RMSE 4.923 and R-squared 0.813; the table
reports the clipped predictions the application serves.

**Early alert** (predicted > 25 versus an observed total > 30): precision 0.357, recall 0.866, F1 0.506.
The alert fired 649 times: 232 for ward-weeks whose observed total exceeded 30, 417 for ones that did not.
It missed 36 of the 268 ward-weeks above 30. On validation the same rule had precision 0.722 and
recall 0.857.

Known weaknesses recorded in the project report: the model over-forecast June (mean bias +4.3 cases) and
September (+3.5) in the test period; it tends to under-forecast the largest outbreaks; Medium is the weakest
tier; and error varies by city (MAE 2.59 for Narayanganj to 3.23 for Gazipur) and by year. No confidence
intervals are reported or claimed.

## 7. API endpoints

All endpoints are read-only `GET` requests. Responses carry `"mode": "historical_replay"` and a limitation
notice. `issue_date` must be a **Monday** in `YYYY-MM-DD` form between **2016-02-01 and 2025-12-29**.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | API availability and whether the portable model actually loaded (`api_ready`, `model_ready`, `mode`). |
| `GET /meta` | Cities, all 60 wards, valid issue-week range, tier edges, alert threshold, model version. |
| `GET /forecast/{ward_id}?issue_date=YYYY-MM-DD&include_drivers=true` | One ward: predicted combined cases, `risk_tier`, `early_alert`, forecast weeks, driver contributions and, when available, the observed outcome for comparison. |
| `GET /forecast?issue_date=YYYY-MM-DD&include_drivers=false` | All 60 wards for one issue week. |

Example: `http://127.0.0.1:8000/forecast/DNCC_Ward_12?issue_date=2025-07-28`

Errors use `{"error": {"code", "message"}}`: 400 `invalid_date`, 404 `unknown_ward` or
`issue_week_out_of_range`, 422 `insufficient_history` / `invalid_input` / `validation_error`, 503
`model_unavailable`, 500 `internal_error`. Observed outcomes exist only for issue weeks up to 2025-12-01.
See [`backend/README.md`](backend/README.md) for details.

## 8. Testing

Run from PowerShell with the virtual environment active. Results below were observed on Windows 10 when this
README was written.

```powershell
# Backend (36 tests: foundation, endpoints, error handling, CORS, model integration)
cd backend
python -m pytest -q
cd ..

# Portable ML package (48 tests, from the repository root)
python -m pytest ml\tests\test_portable_api.py ml\tests\test_portable_equivalence.py -q

# Frontend (67 tests for the redesigned frontend), type checking, linting and production build
cd frontend
npm test
npm run typecheck
npm run lint
npm run build
```

| Suite | Observed result |
| --- | --- |
| Backend | 36 passed |
| Portable ML | 48 passed |
| Frontend, published baseline (commit `922f1b8`) | 34 passed; `typecheck` and `lint` exit 0; `build` succeeded |
| Frontend, redesigned (local commit `5a58555`) | 67 passed in 3 test files; `typecheck` and `lint` exit 0; `build` succeeded (verified on the redesigned code before that commit was created) |

The same suites were run again in the fresh clone described in section 2, which contained the earlier frontend
(backend 36 passed, portable ML 48 passed, frontend 34 passed; `typecheck`, `lint` and `build` succeeded), without
the legacy ML test file. The 67-test frontend result comes from the later redesign and was not part of that fresh
clone. A real-browser
check in that clone, on the earlier frontend, confirmed the Historical replay labelling, five cities and 60 wards, the DNCC Ward 12 forecast
(Critical tier, early alert raised) with its driver breakdown for 28 Jul 2025, and no console errors. These are the
project's own checks, not independent certification.

**Known failing on Windows:** `ml/tests/test_package.py` tests the original `predict.py` loader, which
deserializes a combined scikit-learn/XGBoost joblib file that fails on this Windows setup (`XGBoostError: input
stream corrupted`). Do not use it as a pass/fail signal on Windows. The default Windows path in this repository
is `ml/predict_portable.py`, which loads the same trained model from native XGBoost files; the portable
equivalence tests check that its predictions match the original pipeline.

## 9. Team contributions

Responsibilities below were provided by the team. The "Git history" column records only what the repository
history on `main` and the two feature branches shows; it is not a measure of effort.

| Member | Responsibilities (team-provided) | Git history |
| --- | --- | --- |
| **Masnoon Mohammad Tahseen Islam** | Application architecture and planning; FastAPI backend; React + TypeScript frontend; portable XGBoost model integration; API implementation and testing; end-to-end integration and browser verification; GitHub integration and coordination. | Git author metadata shows two names with the same e-mail address: `Masnoon Mohammad Tahseen Islam` (6 commits, each deleting files: `predict.py`, `model_config.json`, `model_report.md`, `integration_guide.md`, `requirements-notebook.txt` and a `requirements.txt`) and `0gguy` (6 commits as of `996cb06`: portable inference, backend foundation, model integration, frontend and two documentation commits). Git records only these names and the shared e-mail address; that both belong to this member is stated by the team, not verified by Git. |
| **Muhammad Asir Hossain Chowdhury** | Dataset analysis and exploration; machine-learning workflow; XGBoost development and evaluation; model documentation and artifacts; portable model export and compatibility work. | 14 commits on `main`: 3 file uploads (the last one adds the ML package: dataset, notebook, `features.py`, trained model, evaluation files, model report, integration guide), 1 README creation and 10 file or directory deletions. |
| **S.M. Gazi Salauddin Chowdhury** | Experimental weather-lag preprocessing; experimental Random Forest training and validation; documentation and presentation. | 2 commits, **only on separate feature branches** (below), not on `main`. Documentation and presentation work is not visible in Git. |

Experimental branches (not merged, not part of the deployed application):

- [`feat/weather-lag-pipeline`](https://github.com/0gguy/innovXaaa_/tree/feat/weather-lag-pipeline): a weather-lag preprocessing script and processed dataset.
- [`feat/train-dengue-model`](https://github.com/0gguy/innovXaaa_/tree/feat/train-dengue-model): a Random Forest trained on a chronological split of that processed data.

That experiment predicts a single week's cases with different features and tier cut-offs; it is **not
deployed**. **The deployed model is the XGBoost model described above**, and the experiment's MAE must not be
compared with the XGBoost combined-horizon MAE.

As of commit `996cb06`, every commit on `main` was made between 00:03 and 02:40 on 2026-11-22 (Bangladesh time),
and both feature-branch commits fall in the same night (about 00:08 and 00:18). The public history therefore
does not show activity spread across the full 24-hour window, and reflects repository consolidation more than the
pace of the underlying work.

## 10. AI tools and development disclosure

AI assistants were used during development. They are **not** part of the running application.

| Tool | Used for |
| --- | --- |
| **Claude Code** (Anthropic). The backend, frontend, backend-to-model integration and root documentation were done with Claude Sonnet 5.5; the model version for earlier sessions, including the portable-loader package, was not recorded | Programming assistance for the FastAPI backend, React/TypeScript frontend, portable model integration, automated tests, browser verification and documentation drafting. |
| **Claude Browser** | Used by the team during development, as stated by the team. |
| **AI-assisted analysis and modeling workflow** (Claude) | Dataset analysis, the XGBoost modeling workflow, model evaluation and model documentation, as stated by the team. The exact tool versions for these earlier sessions were not recorded in the repository. |
| Claude Code skills: `frontend-design`, `impeccable`, `unslop` | Written design guidance loaded into Claude Code, plus a local design-lint check (`impeccable`). They are instructions and tooling, not separate AI models or external APIs. |
| Playwright CLI | Local browser-automation tool used by Claude Code for browser testing. It is not an AI model. |
| **OpenAI ChatGPT image generation** (prompt not recorded in the repository) | The hero background image `frontend/public/images/dengue-hero-bg.webp`. It is an illustrative, AI-generated visual, **not a photograph** of a real event or outbreak, and no photographic source or image licence is claimed for it. |

**Runtime external APIs: none.** The running application makes no calls to AI services, weather services or
other hosted APIs. The organizer's dataset (a Google Sheet linked in the brief) was obtained during
development and is bundled as `ml/data/dengue_dataset.csv`.

The team directed the work, reviewed the generated code and reports, and authorized the commits made through
Claude Code. The test suites and browser checks were executed by Claude Code in those sessions, and their results
are reported here as observed, not as independent validation. The project was not written entirely by hand. AI
assistance is disclosed here in the documentation; commits carry no AI co-author trailers.

## 11. Runtime and cost controls

Verified in the code and tests:

- **Local inference only.** No paid or hosted inference API, no LLM calls, no external weather or data
  service, no database, no authentication.
- **Model loaded once.** The FastAPI lifespan loads the portable forecaster at startup; requests reuse it
  (a test asserts the loader runs once and is not repeated per request).
- **Conservative threads.** The backend defaults `OMP_NUM_THREADS=1` and sets XGBoost `n_jobs=1`.
- **Single-worker localhost demo.** The documented command binds `127.0.0.1` with `--workers 1` and no
  auto-reload. These come from the command line, not from code defaults.
- **Fewer requests from the UI.** One request for the selected ward and one batched request for all wards per
  issue week; newer selections cancel older requests.
- **Integrity.** Model artifacts are checked against SHA-256 hashes in `ml/portable_manifest.json` on load.

Latency figures in `ml/integration_guide.md` (about 7 ms for one ward and 17 ms for all 60 wards, 1.35 s startup)
were measured on a 2-vCPU Linux environment, not on this Windows setup.

## 12. Demo and submission

The official brief (Phase 1, 24-hour remote qualifier, 21 November 2:00 PM BST to 22 November 2:00 PM BST)
scores eight criteria out of 100 and allows up to 5 bonus points. In outline it asks for:

- A public GitHub repository with a dependency file and `README.md` commands that launch the app locally in
  3 minutes or less.
- A programmatic multi-week weather-lag pipeline, computed per `ward_id`.
- A trained model that produces dynamic predictions with Low, Medium, High and Critical tiers.
- A working web dashboard with a clear driver breakdown.
- A root `ARCHITECTURE.md` (1 to 2 pages) with a data-flow diagram, the chronological validation split and
  the model-selection rationale, plus documented API-call and cost controls.
- An uncut screen recording of at most 3:00 on localhost or a deployed URL, with voiceover and no slides.
- Distributed commits across team members and an explicit list of AI assistants and external APIs (section 10).

The brief's "Submission Link" field is blank in the copy the team received; follow the organizers'
instructions for how to submit.

**Status of submission items:** this README, the AI disclosure and [`ARCHITECTURE.md`](ARCHITECTURE.md) are
written. The demo video is **not yet recorded**. A fresh-clone launch check of the published
application code (the earlier frontend, before the redesign) was run once (section 2): 61.2 seconds to readiness
on one machine, below the 3-minute target. No bonus extension (confidence intervals, a geographic heat map or a
validation-error dashboard) is claimed; the ward bar charts are not a map.

To demo: follow the Quick start, then walk through selecting a city, ward and issue week; the ward forecast,
tier, early alert and the contributions that shaped the estimate; the observed-outcome comparison; the five city
bar charts and the ward list; the English/Bangla switch; and the limitations section.

## 13. Limitations

- **Historical replay.** The data end on 2025-12-29. Nothing here predicts 2026 or any current outbreak.
- **Dataset provenance.** The project report finds the data appear simulated: maximum and minimum
  temperatures are identical across wards each week, and weekly rainfall correlates at 0.991 or higher between
  every pair of wards, so ward differences come mostly from the static attributes. Results describe
  performance on this dataset, not real surveillance.
- **Provisional tiers.** Risk bands and the alert cut-off are model-defined on absolute case counts (no
  population data for incidence) and are not official thresholds.
- **Model uncertainty.** The alert has low precision on the test period (many false alerts), the model
  under-forecasts the largest outbreaks, and it is biased high in June and September. There are no
  confidence intervals.
- **No official warnings.** Outputs need review by public-health professionals before any use.
- **Driver bars are attributions, not causes.** They show how the model reached a number.

## 14. Further documentation

| Document | Contents |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Diagram, features and target, chronological validation, tiers, API flow and compute controls. |
| [`backend/README.md`](backend/README.md) | Backend setup, endpoints, errors, CORS and runtime controls. |
| [`frontend/README.md`](frontend/README.md) | Dashboard setup, commands, features and API behaviour. |
| [`ml/model_report.md`](ml/model_report.md) | Data, features, validation design, model selection, metrics and limitations. |
| [`ml/integration_guide.md`](ml/integration_guide.md) | Output schema, risk tiers, error codes. **Its examples import the original `predict.py` loader, which does not work on Windows; use `predict_portable.py`.** |
| [`ml/README_WINDOWS.md`](ml/README_WINDOWS.md) | Portable-loader handoff. **Its status line ("not verified on Windows") predates the Windows verification recorded here.** |
| [`ml/compatibility_report.md`](ml/compatibility_report.md) | Equivalence evidence between the original and portable models. |
| [`ml/model_config.json`](ml/model_config.json), [`ml/portable_manifest.json`](ml/portable_manifest.json) | Model configuration, tiers, thresholds and artifact hashes. |
| [`ml/README.md`](ml/README.md) | Original ML package notes. **Its `predict.py` commands and 37-test suite target the original loader and fail on Windows.** |
