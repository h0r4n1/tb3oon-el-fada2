# Route engine notes (Abood, Route Engineer)

Plain-English notes on the route maths, for teammates and judges.
All numbers come from `MISSION_CONFIG` in `server/config.ts` (owned by the
backend team; brief section 6 defaults). They are tunable prototype
assumptions, not NASA or rover-engineering standards.

## Files

The route engine runs on the server (Node), never in `src/` (the frontend).

| File | What it does |
|---|---|
| `server/route-engine.js` | `planRoutes(request)`: the API's entry point. Chooses traverse or curated mode, then ranks and caps the results. |
| `server/traverse.js` | Builds the real rover traverse into one vertex list with continuous runs and gaps. Snaps points to it, slices it, and cuts slices into ~50 m segments with along-route slopes. |
| `server/traverse-planner.js` | Traverse mode: turns a request into itineraries along the traverse (outbound, return, stops, the pass ambiguity rule, return-to-base) and suggests science detours. |
| `server/candidates.js` | Curated mode (fallback): reads `candidates.json`. Also reads `targets.geojson` (used by both modes). |
| `server/ranking.js` | Removes duplicate itineraries, assigns Recommended / Fastest / Science-focused, and caps the list at 6. |
| `server/route-math.js` | `evaluateSegment` (one segment) and `evaluateRoute` (whole route with return trip, scores and verdict). |
| `server/geo.js` | Mars distance (haversine), `pathDistanceKm` for GeoJSON polylines, plus small helpers (`clamp`, `toRadians`). |
| `tests/*.test.js` | My hand-checked tests. Run them with `node --test tests/*.test.js` (the team's `npm test` now runs them too). |
| `tests/real-traverse.test.js` | Reads the real `data/map-layers` files **read-only** and prints plans for base → 5_0, 7_1172 and 9_5676. Skipped if the data is absent. |
| `tests/fixtures/` | **Synthetic** demonstration data for tests only. Not Mars observations, not the real traverse. |

Config key names used (from `server/config.ts`): `flatSpeedKmh`,
`maxSlopeDegrees`, `baselineKWhPerKm`, `minimumTimeReserveMinutes`,
`batteryCapacityKWh`, `batteryReservePercent` (a percent: reserve kWh =
capacity × percent / 100 = 2 kWh), `auxiliaryKW`, `defaultStopMinutes`,
`terrainWeight`, `timeWeight`, `marsRadiusM`.

## Coordinate and elevation conventions

| Topic | Convention |
|---|---|
| Point objects inside our code | Named `{lat, lon}` in decimal degrees, so the order can't be swapped by accident. |
| GeoJSON (data files, Candidate `geometry` / `returnGeometry`) | `[lon, lat]` arrays (x then y). Converted to `{lat, lon}` the moment we read them. Leaflet uses `[lat, lon]`; Zain's adapters handle that. |
| Longitude | East-positive, in [-180, 180). |
| Mars shape | A sphere with radius R = 3,389,500 m (a declared approximation, brief section 5). |
| Distances | Always measured **along the traverse**, vertex to vertex. Never a straight line between the origin and destination. `dist_total_m` from the waypoints file is **not** used (it is 0 for "Mid-drive localization" and "Interpolated" waypoints, which means "not recorded"). |
| Metres to km | Only `pathDistanceKm` divides by 1000. Inside the traverse code, along-path distances stay in metres. |
| Elevation | From `properties.elevations` (one per vertex). The values look like metres (about −2586 to −1786), but **units and vertical datum are UNVERIFIED**. Any value above −100 (the 2.2e-05 no-data marker) is treated as unknown (`null`). |

## Distance on Mars (brief section 5)

We treat Mars as a sphere with radius R = 3,389,500 m. Distance between two
`{lat, lon}` points uses the haversine formula:

- a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
- d = 2R·atan2(√a, √(1−a))

`a` is clamped to [0, 1] so rounding can't produce a square root of a negative number.
We don't use Leaflet's distance because it assumes Earth's radius.
**Check:** a 0.001-radian arc along the equator gives 3,389.5 m (R × 0.001).

### Route length from GeoJSON: `pathDistanceKm(geometry)`

GeoJSON stores points as `[lon, lat]` (x then y, the maths convention),
while Leaflet usually uses `[lat, lon]`. Mixing them up silently moves points,
so inside our code we convert to named `{lat, lon}` immediately.
`pathDistanceKm` adds up haversine distances between neighbouring points and
divides by 1000 **once**. That is the only metres-to-km conversion in the route
engine. Any bad point gives `null`. One point gives 0 km. An altitude value,
if present, is ignored.

## One segment (brief section 6)

With v0 = 5 km/h, L = 15°, e0 = 0.5 kWh/km:

| Step | Formula | Meaning |
|---|---|---|
| Steepness | q = clamp(s / L, 0, 1) | 0 = flat, 1 = at or over the limit |
| Speed | v = v0 / (1 + 2q) | Steeper is slower: 5 km/h when flat, 1.67 km/h at the limit |
| Time | t = 60·d / v | Minutes (×60 converts hours to minutes) |
| Energy | e = e0·d·(1 + 2q) | Driving kWh. Steeper uses up to 3× more |

Worked examples (all used in the tests):

| d (km) | slope | q | speed (km/h) | minutes | kWh | result |
|---|---|---|---|---|---|---|
| 1.0 | 0° | 0 | 5 | 12 | 0.5 | pass |
| 1.0 | 3° | 0.2 | 3.571 | 16.8 | 0.7 | pass |
| 1.0 | 9° | 0.6 | 2.273 | 26.4 | 1.1 | pass |
| 1.0 | 15° | 1 | 1.667 | 36 | 1.5 | pass (equal to limit is allowed) |
| 1.0 | 20° | 1 | 1.667 | 36 | 1.5 | **blocked** |
| 0 | 9° | 0.6 | 2.273 | 0 | 0 | pass |
| 1.0 | −3° or missing | null | null | null | null | **unverified** |

## Whole route: `evaluateRoute(input)` (brief sections 6 and 7)

Input: `{ outboundSegments, returnSegments, stopMinutes, remainingMinutes, currentBatteryKWh }`.
Output fields use the Candidate contract names: `distanceKm, driveMinutes,
stopMinutes, returnMinutes, outboundEnergyKWh, returnEnergyKWh, totalEnergyKWh,
safetyScore, timeScore, overallScore, feasibility, reasons, coveragePercent`.

| Symbol | Formula | Meaning |
|---|---|---|
| S | 100 [1 − Σ(d·q) / Σd], outbound only | Terrain score: 100 = all flat, 0 = all at the slope limit. A slope heuristic, not a survival probability. |
| T | outbound drive + stop minutes | Time spent on the outbound itinerary |
| H | remaining − 15 min reserve | Time we are allowed to use |
| U | 100 · clamp(1 − T/H, 0, 1) | Time score: more spare time gives a higher score |
| C | terrainWeight·S + timeWeight·U (0.7 and 0.3) | Overall score, kept at full precision (round for display only) |
| E | outbound kWh + return kWh + 0.2 kW × (all drive + stop minutes) / 60 | Total energy, including the trip home |

**Verdict:**
- **blocked** if a segment in *either* direction is over 15°, there's no return
  path (`returnSegments: null`), H ≤ 0, T + return + 15 > remaining minutes,
  or E + 2 kWh > current battery.
- **unverified** if anything needed is missing or invalid.
- **pass** otherwise.

Being exactly at a reserve passes.

Worked examples (120 min, 10 kWh, 5 min stop; return = same segments reversed):

| Route | S | T | U | C | Return min | E (kWh) | Result |
|---|---|---|---|---|---|---|---|
| A: 1 km @3° + 1 km @9° | 60 | 48.2 | 54.095 | 58.229 | 43.2 | 3.9047 | pass |
| B: 1.6 km @2° + 0.8 km @2° | 86.667 | 41.48 | 60.495 | 78.815 | 36.48 | 3.2999 | pass |

Route B scores higher overall even though it is longer, because it is much
flatter. That's the 70/30 trade-off.

Reserve edge cases for Route A:
- **Time:** it needs 48.2 + 43.2 + 15 = 106.4 min. 106.4 passes; 106.3 is blocked
  (short by 0.10 min).
- **Battery:** it needs 3.904666… + 2 = 5.904666… kWh. The exact value passes,
  5.9047 passes, and 5.9046 and 5.9 are blocked.

## Design decisions

- **Missing data is `null`, never 0.** A 0 slope would look like safe flat
  ground. `null` makes the segment `unverified`, so it can't count toward a
  verified recommendation.
- **A negative slope is invalid.** Slope means steepness (a magnitude), so a
  negative value indicates a data or sign error. Decided by Abood (Route
  Engineer) on 2026-11-13. Confirm with Zain because it affects Zaid's data.
- **Blocked segments still report numbers.** That lets the UI explain *why*
  a segment was blocked (for example, "20° exceeds the 15° limit").
- **Exactly 15° is allowed.** The brief says a segment is blocked if it
  *exceeds* the limit.
- **No division by zero.** Speed is always at least v0/3, and a zero-length
  segment simply gives 0 minutes and 0 kWh.
- **Auxiliary draw (0.2 kW) is not in segment energy.** The brief adds it once
  for the whole route: E = outbound + return driving energy +
  auxiliaryKW × (drive + return + stop minutes) / 60.
- **Tiny tolerance (1e-9) in reserve checks.** Computers store decimals
  approximately (106.4 may become 106.40000000000001). A route that exactly
  meets a reserve must pass, so a check fails only if it is short by more than
  0.000000001.
- **BLOCKED beats UNVERIFIED.** If one segment is definitely over the limit and
  another is unknown, the route is blocked: a known violation makes it unusable
  no matter what the unknown turns out to be. All reasons are still listed.
- **Scores are `null` whenever any input is unknown.** Unknown terrain must not
  improve a score. Blocked routes with complete data still get scores, so the
  UI can show what they would have scored.
- **Zero-distance route:** drive time and energy are 0, and only stop and
  auxiliary costs apply. `safetyScore` is `null` (N/A, which also avoids ÷0),
  so `overallScore` is `null` too. We don't invent a number. `timeScore` is
  still calculated.
- **H ≤ 0:** blocked, with `timeScore` and `overallScore` `null` (avoids ÷0).
- **Empty return list `[]`** means "already at base" only when the outbound
  distance is 0. If the rover leaves base and the return list is empty, the
  data is missing, so the route is **unverified**. `null` means no return path
  exists, so it's **blocked**.
- **Time checks are skipped when totals are unknown.** If a segment's slope is
  unknown, its time and energy are unknown, so the time and battery checks
  can't run. The route is unverified rather than guessed.

- **Scores are clamped to 0–100.** Mathematically S and C are always in that
  range. The clamp only removes tiny rounding errors (for example
  −0.00000000000002), which the team's contract would reject.

## Planning: two modes

`planRoutes` first tries to load the traverse (`map-layers/rover_path_2d.geojson`)
through the team's `loadMapData`.
- If the traverse exists, **traverse mode** runs (below).
- If it is missing, **curated mode** runs, using `candidates.json`.
- If both are missing, `DATA_NOT_READY` (503) passes through unchanged.
- Any other data problem (for example `INVALID_DATA`) is reported, not hidden.

Both modes then share ranking and the **cap of 6 candidates**. Candidates
holding a role are always kept, and `errors` says how many others were hidden.

## Traverse mode (milestone 4)

**What the traverse is:** NASA's real Mars 2020 (Perseverance) traverse: 559
LineString pieces, 36,661 vertices, about 1 m apart. It is **source mission
data**, the path a robotic rover actually drove. It is **not** a computed
crewed-rover route and **not** proof that the ground is safe.

**Building it** (`buildTraverse`):
- **Superseded pieces are dropped first (14 Nov fix).** The NASA file holds
  partial downloads: when a drive's data arrived in parts, the earlier part was
  later re-sent inside a longer piece that starts at the **same `fromRMC`**,
  repeating it as an exact prefix (0 m difference, identical elevations).
  Keeping both made the path jump backwards, which looked like 5 "gaps". For
  each group with the same `fromRMC` we keep the longest piece (tie: fewer
  unknown elevations; then the later one), and only drop a piece that really is
  a point-by-point copy (within 1 m) of the start of the kept one. Dropped on the
  real data (file index, sol, fromRMC -> toRMC, kept instead):

  | Dropped | Kept |
  |---|---|
  | #83 sol 350, 9_2982 -> 9_3478 | #85 sol 352, 9_2982 -> 9_5676 |
  | #84 sol 351, 9_2982 -> 9_5156 | #85 sol 352 |
  | #89 sol 358, 9_9314 -> 9_9436 | #90 sol 359, 9_9314 -> 10_0 |
  | #95 sol 380, 11_1110 -> 11_2472 | #96 sol 381, 11_1110 -> 12_0 |
  | #181 sol 668, 32_482 -> 32_580 (15 no-data elevations) | #180 sol 667, same path with known elevations |
  | #534 sol 1896, 88_4292 -> 88_5126 | #535 sol 1897, 88_4292 -> 89_0 |

  Result: **one continuous run, 0 gaps, 45.04 km, 34,299 vertices.**
- Back-to-back duplicate points are dropped.
- Each vertex gets the metres driven along the path so far (`cumulativeM`).
- **Anchors (14 Nov fix):** every piece's `toRMC` (where that drive ended) is
  anchored to the piece's last vertex, and its `fromRMC` to its first (if not
  already known). A target id such as `9_5676` is the `toRMC` of exactly one
  drive, so targets are located **by id**, not by the nearest coordinates. The
  base `3_0` is vertex 0.
