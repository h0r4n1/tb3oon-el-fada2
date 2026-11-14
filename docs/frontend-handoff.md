# Nebula frontend handoff · 14 November 2026 (Rover OS, Version 1.1)

The page is Naser's Rover OS interface (frontend commit `af3c7da`) restored on
top of the integrated route engine. Every route number comes from
`POST /api/routes`; the views only display and play back the engine's results.

## Flow

1. **Orbit**: NASA Mars globe, **Enter the expedition**, fullscreen button.
2. **Crew and region**: callsign (trimmed, max 24 characters, shown as text
   only). Jezero is available; Gale Crater and Utopia Planitia are preview
   cards that cannot start a mission.
3. **Jezero Surface Atlas**: circular Leaflet viewport (Mars Trek CTX imagery,
   recorded Perseverance traverse, 708 NASA waypoints, simulated base ⌂,
   three curated science targets ◆). Drag/pinch/scroll, **+ / −**,
   **Landing**, **Orbit**. **Find a NASA waypoint** searches by sol or
   site_drive id; the map flies to the point and opens the inspector.
   Ordinary waypoints are inspectable; only the curated targets plan routes.
4. **Target inspector**: coordinates, waypoint id, elevation (observed),
   science value and dwell time (editorial), NASA image with credit, sources,
   **Compare routes**.
5. **Route briefing**: selectable cards (click, tap, or arrow keys) with
   Recommended / Fastest / Science-focused badges from the engine's reasons,
   three scores (terrain safety, time, overall), distance, drive out/back,
   stop time, full trip, energy, coverage, the engine's "Return reserve" line,
   and blocked/unverified reasons. The selected card is drawn on the atlas
   (solid outbound, dashed return). Only a PASS card can start. Science detour
   cards can start directly; their stop order comes from the engine's reason.
6. **Descent → drive view**: the rover follows the selected candidate's real
   geometry. Since v1.2 a chase camera follows the rover from behind and
   the illustrative ground, rocks and hills are keyed to world coordinates, so
   they stream past in perspective (they do not move with the rover). Route ribbon and chevrons show only the path ahead, the guidance
   banner shows the next bend (from the real path), the radar shows the same
   path heading-up, and the rails show battery (% and kWh, reserve marker),
   the plan's return reserve, and the current elevation from the recorded
   traverse. A timestamped activity feed logs departure, bends, pauses, stops,
   replans, warnings, return and arrival. **Map** opens the atlas as a
   tracking map of the same mission.
7. **Add stop** (pauses): the engine re-plans from the rover's exact traverse
   vertex with the remaining time and battery; the panel compares trip, energy,
   return margin and science value. Accept replaces the plan; a blocked
   proposal shows the engine's reason with **Keep plan** or **Return to base**.
8. **Arrival → return**: dwell at each stop, **Destination reached**, **Plan
   return to base** (engine), the rover turns on the spot and drives home along
   `returnGeometry` toward the simulated lander, **Base reached**, summary,
   **New mission**.

Battery and elapsed time are one simulated clock: driving spends the leg's
engine kWh per engine minute plus the auxiliary draw; dwell spends the
auxiliary draw only; pause spends nothing. Playback speed (1×/3×/5×/10×/15×; 1× is real
time: one mission minute takes one real minute) never changes a route cost. There is no oxygen, temperature or weather display
because there is no data for them.

## Demo script (tested in headless Chrome, desktop, tablet and phone)

Enter the expedition → callsign → Open Jezero atlas → chip "Sol 130" → Compare
routes (Direct route PASS 97/82/92, + South Séítah PASS, + Sol 352 BLOCKED) →
Start mission → Begin drive → Add stop → South Séítah (PASS, return margin
+72.3 → +24.4 min) → Accept → Add stop → Sol 352 (BLOCKED, ~32 min short) →
Keep plan → Resume, playback 15× → science stops → Plan return to base →
Drive home → summary → New mission.

## Files

- `index.html`: screens and HUD markup.
- `src/ui/app.js`: flow, engine requests, mission state and HUD.
- `src/ui/scene.js`: canvas orbit backdrop, illustrative terrain, route
  ribbon, rover, lander and radar (artwork from Naser's Rover OS).
- `src/ui/local-path.js`: converts route coordinates to local metres for the
  drive view, guidance and radar (display only; tested in
  `tests/local-path.test.js`).
- `styles.css` (Naser's Rover OS styles) + `src/ui/rover-os.css` (additions).
- `src/ui/api-client.js`, `src/ui/adapters/mars-map.js`, `src/map.js`: API
  client and Leaflet atlas (Naser/Zain).

## Data and assets

- `public/map-data/waypoints.geojson`, `traverse.geojson`: local copies of the
  [NASA Mars 2020 waypoints](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json)
  and [traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json)
  for display. HUD elevations come from `GET /api/map-data/rover-path`
  (same NASA traverse with per-vertex elevations; values above −100 m are the
  dataset's no-data marker and are shown as Unknown).
- `assets/jezero-ctx.png`: mosaic from
  [NASA Mars Trek's Jezero CTX layer](https://trek.nasa.gov/tiles/Mars/EQ/Jezero_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml),
  matrix set `default028mm`, zoom 12, rows 1625–1630, columns 5851–5860.
- `assets/mars.jpg`: [NASA Mars globe](https://science.nasa.gov/resource/mars-planet-globe/).
- Target 9_5676 image: Perseverance Right Navcam, sol 352
  ([NASA raw images](https://mars.nasa.gov/mars2020/multimedia/raw-images/NRF_0352_0698200016_930ECM_N0095676NCAM03352_07_195J)),
  credit NASA/JPL-Caltech.
- Leaflet 1.9.4 (BSD-2-Clause) under `assets/vendor/leaflet`. Fonts: Barlow
  Condensed and Space Grotesk from Google Fonts (OFL).
- The terrain, rover and lander drawings are procedural illustrations,
  labelled "Illustrative terrain"; they are not NASA imagery.

## AI assistance

Interface design and the original canvas artwork: Naser (team). The 14 Nov
restore onto the route engine (`index.html`, `src/ui/app.js`,
`src/ui/scene.js`, `src/ui/local-path.js`, `src/ui/rover-os.css`) was written
by Claude Code (Anthropic) at Abood's direction, following the team's
restoration handoff. No images or data were AI-generated.
