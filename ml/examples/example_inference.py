"""Minimal runnable example. From the package folder:  python examples/example_inference.py"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from predict import ForecastError, forecast, forecast_all  # noqa: E402

# One ward, one issue week (historical replay)
result = forecast("DNCC_Ward_12", "2025-06-16")
print(json.dumps({k: result[k] for k in ("ward_id", "issue_week", "forecast_weeks",
                                         "predicted_cases_3wk", "risk_tier", "early_alert")}, indent=2))
print("top driver:", result["drivers"]["groups"][0])
print("actual (for comparison):", result["actual"]["actual_cases_3wk"], result["actual"]["actual_risk_tier"])

# All 60 wards for one week, e.g. for a map or ranking
rows = forecast_all("2025-06-16")
top = sorted(rows, key=lambda r: r["predicted_cases_3wk"], reverse=True)[:5]
print("highest predicted wards:", [(r["ward_id"], round(r["predicted_cases_3wk"], 1), r["risk_tier"]) for r in top])

# Errors come back as ForecastError with a stable code
try:
    forecast("XYZ_Ward_99", "2025-06-16")
except ForecastError as e:
    print("rejected:", e.to_dict())
