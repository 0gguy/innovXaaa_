
# Dengue Forecasting Model Report

## 1. Project Overview

This project forecasts dengue cases at the ward level in Chattogram, Bangladesh.

The model predicts the cumulative dengue cases expected in:
- Two weeks ahead
- Three weeks ahead
- Four weeks ahead

Target definition:

future_dengue_cases_2_4w = cases in week +2 + cases in week +3 + cases in week +4

## 2. Dataset

- Data frequency: Weekly
- Geographic level: Ward
- Historical period: 2016–2025
- Original dataset shape: 31,320 rows and 39 columns
- Final training features: 32

Features include:
- Weather measurements
- Historical weather lags
- Rolling rainfall statistics
- Historical dengue case lags
- Ward and city identifiers
- Seasonal features

## 3. Data Splitting

Chronological splitting was used to respect the time-series nature of the data.

| Dataset | Rows |
|---|---:|
| Training | 21,360 |
| Validation | 4,380 |
| Testing | 4,620 |

A four-week purge gap was applied between the splits to reduce target-horizon overlap.

The final model was trained using 25,740 training and validation observations.

## 4. Model

Algorithm: XGBoost Regressor

Hyperparameters:

- n_estimators: 500
- learning_rate: 0.03
- max_depth: 5
- min_child_weight: 3
- subsample: 0.8
- colsample_bytree: 0.8
- reg_alpha: 0.1
- reg_lambda: 2
- random_state: 42

Preprocessing:
- Numerical features: passthrough
- Categorical features: OneHotEncoder
- Unknown categories: ignored

The saved pipeline includes preprocessing and the trained model.

## 5. Final Test Performance

Evaluated on the untouched chronological test split:

| Metric | Result |
|---|---:|
| MAE | 2.7861 |
| RMSE | 4.9234 |
| R² | 0.8132 |

Dummy baseline MAE: 9.5167

The XGBoost model achieved approximately 70.7% lower MAE than the dummy baseline.

These regression metrics were calculated on the raw model predictions, before clipping negative predictions to zero.

## 6. Experimental Alert System

The selected prediction alert threshold is 25 cases.

- Predicted value > 25: High Risk
- Predicted value <= 25: Below Alert Threshold

The threshold was selected using validation data.

For evaluation, actual high risk was defined as more than 30 future cases.

Validation results at the selected alert threshold:
- Precision: 0.7541
- Recall: 0.8439
- F1-score: 0.7965

Test results at the same threshold:
- Precision: 0.3575
- Recall: 0.8657
- F1-score: 0.5060

The test results show that the alert system catches many high-risk observations but also generates substantial false alarms.

This threshold is experimental, not an officially approved public-health threshold.

## 7. Prediction Constraints

Dengue case counts cannot be negative.

Therefore, negative model predictions are clipped to zero before being returned by the prediction function.

## 8. Important Deployment Assumptions

- Input features must represent the relevant ward and current observation week.
- Current-week weather observations must be available before forecasting.
- Lag and rolling features must be calculated correctly from historical data.
- Categorical values such as city and ward identifiers must match the expected input format.
- All required model features must be supplied to the prediction function.

## 9. Limitations

- Model performance may vary across future time periods and wards.
- The test alert precision is substantially lower than validation precision.
- False alerts may occur.
- This is an experimental forecasting prototype, not a clinically or operationally validated public-health decision system.
- Predictions should be reviewed by relevant public-health professionals before being used for real-world decisions.

## 10. Project Files

- dengue_xgboost_model.joblib: Trained preprocessing and model pipeline.
- model_config.joblib: Model configuration and feature definitions.
- predict.py: Prediction function for backend integration.
- model_report.md: Model documentation and evaluation report.
