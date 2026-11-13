# Route engine notes (Abood, Route Engineer)

Plain-English notes on the route maths, for teammates and judges.
All numbers come from `MISSION_CONFIG` in `server/config.ts` (owned by the
backend team; brief section 6 defaults). They are tunable prototype
assumptions, not NASA or rover-engineering standards.

## Files

The route engine runs on the server (Node), never in `src/` (the frontend).

| File | What it does |
|---|---|
| `server/route-engine.js` | `planRoutes(request)`: the API's entry point. Loads data, matches, evaluates, ranks. |
| `server/candidates.js` | Reads and checks `candidates.json` and `targets.geojson`, turns paths into segments, matches routes to a request, adds up stops and science. |
| `server/ranking.js` | Removes duplicate paths and assigns the Recommended / Fastest / Science-focused roles. |
| `server/route-math.js` | `evaluateSegment` (one segment) and `evaluateRoute` (whole route with return trip, scores and verdict). |
| `server/geo.js` | Mars distance (haversine), `pathDistanceKm` for GeoJSON polylines, plus small helpers (`clamp`, `toRadians`). |
| `tests/*.test.js` | My hand-checked tests. Run them with `node --test tests/*.test.js` (the team's `npm test` runs only the API tests). |
| `tests/fixtures/` | **Synthetic** demonstration data for tests only. Not Mars observations. |

Config key names used (from `server/config.ts`): `flatSpeedKmh`,
`maxSlopeDegrees`, `baselineKWhPerKm`, `minimumTimeReserveMinutes`,
`batteryCapacityKWh`, `batteryReservePercent` (a percent: reserve kWh =
capacity × percent / 100 = 2 kWh), `auxiliaryKW`, `defaultStopMinutes`,
`terrainWeight`, `timeWeight`, `marsRadiusM`.

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

## Planning and ranking: `planRoutes(request)` (brief sections 6 and 7)

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
6. The routes are ranked:
   - **Duplicates:** identical outbound + return paths are shown once.
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

## Known limitations / milestone 4

- **Forbidden areas are not implemented.** The brief blocks routes that cross
  a verified forbidden area, but no such data exists yet.
- **Mid-mission replanning is not designed yet.** Curated routes start at
  base, so a request whose origin is the rover's current position matches
  nothing.
  - **Return from midway (proposal):** retrace the already-known outbound path
    backwards. Take the active route's points up to the rover's current
    position, reverse them, and reuse the same per-segment slopes. The first
    piece is the partial segment the rover is on: its length comes from the
    current position to the previous point, and it keeps that segment's slope.
    This uses only terrain we already evaluated. It never draws a new straight
    line through unknown ground. Budgets use the *current* remaining minutes and
    battery, so time and energy already used are preserved.
  - **Add stop while paused:** the data would need either (a) curated legs
    from points along the active route to each candidate stop and back onto
    the route or to base, each with per-segment slopes, or (b) an elevation
    grid (bounds, spacing, slope or elevation, nodata mask) so a graph search
    can build those legs. We'd also need the rover's position as an index along
    the active route, plus the stop's `stopMinutes` and `scienceValue`.
    The replan must be previewed and committed only on Accept.
- **No terrain coverage yet:** `coveragePercent` is `null` until the data
  gives it.

## Open questions

- **For Adi: `tests/api.test.ts:110` must expect `DATA_NOT_READY`.** The test
  uses the real engine. It used to expect the placeholder's `ENGINE_NOT_READY`.
  Now the engine runs and reports that `candidates.json` is missing, which is
  still a 503 with no fake route. Until that line changes, `npm test` shows 1
  failure.
- **For Adi: make `scienceValue` nullable in `server/contracts.ts`.** The
  contract forces a number, even when a visited target has no rating. Current
  workaround: count only rated targets, name the unrated ones in `reasons`, and
  exclude the route from Science-focused.
- **For Adi: add `routeMatchToleranceM` (50) to `server/config.ts`.** Until then
  it's a named constant in `server/candidates.js`.
- **For Adi: `npm test` could include `tests/*.test.js`** so the route-engine
  tests run in the build too.
- **For Zain: there is no `returnDistanceKm` field in the Candidate contract.**
  The brief says outbound and return distances are separate, but only
  `distanceKm` (outbound) exists. Adding it is a contract change, so it needs
  Zain's coordination and a brief version update.
- Slope should come from an elevation gradient. If we only have rise/run
  along the route, cross-slope is missed. The engine labels this in `reasons`.

## AI assistance

The route engine code (`server/geo.js`, `server/route-math.js`,
`server/ranking.js`, `server/candidates.js`, `server/route-engine.js`), its
tests and fixtures in `tests/`, and these notes were written by **Claude Code
(Anthropic)** at the direction of Abood (Route Engineer). Abood set the
requirements, approved each plan before any code was written, decided the open
design questions (recorded above), and reviewed the code with plain-English
explanations. All formulas come from the team brief, and the test values were
checked by hand. To be recorded in the team submission notes as required.
