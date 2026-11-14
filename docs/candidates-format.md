# Proposed `candidates.json` format (curated route fallback)

> **Status update (milestone 4): OPTIONAL / SUPERSEDED.** Routes now follow the
> real Perseverance traverse in `data/map-layers/rover_path_2d.geojson`
> (traverse mode, see `docs/routes-notes.md`). The engine reads
> `candidates.json` **only if the traverse file is unavailable**. The data
> teammate does **not** need to produce this file. The format below is kept as a
> fallback. The `targets.geojson` section still applies to both modes, and
> traverse mode also needs each target's **Point location** (within 25 m of the
> traverse).

**Status: PROPOSAL from Abood (Route Engineer) for the data teammate (Zaid).**
Nothing here is a team decision until the data teammate, Zain and Naser agree.
The engine (`server/candidates.js`) already reads this format. The working
example is the **synthetic** test fixture `tests/fixtures/synthetic-candidates.json`.

Brief section 6 allows "curated candidate polylines" when graph search over an
elevation grid isn't available. Each curated route is a fixed path, drawn and
checked by the data teammate, with a slope recorded for every piece of it.

## File shape

```json
{
  "dataVersion": "jezero-v1",
  "isSynthetic": false,
  "sourceIds": ["mars-trek-ctx-dem-..."],
  "candidates": [
    {
      "id": "delta-front-via-rim",
      "visitTargetIds": ["crater-rim-outcrop", "delta-front"],
      "outbound": {
        "geometry": [[77.4500, 18.4400], [77.4612, 18.4471], [77.4700, 18.4520]],
        "segments": [
          { "slopeDeg": 4.2, "method": "elevation-gradient", "evidence": "max gradient of DEM cells along segment" },
          { "slopeDeg": null, "method": "unknown", "evidence": "DEM nodata" }
        ]
      },
      "return": {
        "geometry": [[77.4700, 18.4520], [77.4500, 18.4400]],
        "segments": [
          { "slopeDeg": 6.0, "method": "along-track-rise-run", "evidence": "elevation difference / length" }
        ]
      },
      "coveragePercent": 85,
      "sourceIds": ["hirise-..."]
    }
  ]
}
```

(The coordinates and ids above only illustrate the shape. They are not
verified Jezero locations.)

## Field rules

| Field | Rule |
|---|---|
| `dataVersion` | **Required.** Must equal the region's `dataVersion`, otherwise no routes are planned (stale data). |
| `isSynthetic` | `true` for demonstration or test data. Every route then carries a "SYNTHETIC" reason. |
| `sourceIds` (file) | Sources for the whole file. They're added to every candidate's `sourceIds`. |
| `id` | Unique text, 1–100 characters. A repeated id is skipped and reported. |
| `visitTargetIds` | Ids from `targets.geojson`, **in visiting order**. Each one counts as a stop: it adds that target's `stopMinutes` and, once per unique target, its `scienceValue`. |
| `outbound.geometry` | At least 2 points, in **`[lon, lat]`** order (GeoJSON), decimal degrees. Longitude is east-positive in [-180, 180). It starts at the base and ends at the destination. |
| `outbound.segments` | **Exactly one entry per pair of neighbouring points** (so 3 points need 2 segments). |
| `slopeDeg` | The terrain slope in degrees for that piece (0 or more). Use **`null` when unknown**, never 0. An unknown slope makes the route `unverified`. |
| `method` | How the slope was derived. One of `"elevation-gradient"` (preferred: the elevation-derived gradient, which captures cross-slope), `"along-track-rise-run"` (height change along the line only, which misses cross-slope; the engine labels this), or `"unknown"`. A slope with no recognised method is treated as unknown. |
| `evidence` | Short free text: which product or cells, or how it was computed. For people, not for the engine. |
| `return` | The path from the **itinerary endpoint** (the last outbound point) back to base, with the same rules. Use **`null` if there is no way back**, which blocks the route. |
| `coveragePercent` | 0–100 sampled terrain coverage if known, else `null`. |
| `sourceIds` (route) | Sources specific to this route. |

**Segment lengths are not supplied.** The engine measures each piece from the
geometry (haversine on a sphere with R = 3,389,500 m), so a length can never
disagree with the drawn line.

## `targets.geojson` (only the fields the engine reads)

A GeoJSON FeatureCollection. In each feature's `properties`:
- `id`
- `scienceValue`: 1, 2 or 3 from Naser's rubric, or `null`
- `stopMinutes`: 0 or more, or `null`

The engine handles gaps like this:
- A missing `stopMinutes` uses the configured default (5 min) and says so in the reasons.
- A missing `scienceValue` isn't counted. The route is named as having an
  unrated target and can't be "Science-focused".
- A target id not found in the file makes the route `unverified`.

## How `planRoutes` matches a candidate to a request

A candidate is used for a request only if **all** of these hold. "Near" means
within 50 m (`ROUTE_MATCH_TOLERANCE_M`).

1. The first outbound point is near `request.origin`.
2. The last outbound point is near `request.destination`.
3. If `return` isn't `null`: its first point is near the last outbound point,
   and its last point is near `request.base`.
4. `visitTargetIds` contains every id in `request.stopIds`, **in the same
   order**. Other targets may sit in between.

Candidates that don't match are ignored for that request. If none match, the
API returns no candidates, and `errors` says to choose a listed science target.
The engine never draws a straight line instead.

## Abood's proposals (to be confirmed, not decisions)

- **Where the return starts:** at the itinerary endpoint (the last stop),
  following brief section 6 ("Return path is calculated from the itinerary
  endpoint to base").
- **Stop order** follows the order of `request.stopIds`. *To confirm with
  Naser and Zain* (it affects the add/reorder-stops UI).
- **Targets file name** is `targets.geojson`, as in `data/README.md`. *To confirm
  with the data teammate* (the README also mentions `targets.json`).
- **Forbidden areas** aren't implemented. That's a known limitation: there's no
  verified forbidden-area data yet, so routes are not checked against any.

## Open questions for the team

1. Is a 50 m match tolerance right for the chosen map scale? (Proposed as
   `routeMatchToleranceM` in `server/config.ts`.)
2. Should the destination itself always be listed in `visitTargetIds` (so its
   stop time and science value count), or only when the crew stops there?
3. Is the curated slope the **maximum** gradient along a piece, or an
   average? The maximum is safer, because an average can hide a steep spot.
4. How many curated routes per destination can the data teammate produce by
   hour 2? Two or three genuinely different paths are enough for the comparison.
5. Mid-mission replanning (return from midway, add stop while paused) needs a
   design. See "Known limitations / milestone 4" in `docs/routes-notes.md`.