- A piece starting more than **10 m** from the previous one would still start a
  new continuous run (a real gap); after the fix the real data has none.

**Snapping** (`snapToTraverse`): a requested point must be within **25 m**
(`SNAP_TOLERANCE_M`) of a traverse vertex, otherwise `errors` gives its
distance. The rover often drove past the same place more than once (344 of 708
waypoints have a second pass within 25 m). Matching vertices more than **100 m**
apart along the path (`PASS_SEPARATION_M`) count as separate **passes**, and up
to 3 are kept, closest first.

**The ambiguity rule (agreed):** every combination of an origin pass and a
destination pass that lies in the same continuous run becomes its own
candidate. Each one says in its reasons which pass (sol) it used. Ranking then
chooses openly. Nothing is picked silently.

**Outbound:** the traverse between the origin vertex and the destination
vertex, in either direction. **Return:** the traverse from the itinerary
endpoint back to the base pass in the same run that is closest along the path.
It retraces known ground, so its terrain is known too. If no base pass shares
the run, there is no return path and the route is blocked.

**Slopes** (`segmentSlice`):
- Each slice is cut into windows of about **50 m** (`SLOPE_WINDOW_M`). A leftover
  shorter than 25 m is merged into the window before it. Vertices are ~1 m
  apart, so point-to-point slopes would be mostly noise.
