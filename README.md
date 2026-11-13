# Nebula | Mars Mission Planner

Plain HTML/CSS/JavaScript frontend with a TypeScript/Node.js API. Abood's
JavaScript route engine runs behind the API. Prepared JSON lives in `data/`;
Python preparation scripts live in `scripts/`.

## Run locally

Use Node.js **24.x**. From this repo directory:

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://localhost:3000 and http://localhost:3000/api/health . No Vercel
account, login, environment variables or deployment is needed to run locally.
The backend restarts when its modules change. To refresh the served frontend
after frontend edits, run `npm.cmd run build:frontend` in another terminal.
Stop the server with Ctrl+C. Set `$env:PORT = '3001'` before starting to use
another local port.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | API liveness, not data/engine readiness |
| `GET /api/config` | Disclosed prototype simulation assumptions |
| `GET /api/region` | Validated `data/region.json` |
| `POST /api/routes` | Validate request and call Abood's engine |
| `GET /api/map-data/waypoints` | 2D Point FeatureCollection from `data/map-layers/waypoints_2d.geojson` |
| `GET /api/map-data/rover-path` | 2D LineString FeatureCollection from `data/map-layers/rover_path_2d.geojson` |

The API returns **503** for missing/invalid datasets or the unimplemented route
engine. Map-data endpoints are independent of region and route-engine readiness.
They return GeoJSON directly, with 2D coordinates and elevation properties
preserved. Run `python scripts/make_map_layers.py` to regenerate the map layers
under `data/map-layers/`; original 3D datasets remain in `data/`.
The API does not fabricate NASA data or route results.
Tests use synthetic fixtures isolated under `tests/`.

See [backend-handoff.md](docs/backend-handoff.md) for request fields, ownership,
frontend integration and intended Vercel settings. Deployment is not configured
in the Vercel account yet. The current frontend is an early map shell; Zoubi's
frontend remains a separate team handoff.
