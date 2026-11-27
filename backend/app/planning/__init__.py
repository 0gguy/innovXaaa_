"""Phase 2 resource planning: demand conversion, allocation engine and scenario assembly.

Planning logic only. Nothing here imports pandas, numpy, xgboost, scikit-learn or FastAPI, so
importing the package never loads the ML stack. Forecasts come in as plain dicts produced by the
Phase 1 forecaster (plus the Task 1 weekly block).
"""
