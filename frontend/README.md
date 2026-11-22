# Dengue Outlook: frontend

React + TypeScript dashboard for the ward-level dengue forecasting API in `../backend`.

> **Historical replay only.** Every number comes from a trained model replayed on bundled
> data that ends 2025-12-29. This is a hackathon prototype, **not a live public-health
> alert system**, and its outputs are **not verified real-world warnings**.

The model estimates the **combined** dengue cases for weeks +2 to +4 after an issue week
(one number for the three weeks, not three weekly forecasts).

## Windows 10 setup (PowerShell)

Verified with Node.js 24.11.1 and npm 11.6.2; other versions were not tested.

```powershell
cd frontend          # from the repository root
npm install
```

After install the app needs no internet: the Latin fonts are bundled from npm packages and the hero
image is a local file (`public/images/dengue-hero-bg.webp`); there are no external fonts, images,
map tiles or analytics. Bangla text uses a font already installed on the device (for example Nirmala UI
on Windows); no Bangla font file is bundled yet, so its appearance can vary between devices.

## Start everything

1. Backend, in one terminal opened at the repository root. Create and activate the Python environment
   first as described in the [root README](../README.md) and `../backend/README.md`:

   ```powershell
   cd backend
   python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
   ```

2. Frontend, in a second terminal opened at the repository root (after `npm install` above):

   ```powershell
   cd frontend
   npm run dev
   ```

3. Open <http://127.0.0.1:5173>. The backend's CORS allow-list already includes this origin.

