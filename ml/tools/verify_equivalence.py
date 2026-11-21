"""Linux-side proof that portable files reproduce the ORIGINAL pipeline. Needs the original joblib (trusted)."""
import sys, json, itertools
from pathlib import Path
import numpy as np, pandas as pd, joblib
from xgboost import XGBRegressor, DMatrix
PKG = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(PKG))
import features as F
from predict_portable import JsonPreprocessor
orig_path = Path(sys.argv[1])
cfg = json.loads((PKG/"model_config.json").read_text())
edges = np.array(cfg["risk_tiers"]["edges"]); thr = cfg["early_alert"]["threshold"]
raw = pd.read_csv(PKG/"data/dengue_dataset.csv")
mf = F.build_model_frame(raw)
X = mf[F.FEATURE_COLUMNS]
split = json.loads((PKG/"eval/metrics_summary.json").read_text()) if (PKG/"eval/metrics_summary.json").exists() else {}
test_ref = pd.read_csv(PKG/"eval/test_predictions.csv")
pipe = joblib.load(orig_path)
pre_j = joblib.load(PKG/"dengue_preprocessor.joblib")
pre_s = JsonPreprocessor(json.loads((PKG/"dengue_preprocessor.json").read_text()))
regs = {}
for ext in ("ubj","json"):
    r = XGBRegressor(); r.load_model(str(PKG/f"dengue_xgboost_model.{ext}")); regs[ext]=r
tier = lambda p: np.searchsorted(edges, np.clip(p,0,None), side="right")
base = pipe.predict(X).astype(float)
out = {"rows": len(X)}
for pn, pre in (("joblib_pre",pre_j),("json_pre",pre_s)):
    for mn, r in regs.items():
        p = r.predict(pre.transform(X)).astype(float)
        d = np.abs(p-base)
        out[f"{pn}+{mn}"] = dict(max_abs=float(d.max()), mean_abs=float(d.mean()), bit_identical=bool((p==base).all()),
            tier_mismatch=int((tier(p)!=tier(base)).sum()), alert_mismatch=int(((p>thr)!=(base>thr)).sum()))
# preprocessor matrices
Xo = pipe.named_steps["preprocessor"].transform(X)
out["preproc_matrix_equal"] = {"joblib": bool(np.array_equal(Xo, pre_j.transform(X))), "json": bool(np.array_equal(Xo, pre_s.transform(X))),
  "names_equal": bool(list(pipe.named_steps["preprocessor"].get_feature_names_out())==list(pre_s.get_feature_names_out()))}
# SHAP
bo = pipe.named_steps["model"].get_booster()
c0 = bo.predict(DMatrix(Xo), pred_contribs=True); c1 = regs["ubj"].get_booster().predict(DMatrix(pre_s.transform(X)), pred_contribs=True)
out["shap_max_abs_diff"] = float(np.abs(c0-c1).max())
# test-set subset via eval file
key = [c for c in ("ward_id","issue_date","date") if c in test_ref.columns]
out["test_ref_columns"] = list(test_ref.columns)
# near-edge counts
near = lambda p, pts, w: int(sum((np.abs(p-e)<w).sum() for e in pts))
out["near_edges_1e-3"] = near(base, list(edges)+[thr], 1e-3); out["near_edges_1e-2"] = near(base, list(edges)+[thr], 1e-2)
Path(PKG/"reference").mkdir(exist_ok=True)
json.dump(out, open(PKG/"reference/equivalence_linux_result.json","w"), indent=1)
print(json.dumps(out, indent=1))