- slope = degrees(atan(|elevation change| / metres along the path)), with method
  `along-track-rise-run`.
- If **any** vertex in a window has an unknown elevation, that window's slope is
  `null`, so the route becomes unverified.
- `coveragePercent` = the share of all driven km (outbound + return) whose slope
  is known. That is **data coverage, not safety**.

**Stops and targets:**
- Targets come from `data/targets.geojson`. A target can be used only if it is
  within 25 m of the traverse.
- **The destination as a target (agreed):** if a listed target is within 25 m of
  the destination, it counts as the **final stop** (its stop minutes and science
  value). It is counted once, even if its id is also in `stopIds`.
- Requested `stopIds` must lie on the outbound slice **in the requested order**.
  Otherwise `errors` says which stop is off the route or out of order.
- **If `targets.geojson` is missing (agreed):** a request with no stops is still
  planned, with no science value, no detours and a reason saying so. A request
  with stops gets `DATA_NOT_READY`.

**Mid-mission:**
- The origin can be the rover's current position. The plan runs from there,
  and the return still goes all the way to base.
- **Return to base:** the frontend sends the base as the destination. The
  outbound is then empty (zero distance) and the drive home is the return leg.
  `safetyScore` and `overallScore` are `null` (N/A), but every time and battery
  check still applies.
