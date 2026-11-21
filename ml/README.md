# Dengue 2–4-week ward forecast — ML package

Predicts total dengue cases in weeks t+2..t+4 for each of 60 wards, with Low/Medium/High/Critical tiers. Historical replay on the organizer dataset (2016–2025).

```bash
pip install -r requirements.txt
python -m pytest -q tests                      # 37 tests
python examples/example_inference.py
python predict.py 2025-06-16 DNCC_Ward_12
```

* Backend handoff: `integration_guide.md`
* Model and evaluation: `model_report.md`
* Retrain / reproduce: `pip install -r requirements-notebook.txt`, then run `dengue_analysis_final.ipynb` top to bottom (~4 min)
* Originals (unchanged): `backup/`
