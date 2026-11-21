# Windows handoff — dengue forecaster (portable loader)

**Status (updated 22 Nov 2026).** This handoff was written after Linux-only testing. On Windows 10 with Python 3.13.1,
xgboost 3.4.1 and scikit-learn 1.6.1 the portable test suite (48 tests) passed in this repository, while the original
`tests/test_package.py` (original joblib loader) errored. `tools/windows_diagnose.py` was not run for this update; it
remains a useful check on a new machine. Other Windows or Python versions were not tested. This folder is already
integrated at `ml/` in the repository, so step 1 below only applies if you copy it elsewhere.

## What is in this folder
| File | Purpose |
|---|---|
| `dengue_xgboost_model.ubj` | The existing trained booster, native XGBoost binary format (primary) |
| `dengue_xgboost_model.json` | Same booster, text format (fallback if `.ubj` will not load) |
| `dengue_preprocessor.joblib` | Fitted scikit-learn preprocessor (no XGBoost inside) |
| `dengue_preprocessor.json` | Same preprocessor as plain JSON (fallback; no pickle at all) |
| `portable_manifest.json` | Sizes + SHA-256 of the files above; checked on every load |
| `predict_portable.py` | Supported Windows loader. Same API as `predict.py` (`forecast`, `forecast_all`, `forecast_from_records`, `get_forecaster`) plus a small command line |
| `predict.py`, `features.py`, `model_config.json` | Unchanged originals (byte-identical) |
| `tools/windows_diagnose.py` | Run this first on Windows |
| `tools/export_portable.py`, `tools/verify_equivalence.py`, `tools/make_reference.py` | How the export was made/proved (need the original joblib) |
| `reference/reference_cases.csv` | 91 input rows + expected outputs from the ORIGINAL pipeline |
| `tests/` | `test_portable_api.py` (37 adapted original tests), `test_portable_equivalence.py` (11) |
| `.gitattributes` | Marks model files binary so Git cannot rewrite their line endings |

`dengue_xgboost_model.joblib` (the original) is not duplicated here; keep your existing copy where it is.

## Steps
1. Copy this folder over (or merge it into your project). If it goes through Git, commit `.gitattributes` **first**.
2. `py -m venv .venv`, `.venv\Scripts\activate`, `pip install -r requirements.txt`
3. `python tools\windows_diagnose.py` — prints every load path as PASS/FAIL and writes `diagnose_report.txt`. **Send me that file if anything fails.**
4. `python -m pytest -q tests/test_portable_api.py tests/test_portable_equivalence.py` (48 tests). Do not use plain `tests`: it also collects the legacy `test_package.py`, which targets the original loader and errors on Windows.
5. Use it: `from predict_portable import forecast, forecast_all, forecast_from_records` (identical signatures and JSON output to `predict.py`), or from the command line `python predict_portable.py 2025-06-16 DNCC_Ward_12` / `python predict_portable.py 2025-06-16 --all`.

Equivalence tolerance on Windows: `set DENGUE_EQ_TOL=1e-4` is the default off Linux. Tier labels and the alert flag (`predicted > 25`) must match exactly. Rules are unchanged: Low < 4.5, Medium 4.5–<14.5, High 14.5–<30.5, Critical ≥ 30.5.

## If something fails
* **SHA-256 / size mismatch on load** → the file was altered in transit (Git CRLF conversion, partial download). Re-copy it; do not edit the manifest.
* **`.ubj` fails but `.json` loads** → `predict_portable` already falls back automatically (`get_forecaster().artifact_info` says which file was used).
* **Both model formats fail, but the tiny round-trip in the diagnostic passes** → the problem is specific to these files or to how they reached the machine; send `diagnose_report.txt`.
* **Even the tiny XGBoost round-trip fails** → the XGBoost install on that machine is broken; reinstall `xgboost==3.4.1` or try a different Python build.