- **Add stop while paused:** a new request with the current position as origin,
  the new `stopIds`, and the current `remainingMinutes` / `currentBatteryKWh`.

**Science detours** (brief Signature 2), built from the best feasible
itinerary, at most **3** per request (highest science value first, then the
least extra driving):
- **Stop on the way:** a listed target already on the outbound path. No extra
  driving; it adds stop time and auxiliary energy only.
- **Extension:** a listed target farther along the traverse than the
  destination, in the same continuous run. The new destination is that target,
  the old destination becomes an intermediate stop, and the return starts from
  the new endpoint. This adds driving both ways.
- Each detour is a full candidate, checked against both reserves for the whole
  round trip. Its first reason states the added minutes, added kWh, and the
  battery and time margins left after returning to base. **Blocked detours are
  still returned** with their reasons, so the UI can show why an excessive
  detour was rejected.
- Only targets on the traverse are considered. A target off the traverse
  would need new driving through unknown ground.

**Honesty reasons on every traverse candidate:**
- "Route follows the real Perseverance traverse (source mission data), not a
  computed crewed route." (Synthetic test fixtures say "SYNTHETIC test traverse"
  instead.)
- "Slopes are along-route rise/run over ~50 m windows only; cross-slope is not
  captured, there is no obstacle detection, and this is not a terrain-safety
  proof."
