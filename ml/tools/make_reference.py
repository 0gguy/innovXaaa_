"""Create reference/reference_cases.csv from the ORIGINAL pipeline (stratified tier x city x monsoon)."""
import sys, json
from pathlib import Path
import numpy as np, pandas as pd, joblib
PKG = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(PKG))
import features as F
cfg = json.loads((PKG/"model_config.json").read_text()); edges=np.array(cfg["risk_tiers"]["edges"]); labels=cfg["risk_tiers"]["labels"]
raw = pd.read_csv(PKG/"data/dengue_dataset.csv"); mf = F.build_model_frame(raw)
pipe = joblib.load(sys.argv[1])
p = pipe.predict(mf[F.FEATURE_COLUMNS]).astype(float)
df = mf.copy(); df["expected_raw"]=p; df["expected_tier"]=[labels[i] for i in np.searchsorted(edges,np.clip(p,0,None),side="right")]
df["expected_alert"]=p>25; df["monsoon"]=pd.to_datetime(df["date"]).dt.month.isin([6,7,8,9,10])
rng=np.random.RandomState(0); parts=[]
for (t,c,m),g in df.groupby(["expected_tier","city","monsoon"]):
    parts.append(g.sample(min(len(g),2),random_state=rng))
# add rows nearest to each edge and the alert threshold
for e in list(edges)+[25.0]:
    parts.append(df.iloc[np.argsort(np.abs(df.expected_raw-e).values)[:3]])
ref=pd.concat(parts).drop_duplicates(["ward_id","date"]).sort_values(["date","ward_id"])
ref.to_csv(PKG/"reference/reference_cases.csv", index=False)
print(len(ref), ref.expected_tier.value_counts().to_dict(), ref.city.nunique(), ref.monsoon.value_counts().to_dict(), ref.expected_alert.sum())
print([c for c in ref.columns if c not in F.FEATURE_COLUMNS])
