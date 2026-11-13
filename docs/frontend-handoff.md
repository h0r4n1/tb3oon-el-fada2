# Nebula frontend handoff · 14 November 2026

The atlas opens near Perseverance’s landing site in Jezero Crater. Drag or swipe to follow the recorded traverse, use the zoom controls, or search by sol or site/drive ID. Select a waypoint to inspect its NASA record. Route checks are available for the three targets in `data/targets.geojson`.

## Run the app

Use Node 24 and run `npm ci`, `npm run build`, then `npm start` from the repository root. Open http://localhost:3000. Vercel should build from the repository root with `npm run build` and publish `dist`.

## Route planning

The frontend reads configuration and region metadata from the API. Outbound route checks send the exact coordinates of a listed target. The target counts as the final stop, and the request leaves `stopIds` empty. The return check starts at that waypoint and uses the base coordinates as the destination. Both checks use the initial mission budget. Cards preserve the engine’s ranking and display its role labels, feasibility, detour explanations and errors. The procedural rover view is a simulation.

The build publishes the approved `data/targets.geojson` at `/map-data/targets.geojson`. Keep the source file at that repository path. The route engine on `main` also needs the team’s production route candidates to calculate the demo routes. Adi owns the final integration and deployment.

## Data and assets

- `public/map-data/waypoints.geojson` and `traverse.geojson` are local frontend copies of [NASA Mars 2020 waypoint records](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json) and the [recorded Perseverance traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json). The waypoint inspector uses recorded coordinates, elevation, odometer readings, localization notes, and panorama references.
- `assets/jezero-ctx.png` is a local mosaic from [NASA Mars Trek’s Jezero CTX layer](https://trek.nasa.gov/tiles/Mars/EQ/Jezero_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml), matrix set `default028mm`, zoom 12, rows 1625–1630 and columns 5851–5860. The map adapter aligns the mosaic using these tile bounds.
- `assets/waypoints/49_370.jpg` is [Perseverance Right Navcam imagery from Sol 1021](https://mars.nasa.gov/mars2020/multimedia/raw-images/NRF_1021_0757580999_659ECM_N0490370NCAM03021_12_095J), site 49, drive 370. Credit goes to NASA/JPL-Caltech. The inspector also links to NASA’s gallery for each waypoint’s sol.
- Reference images include the [Mars globe](https://science.nasa.gov/resource/mars-planet-globe/), [Jezero landscape](https://science.nasa.gov/resource/perseverance-view-of-the-delta-in-jezero-crater/), and [Jezero panorama](https://science.nasa.gov/resource/detailed-panorama-of-mars-jezero-crater-delta/). See the NASA pages for credits.
- Leaflet 1.9.4 and its license are bundled under `assets/vendor/leaflet`.

Run `npm test` and `node --test tests/frontend-client.test.js` for API and client checks.
