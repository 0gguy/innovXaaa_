"""Weekly companion: splits the Phase 1 3-week total into weeks t+2, t+3 and t+4.

Phase 1 (unchanged, authoritative) predicts ONE number per ward and issue week t: the total
dengue cases in weeks t+2, t+3 and t+4. This companion adds how that total is spread over the
three weeks:

    1. three XGBoost regressors (one per week h = 2, 3, 4) predict cases in week t+h from the
       SAME 95 input columns as Phase 1 (ml/features.py, feature set 1.0.0);
    2. their outputs are clipped at 0 and rescaled so the three weeks add up EXACTLY to the
       Phase 1 total (`reconcile`). Phase 1 numbers, tiers and alerts can therefore never change.

If the companion cannot be loaded, `equal_split` gives the documented fallback: total / 3 per week.

Provenance: Asir's companion models, reviewed copy `ml_handoff_reviewed` (ZIP SHA-256
6a00b9518871923b415530a49ed175a54d3688cf9d4e79357ae947734f3cbf13), inference/weekly_model.py.
Model files are byte-identical to that package (artifacts/SHA256SUMS). Not retrained here.

Integrity checks before a model is used:
  * SHA-256 of every model file against artifacts/SHA256SUMS (bytes are hashed, then loaded from
    the same bytes, so the file cannot change between check and load);
  * numeric feature names/order and feature-set version against Phase 1 features.py;
  * city and ward categories against Phase 1's ward -> city map;
  * the 95 encoded column names against Phase 1's fitted preprocessor output names;
  * each booster's input width.
Native .ubj files via xgboost.Booster: no pickle, no scikit-learn, CPU only, no network.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

HORIZONS = (2, 3, 4)
ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
SOURCE_COMPANION = "companion"
SOURCE_EQUAL_SPLIT = "equal_split"


class WeeklyCompanionError(RuntimeError):
    """The companion cannot be used (integrity, compatibility or loading problem)."""


class ArtifactIntegrityError(WeeklyCompanionError):
    """A model file is missing or its SHA-256 differs from artifacts/SHA256SUMS."""


class FeatureMismatchError(WeeklyCompanionError):
    """Phase 1 features / categories / columns differ from what the companion was trained on."""


# --------------------------------------------------------------------------- artifacts
def load_config(artifacts_dir: str | Path = ARTIFACTS_DIR) -> dict:
    return json.loads((Path(artifacts_dir) / "weekly_config.json").read_text(encoding="utf-8"))


def read_manifest(artifacts_dir: str | Path = ARTIFACTS_DIR) -> dict[str, str]:
    """Parse SHA256SUMS ("<hex>  <relative path>" per line) into {relative path: hex}."""
    path = Path(artifacts_dir) / "SHA256SUMS"
    if not path.exists():
        raise ArtifactIntegrityError("SHA256SUMS manifest is missing")
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        digest, _, name = line.partition(" ")
        name = name.strip().lstrip("*")
        if len(digest) != 64 or not name:
            raise ArtifactIntegrityError("SHA256SUMS has a malformed line")
        out[name] = digest.lower()
    return out


def verified_model_bytes(artifacts_dir: str | Path, manifest: Mapping[str, str], h: int) -> bytes:
    """Bytes of models/weekly_w{h}.ubj, only if they match the manifest."""
    rel = f"models/weekly_w{h}.ubj"
    if rel not in manifest:
        raise ArtifactIntegrityError(f"{rel} is not listed in SHA256SUMS")
    path = Path(artifacts_dir) / rel
    if not path.exists():
        raise ArtifactIntegrityError(f"{rel} is missing")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest[rel]:
        raise ArtifactIntegrityError(f"{rel}: SHA-256 differs from SHA256SUMS (file altered or corrupted)")
    return data


# --------------------------------------------------------------------------- compatibility
def expected_column_names(cfg: dict) -> list[str]:
    """The 95 encoded columns in Phase 1 ColumnTransformer naming and order."""
    return ([f"num__{n}" for n in cfg["numeric_features"]]
            + [f"cat__city_{c}" for c in cfg["cities"]]
            + [f"cat__ward_id_{w}" for w in cfg["wards"]])


def check_compatibility(F, cfg: dict, ward_city: Mapping[str, str] | None = None,
                        phase1_column_names: Sequence[str] | None = None) -> None:
    """Fail loudly if Phase 1 drifted from what the companion was trained on."""
    if list(F.NUMERIC_FEATURES) != list(cfg["numeric_features"]):
        raise FeatureMismatchError("features.NUMERIC_FEATURES differs (names or order) from weekly_config.json")
    if str(getattr(F, "FEATURE_SET_VERSION", "")) != str(cfg["feature_set_version"]):
        raise FeatureMismatchError(
            f"feature set {getattr(F, 'FEATURE_SET_VERSION', None)} != companion feature set {cfg['feature_set_version']}")
    if list(F.CATEGORICAL_FEATURES) != ["city", "ward_id"]:
        raise FeatureMismatchError("Phase 1 categorical features are not ['city', 'ward_id']")
    if tuple(F.TARGET_HORIZON_WEEKS) != HORIZONS or tuple(cfg["horizons"]) != HORIZONS:
        raise FeatureMismatchError("forecast horizons differ from weeks 2, 3, 4")
    if ward_city is not None:
        if sorted(ward_city) != list(cfg["wards"]):
            raise FeatureMismatchError("companion ward categories differ from Phase 1 wards")
        if sorted(set(ward_city.values())) != list(cfg["cities"]):
            raise FeatureMismatchError("companion city categories differ from Phase 1 cities")
    if phase1_column_names is not None and [str(n) for n in phase1_column_names] != expected_column_names(cfg):
        raise FeatureMismatchError("companion column layout differs from the Phase 1 preprocessor output")


# --------------------------------------------------------------------------- math
def encode(feat: pd.DataFrame, cfg: dict) -> np.ndarray:
    """Numerics, then city one-hot, then ward one-hot (same layout as Phase 1). Unknown categories raise."""
    cities, wards = list(cfg["cities"]), list(cfg["wards"])
    unk_c = sorted(set(feat["city"].astype(str)) - set(cities))
    unk_w = sorted(set(feat["ward_id"].astype(str)) - set(wards))
    if unk_c or unk_w:
        raise ValueError(f"categories unseen in training: cities={unk_c[:5]} wards={unk_w[:5]}")
    num = feat[list(cfg["numeric_features"])].to_numpy(dtype=np.float32)
    if not np.isfinite(num).all():
        raise ValueError("non-finite feature values")
    city = (feat["city"].astype(str).to_numpy()[:, None] == np.asarray(cities)[None, :]).astype(np.float32)
    ward = (feat["ward_id"].astype(str).to_numpy()[:, None] == np.asarray(wards)[None, :]).astype(np.float32)
    return np.hstack([num, city, ward])


def reconcile(raw_weekly: np.ndarray, total: Iterable[float]) -> np.ndarray:
    """raw_weekly: (n, 3) model outputs; total: (n,) Phase 1 clipped 3-week totals.
    Returns (n, 3) non-negative weekly cases whose rows sum to `total`.
    Shares are max(raw, 0) / sum; equal thirds when every raw output is <= 0."""
    total = np.asarray(list(total) if not isinstance(total, np.ndarray) else total, dtype=float)
    if not np.isfinite(total).all() or (total < 0).any():
        raise ValueError("Phase 1 totals must be finite and >= 0")
    w = np.clip(np.asarray(raw_weekly, dtype=float), 0.0, None)
    if w.shape != (len(total), len(HORIZONS)):
        raise ValueError(f"raw weekly array has shape {w.shape}, expected ({len(total)}, {len(HORIZONS)})")
    s = w.sum(axis=1, keepdims=True)
    share = np.where(s > 1e-9, w / np.where(s > 1e-9, s, 1.0), 1.0 / len(HORIZONS))
    return share * total[:, None]


def equal_split(total: Iterable[float]) -> np.ndarray:
    """Fallback: total / 3 in each of weeks t+2, t+3, t+4."""
    total = np.asarray(list(total) if not isinstance(total, np.ndarray) else total, dtype=float)
    return reconcile(np.ones((len(total), len(HORIZONS))), total)


# --------------------------------------------------------------------------- companion
class WeeklyCompanion:
    """Loads the three weekly boosters once. Thread-safe for prediction (inplace_predict)."""

    def __init__(self, features_module=None, artifacts_dir: str | Path = ARTIFACTS_DIR,
                 ward_city: Mapping[str, str] | None = None,
                 phase1_column_names: Sequence[str] | None = None):
        import xgboost as xgb  # imported here so importing this module stays cheap

        if features_module is None:
            import features as features_module  # Phase 1 ml/features.py (reused, never copied)
        self.F = features_module
        self.artifacts_dir = Path(artifacts_dir)
        self.cfg = load_config(self.artifacts_dir)
        self.version = str(self.cfg["companion_version"])
        check_compatibility(self.F, self.cfg, ward_city, phase1_column_names)

        manifest = read_manifest(self.artifacts_dir)
        n_cols = len(expected_column_names(self.cfg))
        self.boosters = {}
        for h in HORIZONS:
            data = verified_model_bytes(self.artifacts_dir, manifest, h)
            b = xgb.Booster()
            try:
                b.load_model(bytearray(data))
            except Exception as exc:  # noqa: BLE001 - reported as a companion failure
                raise WeeklyCompanionError(f"weekly_w{h}.ubj could not be loaded: {type(exc).__name__}") from None
            b.set_param({"nthread": 1})  # deterministic, small footprint
            if b.num_features() != n_cols:
                raise FeatureMismatchError(f"weekly_w{h}.ubj expects {b.num_features()} columns, config gives {n_cols}")
            self.boosters[h] = b

    def raw_weekly(self, feat: pd.DataFrame) -> np.ndarray:
        """(n, 3) unreconciled model outputs for already-validated Phase 1 feature rows."""
        X = encode(feat, self.cfg)
        return np.column_stack([self.boosters[h].inplace_predict(X) for h in HORIZONS]).astype(float)

    def split(self, feat: pd.DataFrame, total: Iterable[float]) -> np.ndarray:
        """(n, 3) weekly cases for `feat` rows, reconciled to the Phase 1 `total` of each row."""
        if "features_complete" in feat and not bool(feat["features_complete"].all()):
            raise ValueError("incomplete feature rows (issue week + 4 previous weeks are required)")
        return reconcile(self.raw_weekly(feat), total)
