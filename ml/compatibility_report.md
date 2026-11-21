# Compatibility report (generated on Linux; Windows not verified)

Model: dengue-xgb-2to4w-1.1.0. No retraining, no refit, no change to features, target, split, hyperparameters, horizon, tiers or alert rule.

**Original artifact** `dengue_xgboost_model.joblib`: 1,327,432 bytes, SHA-256 d4929bcaf88e23513fd8febce9eb144034d1b39fc9089c68260548495b564c33. Loads and predicts on Linux/Python 3.13/xgboost 3.4.1/scikit-learn 1.6.1.

**Equivalence (executed, Linux)** — original pipeline vs preprocessor + native model, all 30,840 model rows (includes the 4,620-row test set; all 4 tiers, 5 cities, 60 wards, monsoon and non-monsoon):
joblib-preprocessor+.ubj, +.json, JSON-preprocessor+.ubj, +.json: max |diff| 0.0, mean 0.0, bit-identical, 0 tier mismatches, 0 alert mismatches; preprocessor output matrix equal; SHAP contributions max |diff| 0.0.
Full public-API comparison `forecast_all` (with drivers) for all 518 valid weeks × 60 wards = 31,080 forecasts: JSON output identical to the original `Forecaster`.

**Tests (Linux)**: original package 37/37 pass; portable 48/48 pass (37 adapted API + 11 equivalence/robustness).

**Not verified**: anything on Windows; the root cause of the Windows failure. Hypothesis only: XGBoost's pickle "memory snapshot" restore path failed on that machine. The native files use a different entry point but the same parser family, so they may or may not load there; hence the JSON fallbacks and `tools/windows_diagnose.py`.

**Float risk**: 1 of 31,080 predictions lies within 1e-3 of a tier edge or 25. A different CPU/build could in principle flip that tier; the Windows equivalence test exercises it.
