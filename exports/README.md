# Sample dispatch exports

These files are **samples of draft planning briefs**. They are marked DRAFT / NOT SENT, SIMULATED PLANNING SCENARIO,
HISTORICAL REPLAY and HUMAN VERIFICATION REQUIRED. Nothing in them has been sent, dispatched, transferred or
authorised. They contain no recipients, phone numbers, contacts or links.

| File | Content | Request |
| --- | --- | --- |
| `city_dispatch_sample.html` | Printable A4 city brief, all sections, detailed | Scenario A, `scope=city&city=Dhaka South&audience=all&variant=detailed&format=html` |
| `ward_dispatch_sample.txt` | Ward brief: short SMS-style text, then detailed WhatsApp-ready text | Scenario A, `scope=ward&ward_id=DSCC_Ward_04&audience=all&format=text` |
| `hospital_overflow_sample.txt` | City hospital overflow brief: short, then detailed | Scenario B, `scope=city&city=Dhaka South&audience=hospital&format=text` |

The text files start with a short header and show the exact `GET /dispatch-brief` request above each variant.

## Scenarios

| Parameter | Scenario A (city and ward) | Scenario B (hospital) |
| --- | --- | --- |
| `issue_date` | 2025-07-28 | 2023-08-07 |
| `stock_pct` (hypothetical saline and kit stock) | 60 | 100 (default) |
| `min_coverage_pct` | 30 | 30 (default) |
| `total_crews` (hypothetical regional budget) | 40 | 60 (default) |
| `capacity_pct` (hypothetical bed capacity) | 75 | 75 |
| `intervention_scenario` (assumed effect) | base | base (default) |
| Scenario ID | `DO-20250728-S60-F30-C40-H75-IBASE-WC` | `DO-20230807-S100-F30-C60-H75-IBASE-WC` |

Scenario IDs encode the issue week (`DO-YYYYMMDD`), stock (`S`), minimum coverage floor (`F`), regional crews (`C`),
bed capacity (`H`), intervention scenario (`I`) and the weekly split source (`WC` weekly companion model, `WE` equal
split fallback). Document IDs add the scope, audience and variant, for example
`DO-20250728-S60-F30-C40-H75-IBASE-WC.CITY-DHAKA-SOUTH.ALL.DETAILED`.

Scenario B's issue week is before 2024, so its capacity baseline (calibrated on 2016-2023) is **retrospective**:
it uses years after the issue week. Both text variants and the warnings state this.

## How the values are produced

All figures come from the local model and the existing planning engines, through the public endpoint:
one Phase 1 forecast run with the weekly companion, then the Task 2 allocation, Task 3 hypothetical hospital
routing and Task 4 assumed-effect simulation for the same issue week and parameters. No value is typed by hand.

Bed figures are bed planning units, not patients. Stock, crews and capacity are hypothetical scenario inputs.
Intervention effects are assumptions, not causal estimates.

## Regenerate or check (offline)

From the repository root, with the backend environment active:

```
python backend/scripts/generate_exports.py --check   # recompute in memory, compare byte for byte, write nothing
python backend/scripts/generate_exports.py --write   # explicitly rewrite the three sample files
```

The generator calls the endpoint in-process (no network, no hosted API). The output has no timestamps or machine
paths, is UTF-8 with LF line endings, and `.gitattributes` keeps LF in every checkout so `--check` stays
byte-exact.

## PDF

No PDF is committed. Open `city_dispatch_sample.html` in a browser and use Print, then Save as PDF. Turn off the
browser's headers and footers so no local address or time is printed. The HTML has no scripts, fonts, images or
links and works offline as a standalone file.
