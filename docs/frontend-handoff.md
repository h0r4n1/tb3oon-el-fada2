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
Main contains no region dataset yet and route-engine.js remains a placeholder. Abood's separate branch is not merged here. Zain's map currently has no verified imagery; his module remains untouched. Need region data, map imagery/coverage, an engine producing the merged response schema, and map mount/follow callbacks to complete end-to-end geography. Coordinate any contract changes with Adi.

Sources: globe https://science.nasa.gov/resource/mars-planet-globe/ (NASA/JPL-Caltech); landscape https://science.nasa.gov/resource/perseverance-view-of-the-delta-in-jezero-crater/ and panorama https://science.nasa.gov/resource/detailed-panorama-of-mars-jezero-crater-delta/ (NASA/JPL-Caltech/ASU/MSSS). Regional photos are archival references, not real-time camera frames or terrain reconstructions.

Verification: run npm test; node --test tests/frontend-client.test.js; npm run build. Client tests cover unavailable backend handling, stale versions and concurrent request ordering. Actual terrain and route correctness remain outside these tests.
