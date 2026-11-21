# Dengue 2–4-week ward forecast — ML package

Predicts total dengue cases in weeks t+2..t+4 for each of 60 wards, with Low/Medium/High/Critical tiers. Historical replay on the organizer dataset (2016–2025).

**Windows and the application use `predict_portable.py`.** The original `predict.py` loads one combined
scikit-learn/XGBoost joblib (`dengue_xgboost_model.joblib`), which failed to load on the project's Windows 10 /
Python 3.13.1 setup (observed on 22 Nov 2026: `tests/test_package.py` errored with `XGBoostError: input stream
corrupted`). `predict_portable.py` loads the same trained model from native XGBoost files
(`dengue_xgboost_model.ubj`, fallback `.json`) and a small fitted scikit-learn preprocessor
(`dengue_preprocessor.joblib`, fallback `.json`), checked against `portable_manifest.json`.

Supported path, run from this `ml/` folder (observed passing on Windows 10, Python 3.13.1, 22 Nov 2026):

```bash
pip install -r requirements.txt
python -m pytest -q tests/test_portable_api.py tests/test_portable_equivalence.py   # 48 tests
python examples/quickstart.py
python predict_portable.py 2025-06-16 DNCC_Ward_12      # one ward, JSON to stdout
python predict_portable.py 2025-06-16 --all             # all 60 wards
```

Legacy (original loader; reported as working on Linux, **not on this Windows setup**):

```bash
python -m pytest -q tests/test_package.py      # 37 original tests; errors on Windows
python examples/example_inference.py
python predict.py 2025-06-16 DNCC_Ward_12
```

Other Windows or Python versions were not tested.

* Backend handoff: `integration_guide.md`
* Model and evaluation: `model_report.md`
* Retrain / reproduce: `pip install -r requirements-notebook.txt`, then run `dengue_analysis_final.ipynb` top to bottom (~4 min)
* Originals (unchanged): `backup/`
