# Nebula | Mars Mission Planner

**Which science trip can we finish and still get home?** Nebula plans a
simulated crewed rover trip in Jezero Crater along NASA's real Perseverance
traverse. Every plan includes the drive back to base, with time and battery
reserves. NASA Space Apps 2026, challenge "Interplanetary Survival Guide:
Martian Map".

Live demo: https://tb3oon-el-fada2.vercel.app

## Run locally

Node.js 24.x:

```sh
npm install
npm run dev        # http://localhost:3000
npm test           # route engine, API and real-data demo checks
npm run typecheck
npm run build
```

## How it works

- `server/` — route engine (plain JavaScript) and API (TypeScript):
  `POST /api/routes`, `GET /api/region`, `/api/config`, `/api/health`,
  `/api/map-data/*`. The engine plans along the real traverse, computes time,
  energy, scores and the return trip (team brief section 6), and returns
  pass / blocked / unverified with plain-English reasons. See
  [docs/routes-notes.md](docs/routes-notes.md).
- `index.html`, `src/ui/` — the Rover OS demo page: orbit, crew setup,
  circular Jezero atlas (Leaflet), route briefing, descent, third-person drive
  view with guidance, radar and activity feed, science stops, return and
  summary. See [docs/frontend-handoff.md](docs/frontend-handoff.md).
- `data/` — NASA Mars 2020 traverse and waypoints, region, science targets.
  See [data/README.md](data/README.md).
- `api/` — Vercel function wrappers. `vercel.json` builds `dist/`.

## Honesty notes

- Route numbers come only from the engine. Labels on screen say what is
  OBSERVED (NASA data), DERIVED (engine), SIMULATED (scenario playback) or
  EDITORIAL (team science rubric).
- The base, crew, rover and its position are a simulated scenario. NASA does
  not operate this vehicle; nothing is live telemetry.
- Routes follow where Perseverance actually drove; that is not a computed
  crewed route or a terrain-safety proof. Slopes are along-track only;
  elevation units and vertical datum are unverified.
- The terrain behind the rover is illustrative artwork. The route ribbon,
  stops and lander position come from the real coordinates. There is no
  oxygen, temperature or weather data, so none is shown.
- Mission settings (5 km/h, 15°, 120 min, 10 kWh, reserves, 70/30 weights) are
  prototype assumptions, not rover limits.

## Sources

- NASA Mars 2020 (Perseverance) traverse and waypoints:
  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json and
  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json
  (retrieved 13 Nov 2026; license/product record not found).
- NASA Mars Trek Jezero CTX imagery: https://trek.nasa.gov/mars/
- Perseverance raw images: https://mars.nasa.gov/mars2020/multimedia/raw-images/
- NASA Mars globe: https://science.nasa.gov/resource/mars-planet-globe/
- Target references: see `sourceUrls` in `data/targets.geojson`.
- Leaflet 1.9.4 (BSD-2-Clause), zod (MIT), TypeScript (Apache-2.0).
- Challenge: https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/?tab=details

## AI assistance

AI coding assistants were used with human direction and review: Codex (initial
backend scaffold, validation, build, tests) and Claude Code by Anthropic
(route engine, tests, the 14 Nov demo frontend and its Rover OS restore,
deployment fix, documentation). The Rover OS interface design and artwork are
by Naser (team).
No images or data are AI-generated. Details: the "AI assistance" sections in
`docs/routes-notes.md`, `docs/frontend-handoff.md` and `docs/backend-handoff.md`.

## Releases

- **Version 1** (`v1`): the first working demo (2D planner).
- **Version 1.1** (`v1.1`): the restored Rover OS interface on the same engine.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
