# Route engine notes (Abood, Route Engineer)

Plain-English notes on the route maths, for teammates and judges.
All numbers come from `src/config.js` (brief section 6 defaults). They are
tunable prototype assumptions, not NASA or rover-engineering standards.

## Files

| File | What it does |
|---|---|
| `src/config.js` | The one place where mission numbers live (speed, slope limit, battery, etc.). |
| `src/geo.js` | Mars distance (haversine), `pathDistanceKm` for GeoJSON polylines, plus small helpers (`clamp`, `toRadians`). |
| `src/routes.js` | `evaluateSegment` (one segment) and `evaluateRoute` (whole route with return trip, scores and verdict). |
| `tests/*.test.js` | Hand-checked tests. Run them with `npm test`. |

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
| C | 0.70 S + 0.30 U | Overall score, kept at full precision (round for display only) |
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

## Open questions

- **For Zain: there is no `returnDistanceKm` field in the Candidate contract.**
  The brief says outbound and return distances are separate, but only
  `distanceKm` (outbound) exists. `evaluateRoute` calculates the return distance
  internally but doesn't output it. Adding it is a contract change, so it needs
  Zain's coordination and a brief version update.
- The 0.70 / 0.30 score weights are named constants in `src/routes.js`. They
  could move into `src/config.js` if the team wants them tunable there.
- `coveragePercent` is `null` until Zaid's terrain coverage data is available.

- The brief doesn't name per-segment fields or config keys. We chose
  `q, speedKmh, driveMinutes, energyKWh, feasibility, reasons` and the key
  names in `src/config.js`. Zain and Naser need to agree on these.
- `package.json` is local only until Adi confirms it (needed for `"type": "module"`).
- Slope should come from an elevation gradient. If we only have rise/run
  along the route, cross-slope is missed, and that must be labelled.