- "Elevation units and vertical datum are unverified."

**14 Nov fixes (agreed with Abood):**
1. **Targets anchored by id** (see Anchors above). A listed target as the
   destination (or origin) uses its own drive's end vertex only.
2. **Superseded pieces dropped** (see Building it above).
3. **Best-case lower bound** (`route-math.js`): if nothing known is broken but
   some slopes are unknown, the unknown ground is priced as flat (full speed,
   base energy, at least its straight length). Slopes can only add time and
   energy, so if even this best case misses the time or battery reserve the
   route is **blocked** ("...even in the best case..."); otherwise it stays
   **unverified** with no numbers invented.
4. **Base alternatives are unverified.** The return always ends at the base
   itself (vertex 0; only a pass within 1 m of the base counts). A route that
   starts from another pass near the requested point (e.g. sol 33, 9 m from
   the base) includes that hop as a segment with **unknown slope**
   (`unmapped-hop`), so it can never pass; its reason says so.
5. **1 m target match:** the destination is a listed target only if it is
   within 1 m (`TARGET_MATCH_M`) of the target's coordinates in
   `data/targets.geojson`; then it is anchored by that id. (No contract change.)

**Real-data results after the fixes** (`tests/demo-story.test.js` asserts these;
120 min, 10 kWh, server config):

| Trip | Verdict | Drive out + back | Energy | Notes |
|---|---|---|---|---|
| base -> 5_0 | **pass** | 13.9 + 13.9 = 27.8 min (+5 min stop) | 1.27 kWh | 1.091 km each way |
| base -> 7_1172 | **pass** | 33.0 + 32.8 = 65.8 min (+10 min stop) | 2.99 kWh | 2.408 km |
| base -> 9_5676 | **blocked** | 53.5 + 53.4 min (+15 min stop) | 4.86 kWh | "Not enough time: ... short by 16.90 min" (1.9 min short even without the stop) |
| 5_0 + detour to 7_1172 | **pass** | | 3.01 kWh | 24.2 min above the time reserve |
| 5_0 + detour to 9_5676 | **blocked** | | | 21.9 min short of the time reserve |

Other passes near the base (sol 33 at 9 m, sol 379 at 18 m) still appear as
**unverified** previews; they cannot be recommended or started.

**Old results before the fixes** (kept for the record; WRONG for 9_5676, which
matched an earlier sol 137 pass 11 m away):

| Trip | Routes offered | Recommended (outbound, total energy, C) | Notes |
|---|---|---|---|
| base → 5_0 | 2 | 0.915 km, 1.037 kWh, C 95.3 (from the sol 33 pass) | The sol 14 start route is 1.091 km, as measured by hand. The rover also passed within 9 m of the base on sol 33, 176 m into the drive. |
| base → 7_1172 | 4 | 2.232 km, 2.745 kWh, C 86.4 | The base and 7_1172 each have 2 passes in run 0. |
| base → 9_5676 | 2 | 1.282 km, 1.540 kWh, C 91.4 (destination pass from sol 137, 11 m away) | **Gap warning:** 9_5676's own vertex (sol 352) is in run 2, beyond gaps 1 and 2. The route uses an earlier drive (sol 137) that passed 11 m from the same spot, in the base's run. |

All of these routes pass. That is under the prototype assumptions and along-track slopes only.

## Curated mode (fallback, milestone 3)