The API base URL defaults to `http://127.0.0.1:8000`. To change it, copy `.env.example`
to `.env.local` and edit `VITE_API_BASE_URL` (the backend must allow the frontend's origin
via `DENGUE_CORS_ORIGINS`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 127.0.0.1:5173 |
| `npm run typecheck` | Strict TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Vitest + Testing Library (offline, API faked); 112 tests in 3 files, including the validation dashboard |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run preview` | Serve the production build on 127.0.0.1:5173 |

On Windows, run the commands from PowerShell using the normal drive-letter path (for example
`D:\...`). Under Git Bash with a lower-case `/d/...` working directory, Vitest failed to start
("failed to find the current suite") on the author's machine.

## What the dashboard shows

- **Header:** product identity, an **English | বাংলা** switch, the selected issue week, and the "Not a live
  warning system" historical-replay notice. A subtle AI-generated illustration sits behind the header (see
  "Hero image" below).
- **Selectors:** city corporation, ward (filtered by city) and issue week, all populated
  from `GET /meta`. Only Mondays between the first and last valid week are offered.
- **Ward forecast card:** the estimated combined cases for weeks +2 to +4 (one total, never three weekly values),
  the weeks it covers, the risk tier (colour, letter and word) on a four-band scale with its boundaries, and the
  early alert (raised when the estimate is above the threshold from `/meta`, 25). The model estimate is shown beside
  the **observed later (historical comparison)** value, with the difference, when the data has one. Observed values
  are never model inputs.
- **What shaped this estimate:** the model's own attribution groups from the API, split into groups that pushed the
  estimate up and groups that pulled it down (largest first, signs and values unchanged), each with a one-line
  plain-language description, and a collapsed technical-detail box. They describe how the model reached its number,
  not causes of dengue.
- **Five city-wise ward bar charts:** one chart per city corporation (10, 20, 20, 5 and 5 wards, 60 bars in total).
  The X axis is the ward number; the Y axis is the predicted combined cases for the selected issue week, on one scale
  shared by all five charts. Bars use the API's risk tier colours with a worded legend, early-alert wards get a bell
  and a dashed line marks the alert threshold. Hover or keyboard focus shows a tooltip (ward, cases, tier, alert);
  clicking a bar selects that ward. The selected bar is outlined with a dark label so it does not depend on colour
  alone. On narrow screens the 20-ward charts scroll sideways instead of shrinking the labels. The charts are
  **not a map**: bar order has no geographic meaning.
- **All-ward summary and list:** wards per risk tier, a per-city breakdown, and the searchable, sortable ward list
  below the charts. Selecting a ward anywhere updates the forecast card.
- **Chronological validation dashboard** ("How the model performed on held-out weeks", above the methodology):
  - A **Test (held out) / Validation** selector (Test is the default) and a **MAE / RMSE** switch.
  - A **weekly error chart**: one bar per issue week in time order, each the error across that week's 60 ward
    predictions, in combined cases (not percentages). The chart is keyboard-operable (arrow keys, Home, End) and
    its selected-week marker does not rely on colour alone.
  - **Pooled reference metrics** for the chosen period (headline figures plus a dashed reference line). Pooled RMSE
    is not the mean of the weekly RMSE values.
  - An **accessible weekly-value table**, in a collapsed "Show the weekly values as a table" block.
  - A separately labelled **yearly rolling-origin panel** (2020 to 2025), from a different training scheme and never
    mixed with the Validation or Test figures.
  - English and Bangla text (the Bangla wording is not natively reviewed).
  - On the Validation split, a note that validation also helped choose the model and the alert threshold, so
    results may be optimistic; the held-out Test period is the primary evidence.

  It shows saved historical evaluation errors only. It performs no live validation, inference or training, the
  data appear to be simulated, and there are no prediction intervals, so it does not demonstrate real-world accuracy.
- **Methodology and limits:** four short blocks (how the model works, understanding the forecast, risk tiers and
  the early alert, accuracy and limits) with expandable technical detail. The false-alert counts, the lack of
  prediction intervals, the uncertain data provenance and the non-causal nature of TreeSHAP stay visible.

## Language

The switch in the header changes every user-facing string between English and Bangla (labels, tooltips,
tier names, errors, the methodology and screen-reader text). Translations live in `src/i18n/dict.ts` (one typed
dictionary per language) and are applied by `src/i18n/I18n.tsx`. Switching does not reload the page, keeps the
selected city, ward, week and search text, and makes no new API requests; the choice is remembered in the browser.
Numbers and dates are shown with Bangla digits and month names in Bangla; ward ids and API values are unchanged.
The Bangla wording has not been reviewed by a native speaker. Backend-written messages (for example a model-input
warning) are English only and stay in English inside the Bangla page.

## Hero image

`public/images/dengue-hero-bg.webp` is an illustrative, **AI-generated** background (made with OpenAI ChatGPT image
generation; the prompt was not recorded) shown at 55% opacity over the deep teal, which is also the fallback if the image does not load. It is not
a photograph of a real outbreak, and no photographic source or licence is claimed. The unoptimised original is kept as
`frontend/heropic.png` and is not used by the app.

## Validation data file

The validation dashboard reads one static, locally served file, `public/validation/weekly_errors.json`
(fetched from `validation/weekly_errors.json` under the app's base URL). It is **not** produced by the backend and
there is no new API endpoint. It is generated from the existing saved evaluation predictions in `../ml/eval/` by
`../ml/tools/export_validation_errors.py`, which recomputes the weekly and pooled MAE and RMSE; no model is loaded or
retrained. From the repository root:

```powershell
python ml/tools/export_validation_errors.py            # regenerate and overwrite the JSON
python ml/tools/export_validation_errors.py --check    # read-only: confirm the committed JSON is up to date
```

The page checks the file before using it (schema version, Monday dates in order, first and last weeks, prediction
counts, target offsets of 14, 21 and 28 days, and finite non-negative metrics). If the file is missing or fails
a check, the section shows a "The saved evaluation data is not available" message instead of partial charts. The files in
`../ml/eval/` must stay unchanged. See "Chronological validation dashboard" in the [root README](../README.md) for
the evaluated periods and pooled values.

## Tests

`npm test` runs 112 tests in 3 files (the API client and validation, the original dashboard behaviour, and
`src/redesign.test.tsx` for the forecast card, the five charts, the methodology, the English/Bangla switch and the
validation dashboard, including its malformed-data checks). For the redesigned frontend with the validation dashboard (local commit `ba34cac`), all 112 passed,
with `typecheck`, `lint` and `build` also passing; these were re-run before that commit was created and not again for this documentation update. The
exporter has its own 12 tests (`python -m pytest ml/tools/tests -q -p no:cacheprovider` from the repository root).
Earlier milestones: the published frontend had 34 tests and the redesign had 67 (verified before it was committed).
The 61.2-second fresh-clone timing in the root README was measured on the earlier 34-test frontend (commit `922f1b8`),
not on the redesign or the validation dashboard.

## How it talks to the backend

Read-only `GET` requests only: `/meta`, `/forecast/{ward_id}` and `/forecast` (plus the static validation file
described above, which is served by the frontend itself, not the backend). Responses
are checked at runtime (`src/api/validate.ts`); a malformed response shows an error
instead of partial data. Requests time out after 15 s. Risk tiers, alerts and all
forecast numbers are taken from the API unchanged; the frontend does no classification.
Newer selections cancel older requests, and late responses from older selections are
discarded.

States handled: loading, backend unreachable, model unavailable (503), per-request
errors with Retry, and empty results.

## Not included

No authentication, database, live data, notifications, map, hosted services or bundled Bangla font file.
