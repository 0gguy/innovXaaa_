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

After install the app needs no internet: fonts are bundled from npm packages (no external
fonts, images, map tiles or analytics).

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
| `npm test` | Vitest + Testing Library (offline, API faked) |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run preview` | Serve the production build on 127.0.0.1:5173 |

On Windows, run the commands from PowerShell using the normal drive-letter path (for example
`D:\...`). Under Git Bash with a lower-case `/d/...` working directory, Vitest failed to start
("failed to find the current suite") on the author's machine.

## What the dashboard shows

- **Header:** product identity, a "Historical replay" badge, the selected issue week, and
  the backend's own limitation notice.
- **Selectors:** city corporation, ward (filtered by city) and issue week, all populated
  from `GET /meta`. Only Mondays between the first and last valid week are offered.
- **Ward forecast:** predicted combined cases, risk tier (colour, letter and word), early
  alert (raised when predicted combined cases are above the threshold from `/meta`, 25),
  the forecast window, and the **observed later (historical comparison)** outcome when
  the data has one. Observed values are never model inputs.
- **What shaped this estimate:** the model's own attribution groups (rainfall, humidity,
  temperature, recent cases, ward vulnerability, season, identity) from the API, shown as
  diverging bars. They describe how the model reached its number, not causes of dengue.
- **All-ward overview:** wards per risk tier, a per-city breakdown, a non-geographic
  **ward register** (one tile per ward), and a searchable, filterable list ordered by
  predicted cases. Selecting a ward anywhere updates the detail panel.
- **Methodology and limits:** what the model is, the data window, provisional tiers, and
  the documented false-alarm and bias limitations.

## How it talks to the backend

Read-only `GET` requests only: `/meta`, `/forecast/{ward_id}` and `/forecast`. Responses
are checked at runtime (`src/api/validate.ts`); a malformed response shows an error
instead of partial data. Requests time out after 15 s. Risk tiers, alerts and all
forecast numbers are taken from the API unchanged; the frontend does no classification.
Newer selections cancel older requests, and late responses from older selections are
discarded.

States handled: loading, backend unreachable, model unavailable (503), per-request
errors with Retry, and empty results.

## Not included

No authentication, database, live data, notifications, map or hosted services.
