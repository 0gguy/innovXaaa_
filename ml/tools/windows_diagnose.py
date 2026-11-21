"""Run on the Windows machine:  python tools/windows_diagnose.py   -> writes diagnose_report.txt
Tries every load path separately and reports which work. Makes no changes to any file."""
import hashlib, io, json, os, platform, struct, sys, traceback
from pathlib import Path
PKG = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(PKG))
lines = []
def log(*a):
    s = " ".join(str(x) for x in a); print(s); lines.append(s)
def attempt(name, fn):
    try:
        r = fn(); log(f"[PASS] {name}" + (f" -> {r}" if r is not None else "")); return True
    except Exception as e:
        log(f"[FAIL] {name}: {type(e).__name__}: {str(e).strip()[:300]}")
        lines.append(traceback.format_exc()); return False

log("== environment ==")
log("python", sys.version.replace("\n", " "), "| bits", struct.calcsize("P") * 8, "|", platform.platform(), platform.machine())
for m in ("numpy", "pandas", "scipy", "sklearn", "xgboost", "joblib", "pytest"):
    try: log(m, __import__(m).__version__)
    except Exception as e: log(m, "NOT IMPORTABLE", e)
import numpy as np, pandas as pd, joblib, xgboost as xgb
try: bi = xgb.build_info(); log("xgboost build_info:", {k: bi[k] for k in bi if k in ("USE_CUDA", "USE_OPENMP", "BUILTIN_PREFETCH_PRESENT", "COMPILER", "GCC_VERSION", "MSVC_VERSION", "USE_DLOPEN_NCCL")})
except Exception as e: log("build_info unavailable", e)
log("xgboost lib:", getattr(xgb.core, "_LIB", None))

man = json.loads((PKG / "portable_manifest.json").read_text())
log("\n== file integrity (SHA-256 vs portable_manifest.json) ==")
for n, meta in man["artifacts"].items():
    p = PKG / n
    if not p.exists(): log("MISSING", n); continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    log("OK " if (h == meta["sha256"] and p.stat().st_size == meta["bytes"]) else "BAD", n, p.stat().st_size, "bytes (expected", meta["bytes"], ")")
orig = PKG / "dengue_xgboost_model.joblib"
if orig.exists(): log("original joblib present:", orig.stat().st_size, "bytes, sha256", hashlib.sha256(orig.read_bytes()).hexdigest()[:16], "(Linux original: 1,327,432 bytes, d4929bcaf88e23513fd8febc...)")

log("\n== is XGBoost pickling itself working on this machine? (tiny model, in memory) ==")
def tiny():
    import pickle
    rng = np.random.RandomState(0); X = rng.rand(200, 4); y = X.sum(1)
    m = xgb.XGBRegressor(n_estimators=5, max_depth=2).fit(X, y)
    m2 = pickle.loads(pickle.dumps(m)); return f"round-trip max diff {np.abs(m.predict(X) - m2.predict(X)).max()}"
attempt("tiny XGBRegressor pickle round-trip", tiny)
def tiny_ubj():
    rng = np.random.RandomState(0); X = rng.rand(200, 4); y = X.sum(1)
    m = xgb.XGBRegressor(n_estimators=5, max_depth=2).fit(X, y); p = PKG / "_tmp_tiny.ubj"; m.save_model(str(p))
    r = xgb.XGBRegressor(); r.load_model(str(p)); p.unlink(); return f"diff {np.abs(m.predict(X) - r.predict(X)).max()}"
attempt("tiny XGBRegressor save_model/load_model (.ubj)", tiny_ubj)

log("\n== model load paths ==")
ubj, js = PKG / "dengue_xgboost_model.ubj", PKG / "dengue_xgboost_model.json"
attempt("XGBRegressor.load_model(.ubj)", lambda: xgb.XGBRegressor().load_model(str(ubj)))
attempt("XGBRegressor.load_model(.json)", lambda: xgb.XGBRegressor().load_model(str(js)))
attempt("Booster(model_file=.ubj)", lambda: xgb.Booster(model_file=str(ubj)).num_features())
attempt("Booster.load_model(bytearray of .ubj)", lambda: xgb.Booster().load_model(bytearray(ubj.read_bytes())))
log("\n== preprocessor load paths ==")
attempt("joblib.load(dengue_preprocessor.joblib)", lambda: type(joblib.load(PKG / "dengue_preprocessor.joblib")).__name__)
import predict_portable as P
attempt("JsonPreprocessor(dengue_preprocessor.json)", lambda: P.JsonPreprocessor(json.loads((PKG / "dengue_preprocessor.json").read_text())).n_features_in_)

log("\n== end-to-end against expected outputs from the original pipeline ==")
def e2e():
    f = P.PortableForecaster(); ref = pd.read_csv(PKG / "reference" / "reference_cases.csv")
    import features as F
    raw, _ = f._predict(ref[F.FEATURE_COLUMNS], include_drivers=False)
    d = np.abs(raw - ref.expected_raw.to_numpy())
    p = np.clip(raw, 0, None); edges = np.array(f.tier_edges)
    tiers = [f.tier_labels[i] for i in np.searchsorted(edges, p, side="right")]
    return (f"files={f.artifact_info} rows={len(ref)} max_abs_diff={d.max():.3e} tier_mismatch={sum(a != b for a, b in zip(tiers, ref.expected_tier))} "
            f"alert_mismatch={int(((p > 25) != ref.expected_alert.to_numpy()).sum())}")
attempt("PortableForecaster end-to-end", e2e)

log("\n== (optional) original joblib, for comparison only ==")
if orig.exists():
    attempt("joblib.load(original dengue_xgboost_model.joblib)", lambda: type(joblib.load(orig)).__name__)
else:
    log("original joblib not in this folder; skipped")
(PKG / "diagnose_report.txt").write_text("\n".join(lines), encoding="utf-8")
log("\nWrote", PKG / "diagnose_report.txt")
