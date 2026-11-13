# Data handoff

The data teammate owns this directory. No production observations or coordinates
have been invented for the backend scaffold.

The API initially requires `region.json` with the brief's Region shape:

```text
{ id, name, status: "demo" | "preview",
  bounds: { south, west, north, east },
  base: { lat, lon, label, isFictional }, sourceIds: [], dataVersion }
```

Use named `{lat, lon}` coordinates in degrees; east-positive longitude in
[-180, 180). Bounds must describe one non-wrapping regional area. The base must be
inside it. Zaid must validate actual bounds, base and metadata before integration.

Other expected files: `targets.geojson` (or agreed `targets.json`),
`elevation.json`, `sources.json`, and `candidates.json` for curated route fallback.
Agree their contents with Abood before integration; the API does not invent them.
Use null for unknown measurements. Include provenance and version changes.

`loadJsonData(filename)` in `server/data.ts` reads these files on the server.
Prepared data stays in this directory; put Python preparation code in `scripts/`.
Large raw source downloads should stay outside the repo.
