"""
ONE-TIME export, run on the machine where the original model loads (Linux, in this project).

Reads the ORIGINAL trained pipeline (a trusted project artifact) and writes
portable copies of its already-fitted parts. It never fits or retrains anything.

    python tools/export_portable.py <original dengue_xgboost_model.joblib> <output folder>
"""
import hashlib, json, pickletools, platform, sys
from pathlib import Path

import joblib
import numpy as np
import sklearn
import xgboost

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

pipe = joblib.load(src)                              # trusted artifact only
assert [n for n, _ in pipe.steps] == ["preprocessor", "model"], "unexpected pipeline layout"
pre, est = pipe.named_steps["preprocessor"], pipe.named_steps["model"]
booster = est.get_booster()

# 1) native XGBoost model (binary UBJSON) + text-JSON fallback of the same trees
booster.save_model(out / "dengue_xgboost_model.ubj")
booster.save_model(out / "dengue_xgboost_model.json")

# 2) fitted scikit-learn preprocessor (already fitted; saved as-is)
joblib.dump(pre, out / "dengue_preprocessor.joblib")

# 3) the same preprocessing facts as plain JSON (no pickle needed)
num_cols = list(pre.transformers_[0][2]); cat_cols = list(pre.transformers_[1][2])
ohe = pre.named_transformers_["cat"]
prep_json = {
    "description": "Fitted preprocessing of the original pipeline: numeric columns pass through unchanged, "
                   "each categorical column is one-hot encoded (unknown category -> all zeros). Output = numeric block "
                   "followed by one block per categorical column, in the order listed. Dense float64.",
    "input_columns": list(pre.feature_names_in_),
    "numeric_features": num_cols,
    "categorical_features": cat_cols,
    "categories": {c: [str(v) for v in cats] for c, cats in zip(cat_cols, ohe.categories_)},
    "handle_unknown": ohe.handle_unknown,
    "sparse_output": bool(pre.sparse_output_),
    "output_feature_names": [str(n) for n in pre.get_feature_names_out()],
}
(out / "dengue_preprocessor.json").write_text(json.dumps(prep_json, indent=1))

# 4) which Python modules does the preprocessor pickle import? (it must not need xgboost)
mods = set(); strs = []
for op, arg, _ in pickletools.genops((out / "dengue_preprocessor.joblib").read_bytes()):
    if op.name in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE"):
        strs.append(arg)
        if isinstance(arg, str) and arg.split(".")[0] in ("sklearn", "numpy", "scipy", "xgboost", "pandas", "joblib", "builtins", "collections"):
            mods.add(arg)
cfg = json.loads(booster.save_config())
manifest = {
    "purpose": "Pickle-free / snapshot-free export of the already-trained model. Predictions are identical to the original pipeline (see compatibility_report.md).",
    "model_version": json.loads(Path("model_config.json").read_text())["model_version"] if Path("model_config.json").exists() else None,
    "source_artifact": {"file": src.name, "sha256": sha(src), "bytes": src.stat().st_size},
    "created_with": {"python": platform.python_version(), "platform": platform.platform(), "numpy": np.__version__,
                     "scikit-learn": sklearn.__version__, "xgboost": xgboost.__version__, "joblib": joblib.__version__},
    "artifacts": {f: {"bytes": (out / f).stat().st_size, "sha256": sha(out / f)} for f in
                  ["dengue_xgboost_model.ubj", "dengue_xgboost_model.json", "dengue_preprocessor.joblib", "dengue_preprocessor.json"]},
    "load_order": {"model": ["dengue_xgboost_model.ubj", "dengue_xgboost_model.json"],
                   "preprocessor": ["dengue_preprocessor.joblib", "dengue_preprocessor.json"]},
    "model": {"num_boosted_rounds": booster.num_boosted_rounds(), "num_features": booster.num_features(),
              "objective": cfg["learner"]["objective"]["name"], "base_score": cfg["learner"]["learner_model_param"]["base_score"],
              "feature_names_stored_in_model": booster.feature_names},
    "preprocessor_pickle_modules": sorted(m for m in mods if not m.startswith("builtins")),
}
(out / "portable_manifest.json").write_text(json.dumps(manifest, indent=2))
for f in sorted(out.iterdir()):
    if f.is_file(): print(f"{f.stat().st_size:>10,}  {f.name}")
print("preprocessor pickle references modules:", manifest["preprocessor_pickle_modules"])
print("contains xgboost reference:", any("xgboost" in m for m in mods))
