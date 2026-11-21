# Dengue 2–4-week ward forecast — model report

Model version `dengue-xgb-2to4w-1.1.0` · report date 2026-11-21 · replaces `backup/model_report.original.md`

All numbers in this report come from executing `dengue_analysis_final.ipynb` from a clean kernel (Python 3.13, scikit-learn 1.6.1, xgboost 3.4.1). The same values are saved in `eval/metrics_summary.json` and `model_config.json`.

## 1. Task

The model forecasts ward-level dengue cases for the 60 wards in the organizer dataset. It covers 5 city corporations: Dhaka North (20 wards), Dhaka South (20), Chattogram (10), Gazipur (5) and Narayanganj (5).

* **Target:** cases in weeks t+2, t+3 and t+4, summed (`future_dengue_cases_2_4w`). *t* is the issue week.
* **Inputs:** week-*t* weather; weather and cases for weeks t−1…t−4; static ward attributes (population density, water-logging risk, sanitation); calendar month; ward and city identity.
* Week *t*'s own case count is excluded. Adding it, tested on the same purged split, raised validation MAE from 2.1371 to 2.1762.

## 2. Data

The dataset has 31,320 rows × 12 columns: 522 consecutive weeks (Mondays 2016-01-04 to 2025-12-29) × 60 wards. It has no missing values, no duplicate rows and no duplicate ward-weeks, and every temperature satisfies min ≤ avg ≤ max. Feature engineering adds 20 engineered columns, giving the model 32 inputs. After removing the first 4 and last 4 weeks of each ward, 30,840 rows have both features and a target.

**Provenance.** The data appears simulated:

* `max_temp_c` and `min_temp_c` are identical in all 60 wards each week.
* Weekly rainfall correlates ≥ 0.991 between every pair of wards, including wards in different cities.
* Correlation between cases and rainfall peaks cleanly at a 3-week lag (r = 0.75).
* Cases are near zero from November to March.

Treat results as performance on this dataset, not validated real-world surveillance.

## 3. Features

Features are built by `features.py`, which both training and inference use. All lags are calendar lags within one ward: the value exactly *k* weeks earlier, or NaN if that week is absent. Rolling rainfall sums cover weeks t−1…t−k only.

Checks performed in the notebook:

* The features match the original notebook's `groupby().shift()` / `rolling()` definitions. The only differences are ≤ 2.4e-13 in the rolling sums, which disappear at float32, XGBoost's input precision.
* The target is identical to the original.
* No row receives another ward's history.
* Features for week *t* stay unchanged when every later record is removed or scrambled.

## 4. Validation design (unchanged from the original)

| Period | Issue weeks | Rows |
| --- | --- | --- |
| Train | 2016-02-01 – 2022-11-21 | 21,360 |
| Validation | 2022-12-26 – 2024-05-13 | 4,380 |
| Test | 2024-06-17 – 2025-12-01 | 4,620 |

Cutoffs fall at 70% and 85% of the weekly dates. A 4-week purge before each cutoff stops any target window crossing into the next period. The final model is refitted on train + validation (25,740 rows) and evaluated once on the test period.

## 5. Model

`Pipeline(ColumnTransformer[numeric passthrough, OneHotEncoder(handle_unknown="ignore") on city and ward_id] → XGBRegressor)` with these parameters:

* `n_estimators=500`, `learning_rate=0.03`, `max_depth=5`
* `min_child_weight=3`, `subsample=0.8`, `colsample_bytree=0.8`
* `reg_alpha=0.1`, `reg_lambda=2`
* `objective="reg:squarederror"`, `random_state=42`

The parameters are unchanged. The re-exported model file is **byte-identical** to the original `dengue_xgboost_model.joblib` (SHA-256 `d4929bcaf88e…`), so the shipped model is the original model.

**Model selection (validation MAE):**

| Model | MAE |
| --- | --- |
| **XGBoost** | **2.1371** |
| Hist Gradient Boosting | 2.2004 |
| Extra Trees | 2.2503 |
| Random Forest | 2.5142 |
| Mean dummy | 10.2024 |

The HistGradientBoosting score differs from the original run (2.2197); that model isn't shipped, and the difference wasn't investigated further.

**Rejected variants (validation MAE):**

| Variant | MAE |
| --- | --- |
| Log1p target | 2.3411 |
| Sample weighting | 2.2168 |
| Adding week-*t* cases | 2.1762 |
| Randomized search, 25 configurations × 4 chronological folds | 2.1827 (CV MAE 3.0661; reproduces the original search exactly) |

## 6. Performance

### Regression

| Metric | Validation | Test (raw output) | Test (clipped at 0, as served) |
| --- | --- | --- | --- |
| MAE | 2.1371 | 2.7861 | 2.7762 |
| RMSE | 4.3730 | 4.9234 | 4.9225 |
| R² | 0.8936 | 0.8132 | 0.8132 |

The raw test output was negative for 377 of 4,620 rows; clipping fixes this.

### Baselines

All baselines use the same target and test period, and only information available at issue time:

| Predictor | Test MAE | Test RMSE |
| --- | --- | --- |
| **XGBoost** | **2.7762** | **4.9225** |
| Seasonal: ward × week-of-year mean (train + val) | 3.2232 | 5.8108 |
| Seasonal: week-of-year mean | 3.6719 | 6.4790 |
| Persistence: 3 × last week | 7.2197 | 11.8451 |
| Persistence: 3 × 4-week mean | 7.5684 | 11.6315 |
| Mean (dummy) | 9.5167 | 11.4080 |

