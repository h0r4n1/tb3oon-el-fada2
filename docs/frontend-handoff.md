# Nebula frontend handoff · 14 November 2026 (demo version)

The page runs the full demo story using only route-engine results:

1. **Intro** → **callsign** (trimmed, max 24 characters, shown as text only) and
   **region**: Jezero is the only operational region; Gale Crater and Utopia
   Planitia are preview cards that cannot start a mission.
2. **Map**: NASA Mars Trek Jezero CTX imagery, the recorded Perseverance
   traverse and 708 waypoints (observed), the simulated base, and the three
   science targets from `data/targets.geojson`.
3. **Target inspector**: coordinates and waypoint id (observed), science value
   and stop time (editorial), NASA image with credit, source links.
4. **Route comparison**: `POST /api/routes` from base to the target. Cards show
   the engine's distance, drive out, stops, drive back, round-trip energy,
   S/U/C scores, slope-data coverage, the "Return reserve" line and the
   engine's reasons. The recommended route is first; detour suggestions and
   non-eligible (blocked / unverified preview) routes are listed separately.
   Only `pass` routes can be started.
5. **Simulated drive**: the rover marker moves along the candidate's real
   geometry on the 2D map. Elapsed time and battery are spent at the
   engine's own rates for the active plan (drive kWh/min + auxiliary draw;
   stops use auxiliary draw only). Pause/resume, speed (1×/3×/10×, playback
   only), recenter.
6. **Propose a science stop** (pauses): the engine re-plans from the rover's
   current position (an exact traverse vertex) with the current budget. The
   panel compares the engine's return reserve before and after. Accept replaces
   the plan; Cancel keeps it. A blocked proposal shows the engine's reason and
   offers "Return to base instead".
7. **Arrival** → **return to base**: the engine plans the drive home from the
   current position; the rover follows the return geometry.
8. **Mission summary**: stops, science value, simulated time and battery,
   accepted changes and the proposals the engine rejected.

"Sources & limits" (top right) lists datasets, image credits, prototype
assumptions (read live from `/api/config`), limitations, the label legend and
the AI-assistance note.

## Demo script (tested in headless Chrome, 14 Nov)

Callsign → Jezero → "Sol 130 drive observation" (5_0) → Compare routes
(PASS, return reserve 72 min / 6.7 kWh) → Start → Propose "South Séítah entry"
(PASS, reserve drops to ~24 min / 5.0 kWh) → Accept → Propose "Sol 352 terrain
survey" (BLOCKED: "Not enough time ... short by ~32 min") → Keep current plan →
Resume (speed 10×) → arrive → Plan return → Drive home → summary.

## Files

- `index.html`, `src/ui/app.js` (flow and simulation), `src/ui/mission.css`
  (styles), `src/ui/api-client.js` (same-origin API, discards stale responses),
  `src/ui/adapters/mars-map.js` + `src/map.js` (Leaflet map, imagery, traverse,
  waypoints).
- The older `styles.css` and the procedural 3D scene are no longer used by the
  page (3D terrain was cut for the demo).

## Data and assets

- `public/map-data/waypoints.geojson` and `traverse.geojson`: local copies of the
  [NASA Mars 2020 waypoints](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json)
  and [traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json),
  used for display only (the engine reads `data/map-layers/`).
- `assets/jezero-ctx.png`: local mosaic from
  [NASA Mars Trek's Jezero CTX layer](https://trek.nasa.gov/tiles/Mars/EQ/Jezero_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml),
  matrix set `default028mm`, zoom 12, rows 1625–1630, columns 5851–5860.
- `assets/mars.jpg`: [NASA Mars globe](https://science.nasa.gov/resource/mars-planet-globe/).
- Target 9_5676 image: Perseverance Right Navcam, sol 352
  ([NASA raw images](https://mars.nasa.gov/mars2020/multimedia/raw-images/NRF_0352_0698200016_930ECM_N0095676NCAM03352_07_195J)),
  credit NASA/JPL-Caltech; matched to the waypoint by the site/drive id in the
  image name.
- Leaflet 1.9.4 (BSD-2-Clause) is bundled under `assets/vendor/leaflet`.

## AI assistance

The 14 Nov demo frontend (`index.html`, `src/ui/app.js`, `src/ui/mission.css`)
was written by Claude Code (Anthropic) at Abood's direction, replacing the
earlier frontend by Naser/Zain (whose map adapter, API client, imagery and
data layers are reused). No images or data were AI-generated.
