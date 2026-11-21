"""python examples/quickstart.py   (from the package folder)"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from predict_portable import forecast, forecast_all, get_forecaster, ForecastError
print("model files:", get_forecaster().artifact_info)
print(json.dumps(forecast("DNCC_Ward_12", "2025-06-16", include_drivers=False), indent=2))
top = sorted(forecast_all("2025-06-16"), key=lambda r: -r["predicted_cases_3wk"])[:3]
print([(r["ward_id"], r["predicted_cases_3wk"], r["risk_tier"], r["early_alert"]) for r in top])
try: forecast("NO_SUCH_WARD", "2025-06-16")
except ForecastError as e: print(e.to_dict())