XGBoost's MAE is **13.6% lower** than seasonal climatology on raw predictions, and 13.9% lower after clipping. The earlier report's "70.7% better" was relative to the mean dummy only.

### Rolling-origin by year

For each year, the model is trained on issue weeks up to 5 weeks before 1 January and tested on that year:

| Year | XGBoost MAE | Seasonal MAE | Persistence MAE | Gain vs seasonal |
| --- | --- | --- | --- | --- |
| 2025 | 2.832 | 3.003 | 6.582 | 5.7% |
| 2024 | 1.894 | 2.558 | 5.329 | 25.9% |
| 2023 | 2.714 | 3.245 | 7.704 | 16.4% |
| 2022 | 2.826 | 3.651 | 7.435 | 22.6% |
| 2021 | 1.995 | 2.689 | 4.886 | 25.8% |
| 2020 | 2.407 | 2.907 | 5.899 | 17.2% |

XGBoost beats seasonal climatology in all 6 years, but the margin varies: it is smallest in 2025.

### Where it errs (test period)

* **City:** MAE runs from 2.59 (Narayanganj) to 3.23 (Gazipur).
* **Season:** mean bias (predicted − actual) by issue month is +4.31 in June, +2.30 in July, +3.54 in September and −1.06 in May. Off-season months (October–April) are near zero.
* **Largest outbreaks:** for actual totals above 30, the mean prediction is 33.3 against a mean actual of 36.7.

### Outbreak alert

The alert fires when the prediction is above 25; an actual outbreak is an actual total above 30. The threshold of 25 is the best validation F1 among 15–40. **These are XGBoost numbers.** The original report used HistGradientBoosting predictions labelled as XGBoost (audit issue H1).

| | Precision | Recall | F1 | Confusion [[TN, FP], [FN, TP]] |
| --- | --- | --- | --- | --- |
| Validation | 0.7216 | 0.8571 | 0.7836 | [[3877, 125], [54, 324]] |
| Test | 0.3575 | 0.8657 | 0.5060 | [[3935, 417], [36, 232]] |

Test precision falls because of the June/September over-forecasting described above.

## 7. Risk tiers

Tiers are assigned from the clipped predicted 3-week total *p*:

| Tier | Rule | Integer equivalent |
| --- | --- | --- |
| Low | p < 4.5 | 0–4 |
| Medium | 4.5 ≤ p < 14.5 | 5–14 |
| High | 14.5 ≤ p < 30.5 | 15–30 |
| Critical | p ≥ 30.5 | > 30 |

The bands are provisional, model-defined categories on absolute counts, **not** clinical or official thresholds. They follow the training-target distribution (median 1, 75th percentile 14) and the original "> 30" outbreak definition, and were not tuned on test. Training rows fall 63.5% Low, 12.6% Medium, 16.2% High and 7.7% Critical. Actual totals are put in tiers with the same bands for evaluation.

| | Validation | Test |
| --- | --- | --- |
| Exact-tier accuracy | 0.872 | 0.813 |
| Within-one-tier accuracy | 0.997 | 0.992 |
| Macro F1 | 0.694 | 0.667 |
| Quadratic-weighted kappa | 0.927 | 0.900 |
| Critical recall | 0.632 | 0.597 |
| Critical precision | 0.863 | 0.482 |
| Predicted Critical, actual lower | 38 | 172 |
| Actual Critical, predicted High | 139 | 108 |
| Actual Critical, predicted Low/Medium | 0 | 0 |

Test confusion matrix (rows actual, columns predicted; Low / Medium / High / Critical):

```
Low       2535  127   20    0
Medium      65  245  293    5
High        10   70  815  167
Critical     0    0  108  160
```

Medium is the weakest tier: 293 of 608 actual-Medium weeks were predicted High. Every actual Critical week was predicted High or Critical; none was predicted Low or Medium. Because Critical recall alone is limited, outputs also carry `early_alert` (p > 25). Flagging Critical **or** early_alert catches 86.6% of actual > 30 weeks in the test period.

## 8. Driver explanations

Each prediction can be split into additive XGBoost TreeSHAP contributions, grouped into 8 driver groups. Over the test set, contributions plus the bias term reproduce the raw output within 6e-5. The groups with the largest mean absolute contribution on test are:

1. Rainfall this week (4.35)
2. Humidity (2.47)
3. Rainfall in the previous 1–4 weeks (2.20)
4. Temperature (2.08)
5. Ward vulnerability (1.85)

These describe how the model reached its number. They are not causal effects.

## 9. Limitations

* The data ends 2025-12-29. Outputs are historical replays, not live 2026 warnings.
* Provenance is uncertain and the data is probably simulated. Weather barely differs between wards.
* Strong seasonality: much of the skill is timing the season. Compare against the seasonal baseline, not only the mean.
* Counts are absolute; no population figures are available to compute incidence.
* False alerts concentrate at the start of the season. The largest outbreaks are under-forecast.
* Performance varies by city and by year.
* This is a hackathon prototype, not a validated public-health decision system. Outputs need review by public-health professionals.

## 10. Files

| File | Contents |
| --- | --- |
| `features.py` | Feature and target builders |
| `predict.py` | Inference API |
| `dengue_xgboost_model.joblib` | Trained pipeline |
| `model_config.json` | Plain-JSON configuration |
| `dengue_analysis_final.ipynb` | Analysis and training notebook |
| `eval/` | Evaluation tables and predictions |
| `tests/` | Unit tests |
| `integration_guide.md` | Backend handoff |
| `backup/` | Original notebook, model, config, `predict.py` and report, unchanged |
