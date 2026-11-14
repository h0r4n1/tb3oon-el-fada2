# Backend handoff

Adi owns TypeScript API handlers and integration. Abood owns the JavaScript route
engine. Zoubi owns the plain HTML/CSS/JavaScript frontend. The data teammate owns
`data/` and Python preparation under `scripts/`.

## Abood

Replace the placeholder in `server/route-engine.js`, preserving this export:

```js
export async function planRoutes(request) {
  // Return { requestId, dataVersion, candidates, errors }.
}
```

This runs on Node, so do not use `window`, `document`, browser storage or Leaflet.
Use `loadJsonData` from `./data.ts` for server-side JSON. TypeScript types and the
runtime schemas are in `server/contracts.ts`; request/result field names follow
the team brief. `errors` is initially an array of readable strings. Candidate
geometries use [longitude, latitude], while coordinate objects use {lat, lon}.

The API validates input, region/version, coverage, base and result shape. Abood
still owns every route calculation, terrain/stop validation, return feasibility,
reserve check, unknown-data classification, ranking and score. Shape validation
does not establish that a route is feasible. Do not replace missing terrain with
zero or report an unverified route as pass.

Mission config keys and proposed values are in `server/config.ts`. The backend
supplies this config; client overrides are ignored. These are prototype
assumptions, not validated rover limits. Remaining time and battery are supplied
by the browser's simulated mission state; this is not a trusted telemetry system.

## Frontend

Use relative URLs so frontend and API share the same deployed origin:

```js
const regionResponse = await fetch('/api/region');
const region = await regionResponse.json();
if (!regionResponse.ok) throw new Error(region.error.message);

const response = await fetch('/api/routes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId: crypto.randomUUID(),
    regionId: region.id,
    dataVersion: region.dataVersion,
    origin: region.base,
    stopIds: [],
    destination: selectedDestination, // {lat, lon}, inside real coverage
    base: region.base,
    remainingMinutes: 120,
    currentBatteryKWh: 10
  })
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
```

Replace initial budgets with current simulation budgets during replanning. Only
accept responses matching the latest requestId/dataVersion. `GET /api/config`
exposes the current assumptions. `GET /api/health` means the API process is alive;
it does not mean the engine or datasets are ready.

Until integration, missing data returns 503 DATA_NOT_READY; after region data is
supplied, the placeholder planner returns 503 ENGINE_NOT_READY. No fake route is
returned. Bad JSON/input returns 400, wrong content type 415, oversized requests
413, wrong methods 405, stale region data 409, and out-of-coverage/base errors 422.
API errors have `{requestId?, error: {code, message, details?}}`.

## Zain: read-only map layers

The map API exposes the team's uploaded GeoJSON directly, without a `data`
wrapper:

| Endpoint | Source file | Geometry |
| --- | --- | --- |
| `GET /api/map-data/waypoints` | `data/map-layers/waypoints_2d.geojson` | 2D Point FeatureCollection |
| `GET /api/map-data/rover-path` | `data/map-layers/rover_path_2d.geojson` | 2D LineString FeatureCollection |

Both responses use `Content-Type: application/geo+json` and contain GeoJSON
directly, without an envelope. The generated 2D coordinates, feature properties
(including `elev_geoid` and `elevations`) and any root metadata are preserved.
The backend checks the expected collection/geometry structures and requires
exactly two values per position, without reprojecting the data or verifying
planetary reference frames. Coordinate/provenance validation
remains a joint map/data task. A rover traverse is source mission data, not a
computed crewed-rover route or a verified terrain-safety result.

These endpoints work independently of `/api/region` and Abood's route engine.
Missing files return `503 DATA_NOT_READY`; malformed JSON or unexpected layer
structure returns `503 INVALID_DATA`. Only these two layer names are exposed.

```js
async function fetchMapLayer(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error.message);
  return body;
}

const [waypoints, roverPath] = await Promise.all([
  fetchMapLayer('/api/map-data/waypoints'),
  fetchMapLayer('/api/map-data/rover-path')
]);

L.geoJSON(waypoints).addTo(map);
L.geoJSON(roverPath).addTo(map);
```

Use the map module's own styling, layer toggles and error states. Relative paths
assume frontend/API share an origin; use the combined local server or a dev proxy
when testing from a different frontend server. No cross-origin policy has been
added. Vercel wrappers are under `api/map-data/`, and `vercel.json` includes the
`data/map-layers/**` in those function bundles. Run
`python scripts/make_map_layers.py` to regenerate the two files in that folder.
Missing 2D files return 503; the API does not fall back to original 3D datasets.

## Vercel (deployment status must be verified in the account)

Import the repository as one project with the repository root as Root Directory,
Framework Preset Other, Node 24.x, build command `npm run build`, and output
directory `dist`. `vercel.json` records the build configuration and includes
`data/` in the relevant function bundles. API handlers are in root `api/`.

The static build copies frontend assets only. It currently maps the existing
`idex.html` to `dist/index.html`; a future source `index.html` takes precedence.
Keep server code in `server/`, never `src/` or `public/`.

Sources: https://vercel.com/docs/functions/runtimes/node-js and
https://www.typescriptlang.org/tsconfig/allowJs.html .

AI assistance: the initial backend scaffold, validation, build support and tests
were generated with Codex. Record subsequent human/AI contributions in the team
submission notes.

## 14 Nov change: shared server modules are plain JavaScript

Vercel compiles `.ts` files to `.js` but does not rewrite `./x.ts` imports
inside plain `.js` files, so every API function crashed in production
(`FUNCTION_INVOCATION_FAILED`). `server/config.js`, `errors.js`, `data.js` and
`map-data.js` are therefore plain JavaScript (same behaviour, types in JSDoc);
`loadRegion` moved into `server/app.ts`. `data.js` finds `data/` relative to
its own file so Vercel bundles it. Rule: **a `.js` file must never import a
`.ts` file.** `vercel.json` bundles `data/**` with every API function.
Production: https://tb3oon-el-fada2.vercel.app (change made by Claude Code at
Abood's direction).
