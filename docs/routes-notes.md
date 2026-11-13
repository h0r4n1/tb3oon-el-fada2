# Route engine notes (Abood, Route Engineer)

Plain-English notes on the route maths, for teammates and judges.
All numbers come from `src/config.js` (brief section 6 defaults). They are
tunable prototype assumptions, not NASA or rover-engineering standards.

## Files

| File | What it does |
|---|---|
| `src/config.js` | The one place where mission numbers live (speed, slope limit, battery, etc.). |
| `src/geo.js` | Mars distance (haversine) plus small helpers (`clamp`, `toRadians`). |
| `src/routes.js` | `evaluateSegment(distanceKm, slopeDeg)`: time and energy for one route segment. |
| `tests/*.test.js` | Hand-checked tests. Run them with `npm test`. |

## Distance on Mars (brief section 5)

We treat Mars as a sphere with radius R = 3,389,500 m. Distance between two
`{lat, lon}` points uses the haversine formula:

- a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
- d = 2R·atan2(√a, √(1−a))

`a` is clamped to [0, 1] so rounding can't produce a square root of a negative number.
We don't use Leaflet's distance because it assumes Earth's radius.
**Check:** a 0.001-radian arc along the equator gives 3,389.5 m (R × 0.001).

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

## Open questions

- The brief doesn't name per-segment fields or config keys. We chose
  `q, speedKmh, driveMinutes, energyKWh, feasibility, reasons` and the key
  names in `src/config.js`. Zain and Naser need to agree on these.
- `package.json` is local only until Adi confirms it (needed for `"type": "module"`).
- Slope should come from an elevation gradient. If we only have rise/run
  along the route, cross-slope is missed, and that must be labelled.
