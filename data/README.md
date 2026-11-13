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

Read-only map endpoints expose `map-layers/waypoints_2d.geojson` as
`GET /api/map-data/waypoints` and `map-layers/rover_path_2d.geojson` as
`GET /api/map-data/rover-path`. Preserve those filenames unless the endpoint
mapping is updated together with the data handoff. Other files are not exposed
by an arbitrary filename endpoint.

The original 3D source files remain at the root of `data/`. Run
`python scripts/make_map_layers.py` to regenerate the 2D map layers under
`data/map-layers/`; elevation remains in feature properties.

## Data provenance and cleaning

Source files, downloaded 2026-11-13 by `scripts/fetch_rover_path.py`:
- `rover_path.geojson` - https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
- `waypoints.geojson` - https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json

Mission: Mars 2020 (Perseverance). Coordinates are lon/lat degrees, east-positive.
Vertical datum and units: UNVERIFIED. Values are consistent with metres and the
field is named `elev_geoid`, but no NASA documentation has been checked.

### Prepared files
NOTE: these files are currently at the root of `data/` (e.g. `data/rover_path_2d.geojson`).
The endpoint section above refers to `map-layers/...`. If a `data/map-layers/`
subfolder is intended, say so and I will move them and update the scripts.

- `region.json` - `scripts/make_region.py`
- `waypoints_slims.geojson` - `scripts/prepare_waypoints.py` (3D, deprecated)
- `rover_path_2d.geojson`, `waypoints_2d.geojson` - `scripts/make_map_layers.py`
  then `scripts/clean_data.py`

### Cleaning applied (`scripts/clean_data.py`)
1. Traverse elevations: 15 vertices in feature 181 (sol 668, RMC 32_482 to 32_580)
   held the repeated value 2.200000017e-05, discontinuous with the surrounding
   range of -2586.5 to -1786.0 m. Set to null. Whether NASA documents this as a
   no-data marker is UNVERIFIED; it is treated as missing on the evidence of the
   data alone.
2. `dist_total_m`: set to null on 154 waypoints whose `Note` is
   "Mid-drive localization" (132) or "Interpolated" (22), where the value was 0.
   These are read as "not recorded".
   EXCEPTION: sol 13 (`Note` = "Site increment, no motion.") keeps
   `dist_total_m = 0`. It is the start waypoint and the zero is a real measurement.

Missing values are null, never 0.
