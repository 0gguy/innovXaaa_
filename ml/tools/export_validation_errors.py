"""Export chronological validation errors for the frontend dashboard (no retraining, no model calls).

Reads ONLY tracked evaluation artifacts in ml/eval/ (plus the target definition in ml/model_config.json),
recomputes per-issue-week MAE / RMSE and pooled MAE / RMSE, checks them against the metrics the project
already documents, and writes one small deterministic JSON file:

    frontend/public/validation/weekly_errors.json

Usage (from the repository root, no extra packages needed):

    python ml/tools/export_validation_errors.py            # write the JSON
    python ml/tools/export_validation_errors.py --check    # verify the committed JSON is up to date; writes nothing

Notes on what the numbers are
  * The saved predictions are the CLIPPED (as served) values, rounded to four decimals by the notebook.
    They are not raw model output. Errors are computed from them exactly as saved.
  * The target is one combined total of dengue cases for issue week t+2, t+3 and t+4 per ward, so every
    error is in combined cases, never a percentage and never a single forecast week.
  * validation: model trained on the training period only. test: model refitted on training + validation.
    rolling_origin: a separate scheme (retrained once a year); it is exported separately and never mixed.
  * Pooled metrics are computed across all rows of a split. They are NOT averages of weekly RMSEs.
Any violated invariant raises SystemExit with a message; nothing is written in that case.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "ml" / "eval"
CONFIG = ROOT / "ml" / "model_config.json"
OUT = ROOT / "frontend" / "public" / "validation" / "weekly_errors.json"

EXPECTED = {
    "validation": {"rows": 4380, "weeks": 73, "first": "2022-12-26", "last": "2024-05-13"},
    "test": {"rows": 4620, "weeks": 77, "first": "2024-06-17", "last": "2025-12-01"},
}
WARDS_PER_WEEK = 60
OFFSETS = [14, 21, 28]  # days from issue week t to the start of weeks t+2, t+3, t+4
# metrics_summary.json holds full-precision floats, but the saved predictions were rounded to 4 decimals, so a
# recomputed pooled MAE/RMSE can differ from them. Worst case is 5e-5 (every prediction off by half a unit in
# the 4th decimal in the same direction); in practice the errors cancel: the largest difference observed on the
# real files is 2.4e-6 (validation MAE) and the others are below 1e-6. 1e-5 is about 4x the largest observed
# difference and still far below any real discrepancy (a 0.001 change in a metric would be rejected).
METRIC_TOL = 1e-5
# rolling_origin_by_year.csv is itself rounded to 4 decimals, so its values can be off by 5e-5 before any
# prediction rounding is considered; 1e-4 is the smallest tolerance that cannot reject correctly rounded data.
YEAR_TOL = 1e-4
# The validation CSV labels its model; this must match the documented scheme (model_report.md section 4:
# validation is scored with a model trained on the training period only).
VALIDATION_MODEL_LABEL = "XGBoost trained on train period only"


def fail(msg: str):
    raise SystemExit(f"export_validation_errors: {msg}")


def read_rows(name: str, need: tuple[str, ...]) -> list[dict]:
    path = EVAL / name
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = [c for c in need if c not in (reader.fieldnames or [])]
        if missing:
            fail(f"{name} is missing columns {missing}")
        rows = []
        for i, r in enumerate(reader, start=2):
            try:
                rows.append(
                    {
                        "ward_id": r["ward_id"],
                        "issue_week": date.fromisoformat(r["issue_week"]),
                        "actual": float(r["actual_cases_3wk"]),
                        "pred": float(r["predicted_cases_3wk"]),
                        "model": r.get("model"),
                    }
                )
            except (ValueError, KeyError) as e:  # never skip a malformed row
                fail(f"{name} line {i}: malformed row ({e})")
            if not (math.isfinite(rows[-1]["actual"]) and math.isfinite(rows[-1]["pred"])):
                fail(f"{name} line {i}: non-finite value")
    return rows


def mae_rmse(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    n = len(pairs)
    if n == 0:
        fail("empty group")
    abs_sum = sum(abs(p - a) for a, p in pairs)
    sq_sum = sum((p - a) ** 2 for a, p in pairs)
    return abs_sum / n, math.sqrt(sq_sum / n)


def r6(x: float) -> float:
    return round(x, 6)


def build_split(name: str, rows: list[dict]) -> tuple[dict, frozenset]:
    exp = EXPECTED[name]
    if len(rows) != exp["rows"]:
        fail(f"{name}: expected {exp['rows']} rows, found {len(rows)}")
    by_week: dict[date, list[dict]] = {}
    for r in rows:
        if r["issue_week"].weekday() != 0:
            fail(f"{name}: issue week {r['issue_week']} is not a Monday")
        by_week.setdefault(r["issue_week"], []).append(r)
    weeks = sorted(by_week)
    if len(weeks) != exp["weeks"]:
        fail(f"{name}: expected {exp['weeks']} issue weeks, found {len(weeks)}")
    if weeks[0].isoformat() != exp["first"] or weeks[-1].isoformat() != exp["last"]:
        fail(f"{name}: date range {weeks[0]}..{weeks[-1]} differs from {exp['first']}..{exp['last']}")
    for a, b in zip(weeks, weeks[1:]):
        if (b - a).days != 7:
            fail(f"{name}: missing or irregular week between {a} and {b} (no weeks are interpolated)")
    weekly = []
    ward_set: frozenset = frozenset()
    for w in weeks:
        group = by_week[w]
        ids = [g["ward_id"] for g in group]
        if len(group) != WARDS_PER_WEEK or len(set(ids)) != WARDS_PER_WEEK:
            fail(f"{name}: {w} has {len(group)} rows / {len(set(ids))} distinct wards, expected {WARDS_PER_WEEK}")
        if w == weeks[0]:
            ward_set = frozenset(ids)
        elif frozenset(ids) != ward_set:
            fail(f"{name}: the ward set in week {w} differs from the ward set in week {weeks[0]}")
        mae, rmse = mae_rmse([(g["actual"], g["pred"]) for g in group])
        weekly.append({"issue_week": w.isoformat(), "mae": r6(mae), "rmse": r6(rmse), "n": len(group)})
    pooled_mae, pooled_rmse = mae_rmse([(r["actual"], r["pred"]) for r in rows])
    return {
        "first_issue_week": weeks[0].isoformat(),
        "last_issue_week": weeks[-1].isoformat(),
        "issue_weeks": len(weeks),
        "predictions": len(rows),
        "wards_per_week": WARDS_PER_WEEK,
        "pooled": {"mae": r6(pooled_mae), "rmse": r6(pooled_rmse)},
        "weekly": weekly,
    }, ward_set


def build_rolling(rows: list[dict]) -> list[dict]:
    by_year: dict[int, list[dict]] = {}
    for r in rows:
        if r["issue_week"].weekday() != 0:
            fail(f"rolling_origin: {r['issue_week']} is not a Monday")
        by_year.setdefault(r["issue_week"].year, []).append(r)
    keys = [(r["ward_id"], r["issue_week"]) for r in rows]
    if len(set(keys)) != len(keys):
        fail("rolling_origin: duplicate (ward, issue week) rows")
    out = []
    for year in sorted(by_year):
        group = by_year[year]
        mae, rmse = mae_rmse([(g["actual"], g["pred"]) for g in group])
        out.append({"year": year, "rows": len(group), "mae": r6(mae), "rmse": r6(rmse)})
    return out


def check_against_documented(splits: dict, rolling: list[dict]) -> dict:
    summary = json.loads((EVAL / "metrics_summary.json").read_text(encoding="utf-8"))
    refs = {
        "validation": (summary["validation"]["MAE"], summary["validation"]["RMSE"]),
        "test": (summary["test"]["MAE (clipped, as served)"], summary["test"]["RMSE (clipped, as served)"]),
    }
    checks = {}
    for name, (ref_mae, ref_rmse) in refs.items():
        got = splits[name]["pooled"]
        if abs(got["mae"] - ref_mae) > METRIC_TOL or abs(got["rmse"] - ref_rmse) > METRIC_TOL:
            fail(
                f"{name}: recomputed MAE/RMSE {got['mae']}/{got['rmse']} differ from "
                f"metrics_summary.json {ref_mae:.6f}/{ref_rmse:.6f} by more than {METRIC_TOL}"
            )
        checks[name] = {"documented_mae": round(ref_mae, 4), "documented_rmse": round(ref_rmse, 4)}
    with (EVAL / "rolling_origin_by_year.csv").open(newline="", encoding="utf-8") as f:
        ref_years = {int(r["test year"]): r for r in csv.DictReader(f)}
    for y in rolling:
        ref = ref_years.get(y["year"])
        if ref is None:
            fail(f"rolling_origin year {y['year']} is not in rolling_origin_by_year.csv")
        if int(ref["rows"]) != y["rows"] or abs(float(ref["XGBoost"]) - y["mae"]) > YEAR_TOL:
            fail(f"rolling_origin {y['year']}: rows/MAE differ from rolling_origin_by_year.csv")
    if sorted(ref_years) != [y["year"] for y in rolling]:
        fail("rolling_origin years differ from rolling_origin_by_year.csv")
    return checks


def check_target_definition() -> None:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    if cfg.get("horizon_weeks") != [2, 3, 4] or "t+2, t+3 and t+4" not in cfg.get("target_definition", ""):
        fail("model_config.json no longer defines the combined t+2/t+3/t+4 target")


def build() -> dict:
    check_target_definition()
    val_rows = read_rows("validation_predictions.csv", ("ward_id", "issue_week", "actual_cases_3wk", "predicted_cases_3wk"))
    test_rows = read_rows("test_predictions.csv", ("ward_id", "issue_week", "actual_cases_3wk", "predicted_cases_3wk"))
    roll_rows = read_rows("rolling_origin_predictions.csv", ("ward_id", "issue_week", "actual_cases_3wk", "predicted_cases_3wk"))
    labels = {r["model"] for r in val_rows}
    if labels != {VALIDATION_MODEL_LABEL}:
        fail(f"validation model label {sorted(map(str, labels))} does not match the documented scheme {VALIDATION_MODEL_LABEL!r}")
    val_split, val_wards = build_split("validation", val_rows)
    test_split, test_wards = build_split("test", test_rows)
    if val_wards != test_wards:
        fail("the validation and test ward sets differ")
    splits = {"validation": val_split, "test": test_split}
    if splits["validation"]["last_issue_week"] >= splits["test"]["first_issue_week"]:
        fail("validation and test issue weeks overlap or are out of order")
    val_weeks = {r["issue_week"] for r in val_rows}
    if val_weeks & {r["issue_week"] for r in test_rows}:
        fail("validation and test share an issue week")
    rolling = build_rolling(roll_rows)
    check_against_documented(splits, rolling)
    splits["validation"].update(
        {
            "evaluation_scheme": "Chronological split with a 4-week purge. Model trained on the training period only (issue weeks up to 2022-11-21).",
        }
    )
    splits["test"].update(
        {
            "evaluation_scheme": "Chronological split with a 4-week purge. Model refitted on training plus validation; the later held-out test period provides the primary reported evaluation.",
        }
    )
    return {
        "schema_version": 1,
        "model_version": json.loads((EVAL / "metrics_summary.json").read_text(encoding="utf-8"))["model_version"],
        "error_unit": "Combined dengue cases over forecast weeks t+2, t+3 and t+4 (one total per ward and issue week). Not a percentage and not a single week.",
        "prediction_basis": "Clipped (as served) predictions saved to four decimals in ml/eval. Not raw model output.",
        "pooled_metric_basis": "Pooled across every ward prediction in the split. Not an average of weekly values.",
        "data_provenance_note": "The bundled dataset's real-world provenance is uncertain and the project report finds it appears simulated. These are errors on that dataset, not verified real-world surveillance accuracy.",
        "target_window_offset_days": OFFSETS,
        "splits": splits,
        "rolling_origin": {
            "evaluation_scheme": "Annual rolling origin: the model is retrained for each year on earlier weeks and tested on that calendar year. A different procedure from the validation and test splits; not comparable week by week.",
            "years": rolling,
        },
    }


def render(data: dict) -> str:
    return json.dumps(data, indent=1, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    text = render(build())
    if "--check" in argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            fail(f"{OUT.relative_to(ROOT)} is missing or out of date; rerun without --check")
        print("up to date:", OUT.relative_to(ROOT))
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print("wrote", OUT.relative_to(ROOT), f"({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
