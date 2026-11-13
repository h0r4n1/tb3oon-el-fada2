# Naser frontend integration — 13 November 2026

Branch: feat/naser-rover-ui, based on merged main/backend PR #2. Adi owns review and merge. No backend/route-engine implementation was replaced.

## Current deployment layout
- index.html / styles.css: immersive screen flow and styles.
- src/ui/app.js: UI, illustrative scene, atlas and playback.
- src/ui/api-client.js: same-origin API adapter, explicit errors, timeout, request/version freshness.
- assets/: NASA reference photos, panorama resized for web use.
- src/main.js: Zain's original map module, preserved unchanged.
- map-preview.html / map-preview.css: Zain's original screen retained for map integration.
- server/, api/, data/, tools/: team-owned backend and build, unchanged.

Run Node 24, npm ci, npm run dev; open http://localhost:3000 . After UI edits npm run build:frontend. Vercel uses repository root, npm run build, dist; DO NOT set ui/ as deployment root. This supersedes earlier local-prototype handoffs. Frontend adds no npm dependencies. Existing zod/TypeScript dependencies belong to the merged backend. Optional Google Fonts remain external; system fallback is available.

The old /ui static prototype is local-only and not submitted. The supported entry is root index.html through the combined server.

## Working API connection
Route briefing has a Team API section. It reads /api/config and /api/region, accepts an explicit geographic destination and POSTs /api/routes. Origin/base come from region metadata. Initial budgets come from server config. Current code displays returned candidates and failures; it does NOT yet drive the illustrative rover using API geometry. No simulated sector marker is passed off as a verified geographic coordinate. No automatic fallback disguises failed requests. DATA_NOT_READY / ENGINE_NOT_READY and stale versions are explicit.

## Navigation clarity
Demo path now has a finite end. Remaining destination distance and start-to-end progress appear in the HUD. Arrival stops motion and removes forward arrows. Return requires a user action, retraces demo progress toward zero, preserves elapsed time and stops at base. This remains a procedural presentation, not true geospatial navigation. Full geographic follow-camera/turn guidance waits for the map adapter.

## Remaining integration
Main includes a Jezero region dataset. route-engine.js remains a placeholder. Abood's separate branch is not merged here. Zain's map currently has no verified imagery; his module remains untouched. Need region data, map imagery/coverage, an engine producing the merged response schema, and map mount/follow callbacks to complete end-to-end geography. Coordinate any contract changes with Adi.

Sources: globe https://science.nasa.gov/resource/mars-planet-globe/ (NASA/JPL-Caltech); landscape https://science.nasa.gov/resource/perseverance-view-of-the-delta-in-jezero-crater/ and panorama https://science.nasa.gov/resource/detailed-panorama-of-mars-jezero-crater-delta/ (NASA/JPL-Caltech/ASU/MSSS). Regional photos are archival references, not real-time camera frames or terrain reconstructions.

Verification: run npm test; node --test tests/frontend-client.test.js; npm run build. Client tests cover unavailable backend handling, stale versions and concurrent request ordering. Actual terrain and route correctness remain outside these tests.

## Map integration update
Merged origin/main at 8c120f8 locally, including Zain's map and Zaid's data. src/map.js and src/coordinates.js are preserved unchanged. src/ui/adapters/mars-map.js mounts the module and adds the recorded traverse and waypoint layers. Leaflet 1.9.4 is vendored under assets/vendor/leaflet; no new npm dependency. Only the two explicitly curated public geographic datasets are copied into public/map-data. Other server data remain private. These copies must be refreshed if Zaid updates their source files.

The map displays 708 waypoints and 559 recorded traverse segments, over a NASA Mars Trek CTX orbital mosaic. There is no continuous elevation grid. Recorded rover paths are NOT recommended astronaut routes. Geographic selections populate the existing API destination fields; the procedural drive remains illustrative and is not bound to these coordinates. The atlas displays the recorded Perseverance traverse. The waypoint picker filters by sol or site/drive ID. The detail panel shows the original NASA coordinates, elevation, odometer readings, localization note and panorama reference. Check Route passes the selected coordinates into the existing geographic briefing. Adi owns final integration with the route engine.

GitHub main at 2a8b278 includes the route engine, Zaid’s 2D layers and Adi’s map-data endpoints. It still needs production candidates.json and targets.geojson. Adi owns merging that backend with this local UI. Main's API test incorrectly expected DATA_NOT_READY for an injected valid region plus missing engine; corrected to ENGINE_NOT_READY.

The frontend copy at public/map-data/waypoints.geojson is derived from Zaid’s full data/waypoints.geojson, keeping RMC, site, drive, sol, elev_geoid, dist_m, dist_total_m, Note and images. NASA provides the source at https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json. Panorama filenames are references, with the NASA gallery provided for further lookup. Two direct mosaic requests returned HTTP 403 during verification. For orbital basemap layers, see https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars.

## Circular atlas and waypoint photos

The circular atlas starts at the recorded landing site and supports drag, touch pan, zoom and waypoint search. Only recorded waypoint markers or IDs from the picker can select a route destination. The briefing coordinates are read-only.

The local orbital mosaic in assets/jezero-ctx.png comes from the NASA Mars Trek Jezero_CTX_BlockAdj_dd layer, WMTS matrix set default028mm, zoom 12, rows 1625–1630 and columns 5851–5860. The adapter uses those tile bounds to align the imagery with the waypoint geometry. See https://trek.nasa.gov/tiles/Mars/EQ/Jezero_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml.

The waypoint photo lookup in src/ui/app.js is keyed by NASA RMC (site_drive). The first verified image is Right Navcam, Sol 1021, site 49, drive 370. Use the original NASA photo page and verify both the sol and site/drive before adding another image. Each record links to the NASA gallery filtered to its sol.
