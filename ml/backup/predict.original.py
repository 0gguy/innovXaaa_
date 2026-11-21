
import joblib
import pandas as pd
import os

# Get the directory containing this Python file
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Load model and configuration
model = joblib.load(
    os.path.join(BASE_DIR, "dengue_xgboost_model.joblib")
)

config = joblib.load(
    os.path.join(BASE_DIR, "model_config.joblib")
)

def predict_dengue(input_data):

    input_df = pd.DataFrame([input_data])

    required_features = config["feature_columns"]

    missing_features = [
        col for col in required_features
        if col not in input_df.columns
    ]

    if missing_features:
        raise ValueError(f"Missing features: {missing_features}")

    input_df = input_df[required_features]

    prediction = float(model.predict(input_df)[0])
    prediction = max(0.0, prediction)

    alert = (
        "High Risk"
        if prediction > config["alert_threshold"]
        else "Below Alert Threshold"
    )

    return {
        "predicted_cases": round(prediction, 2),
        "alert": alert
    }