Used only when the traverse file is missing. See `docs/candidates-format.md`.

1. Load `candidates.json` and `targets.geojson` with the team's
   `loadJsonData`. If a file is missing, `DATA_NOT_READY` (503) passes
   through unchanged. If a file has the wrong overall shape, the result is
   `INVALID_DATA` (503).
2. If `candidates.json`'s `dataVersion` differs from the request's, no routes
   are planned and `errors` explains why.
3. Each candidate is checked. A broken one is skipped and named in `errors`,
   because returning it would make the API reject the whole response.
4. Routes are kept only if they match the request's origin, destination, base
   (within 50 m) and stops (in order). See `docs/candidates-format.md`.
5. Each kept route is evaluated with `evaluateRoute` (server config, the crew's
   remaining minutes and battery).
## Ranking (both modes)

   - **Duplicates:** identical outbound path + return path + visited stops are
     shown once. The same path with *different* stops is a different itinerary
     (for example a detour that only adds a stop on the way), so both are kept.
   - **Eligible** means feasibility `pass`.
   - **Recommended:** highest C. Ties go to the higher S, then the lower T.
   - **Fastest:** lowest T. Ties go to the higher C.
   - **Science-focused:** highest science value (sum of unique rated targets).
     Ties go to the higher C. Routes with an unrated target are excluded.
     A science value of 0 earns no science role.
   - One route can hold several roles. Roles are written at the start of its
     `reasons`. Alternatives are never invented.
   - A single eligible route is labelled "Only one feasible route was found."
   - If nothing is eligible, a message goes into `errors`.
   - **Order:** recommended first, then other eligible routes, then blocked,
     then unverified. Inside each group, the data-file order is kept.
   - A `null` overall score (zero-distance route) can't be recommended and
     sorts after scored routes, but it can still be Fastest.

## Known limitations

- **The traverse is not a crewed route.** It is where a robotic rover drove,
  which suggests the ground was passable for *that* rover on *that* day. It
  proves nothing about a crewed vehicle.
- **Elevation units and vertical datum are unverified.** Slopes only use
  elevation *differences*, so a constant datum offset would not change them, but
  wrong units would.
- **Along-track slope only.** Rise/run along the path cannot see cross-slope
  (tilting sideways). It is not an elevation-derived gradient.
- **No obstacle detection.** Coarse elevation cannot show rocks, sand traps or
  small cliffs.
- **Only destinations on the traverse.** A point more than 25 m from the
  traverse gets no route. A point 1-25 m away gets only an UNVERIFIED preview
  (the hop crosses unmapped ground).
- **Snapping can move the start or end by up to 25 m.** The route begins and
  ends at the matched traverse vertex. Its distance from the requested point
  is stated in the reasons (for example the sol 33 base pass is 9 m from the
  base).
- **Forbidden areas are not implemented.** The brief blocks routes that cross
  a verified forbidden area, but no such data exists yet.
- **The traverse is cached in memory.** It's read once per server process, so
  restart the server after the data files change.

## Open questions

- **For the data teammate:** confirm the elevation units and vertical datum, and
  supply `data/targets.geojson` (ids, Point locations on or near the traverse,
  `scienceValue`, `stopMinutes`).
- **For the team:** is a 9 m start offset acceptable? The sol 33 pass gives a
  shorter route that starts 9 m from the base. Should the base require an exact
  match instead?
- **For the team:** are 25 m (snap), 10 m (gap), 50 m (slope window) and 100 m
  (pass separation) right? Proposed config keys: `snapToleranceM`,
  `traverseGapToleranceM`, `slopeWindowM`, `elevationNoDataAboveM`.
- **For the team:** confirm `"m20-traverse"` (from `region.json`) as the
  source id for traverse candidates.
- **For Naser and Zain:** stop order follows `stopIds`. Is that the order the UI
  will send?
- **For Adi: make `scienceValue` nullable in `server/contracts.ts`.** The
  contract forces a number, even when a visited target has no rating. Current
  workaround: count only rated targets, name the unrated ones in `reasons`, and
  exclude the route from Science-focused.
- **For Adi: add `routeMatchToleranceM` (50) to `server/config.ts`.** Until then
  it's a named constant in `server/candidates.js` (curated mode only).
- **For Zain: there is no `returnDistanceKm` field in the Candidate contract.**
  The brief says outbound and return distances are separate, but only
  `distanceKm` (outbound) exists. Adding it is a contract change, so it needs
  Zain's coordination and a brief version update.
- Slope should come from an elevation gradient. If we only have rise/run
  along the route, cross-slope is missed. The engine labels this in `reasons`.

## Assumptions made on 14 Nov (instead of asking teammates)

- The 6 superseded pieces are partial downloads (verified: exact prefixes,
  identical elevations); dropping them is a data-cleaning step in the engine,
  the data file itself is unchanged.
- Targets are anchored by their `site_drive` id = the piece's `toRMC`.
- The base is the first traverse point (`3_0`, sol 14). The crewed base is a
  simulated scenario element placed at that real location.
- Demo script: plan base -> 5_0, then propose 7_1172 (South Seitah, science 3)
  as the worthwhile detour, then 9_5676 as the excessive one.
- **Rover OS restore (14 Nov, branch `restore-ui`, Version 1.1):** the page
  now uses Naser's Rover OS design again, on top of the same engine. The
  frontend never computes a route number. It reads candidates exactly as the
  engine returns them. Detour cards can be started directly: the stop order
  is read from the engine's own detour reason ("stop on the way" means
  `stopIds=[detour]`, destination = target; "extension" means
  `stopIds=[target]`, destination = detour). The drive view converts the
  engine's route coordinates to local metres only to draw the ribbon,
  guidance arrows and radar (`src/ui/local-path.js`, display only). The HUD
  elevation is looked up from the recorded traverse vertex under the rover
  (null stays "Unknown"; units/datum unverified). No oxygen, temperature or
  weather values are shown, because there is no data for them. The terrain
  behind the rover is labelled "Illustrative terrain". Pre-departure stop
  reordering was cut for time.

## AI assistance

The route engine code (`server/geo.js`, `server/route-math.js`,
`server/ranking.js`, `server/candidates.js`, `server/route-engine.js`,
`server/traverse.js`, `server/traverse-planner.js`), its tests and synthetic
fixtures in `tests/`, and these notes were written by **Claude Code
(Anthropic)** at the direction of Abood (Route Engineer).

- Abood set the requirements, approved each plan before any code was written,
  decided the open design questions (recorded above), and reviewed the code
  with plain-English explanations.
- **Milestone 4:** Abood measured the real traverse (vertex counts,
  the no-data marker, `dist_total_m` problems, slope noise across 5–100 m
  windows) and chose the 50 m window. Claude Code measured the gaps, duplicate
  points and repeated passes it used to propose the tolerances, which Abood
  approved.
- All formulas come from the team brief. The test values were checked by hand.
  The synthetic fixtures were generated by a script and are labelled SYNTHETIC.
- The traverse data itself is NASA Mars 2020 mission data prepared by the data
  teammate. It is not AI-generated.

- **14 Nov (demo finish):** Claude Code (Anthropic, model Claude Opus 5.5)
  applied the five agreed engine fixes, the Vercel deployment fix (plain-JS
  shared modules), `tests/demo-story.test.js`, and these notes, with Abood's
  approval of the plan. Abood had approved the five fixes on 13 Nov.

- **14 Nov (Rover OS restore, Version 1.1):** Claude Code (Anthropic, model
  Claude Opus 5.5) ported Naser's Rover OS interface (frontend commit
  `af3c7da`, design by Naser) onto the integrated engine, following the
  team's restoration handoff and Abood's data rules: `index.html`,
  `src/ui/app.js`, `src/ui/scene.js`, `src/ui/local-path.js`,
  `src/ui/rover-os.css` and `tests/local-path.test.js`. The visual design and
  the original canvas artwork (orbit, terrain, rover, lander) are Naser's.

- **14 Nov (Version 1.2):** Claude Code made three changes at Abood's request:
  playback 1× is now real time (1 mission minute = 60 real seconds) with
  steps 1×/3×/5×/10×/15×; the drive view uses a chase camera behind the rover
  with illustrative terrain anchored to world coordinates (it streams past in
  perspective instead of moving with the rover); the start headline reads "BUILT FOR
  THE UNKNOWN". Engine, API and numbers unchanged.

To be recorded in the team submission notes as required.
