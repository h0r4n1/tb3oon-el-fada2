// Tests for evaluateRoute in server/route-math.js.
// Run with: node --test tests/*.test.js
//
// Defaults (src/config.js): v0 5 km/h, L 15°, e0 0.5 kWh/km, aux 0.2 kW,
// time reserve 15 min, battery reserve 2 kWh. Scenario: 120 min remaining,
// 10 kWh battery, 5 min science stop. Return = same segments reversed.
//
// Values with 3 decimals are rounded hand calculations, so they are checked
// to ±0.0005. Values that are exact by hand are checked to ±1e-9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRoute, FEASIBILITY } from "../server/route-math.js";

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`
  );
}

const EXACT = 1e-9;
const ROUNDED = 0.0005;

// Builds an input object; `overrides` replaces any field for one test.
function makeInput(outboundSegments, overrides = {}) {
  return {
    outboundSegments,
    returnSegments: [...outboundSegments].reverse(), // same slopes, reversed
    stopMinutes: 5,
    remainingMinutes: 120,
    currentBatteryKWh: 10,
    ...overrides,
  };
}

const ROUTE_A = [
  { distanceKm: 1.0, slopeDeg: 3 },
  { distanceKm: 1.0, slopeDeg: 9 },
];
const ROUTE_B = [
  { distanceKm: 1.6, slopeDeg: 2 },
  { distanceKm: 0.8, slopeDeg: 2 },
];

test("Route A: 1 km @3° + 1 km @9° passes with hand-checked numbers", () => {
  // Segments (milestone 1): 16.8 + 26.4 = 43.2 min; 0.7 + 1.1 = 1.8 kWh.
  // S = 100 × [1 − (1×0.2 + 1×0.6) / 2] = 100 × 0.6 = 60
  // T = 43.2 + 5 = 48.2;  H = 120 − 15 = 105
  // U = 100 × (1 − 48.2/105) = 54.095
  // C = 0.7 × 60 + 0.3 × 54.095 = 58.229
  // Return (reversed) = 43.2 min, 1.8 kWh
  // aux = 0.2 × (43.2 + 43.2 + 5) / 60 = 0.30467;  E = 1.8 + 1.8 + 0.30467 = 3.90467
  const r = evaluateRoute(makeInput(ROUTE_A));
  assertClose(r.distanceKm, 2.0, EXACT, "distanceKm");
  assertClose(r.driveMinutes, 43.2, EXACT, "driveMinutes");
  assert.equal(r.stopMinutes, 5);
  assertClose(r.returnMinutes, 43.2, EXACT, "returnMinutes");
  assertClose(r.outboundEnergyKWh, 1.8, EXACT, "outboundEnergyKWh");
  assertClose(r.returnEnergyKWh, 1.8, EXACT, "returnEnergyKWh");
  assertClose(r.totalEnergyKWh, 3.9047, ROUNDED, "totalEnergyKWh");
  assertClose(r.safetyScore, 60, EXACT, "safetyScore");
  assertClose(r.timeScore, 54.095, ROUNDED, "timeScore");
  assertClose(r.overallScore, 58.229, ROUNDED, "overallScore");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
  assert.equal(r.coveragePercent, null);
});

test("Route B: 1.6 km @2° + 0.8 km @2° passes with hand-checked numbers", () => {
  // q = 2/15 = 0.1333;  1 + 2q = 1.2667
  // t = 60 × 1.6 × 1.2667 / 5 = 24.32  and  60 × 0.8 × 1.2667 / 5 = 12.16 -> 36.48 min
  // e = 0.5 × 2.4 × 1.2667 = 1.52 kWh each way
  // S = 100 × (1 − 0.1333) = 86.667;  T = 36.48 + 5 = 41.48
  // U = 100 × (1 − 41.48/105) = 60.495;  C = 0.7 × 86.667 + 0.3 × 60.495 = 78.815
  // E = 1.52 + 1.52 + 0.2 × (36.48 + 36.48 + 5)/60 = 3.29987
  const r = evaluateRoute(makeInput(ROUTE_B));
  assertClose(r.safetyScore, 86.667, ROUNDED, "safetyScore");
  assertClose(r.driveMinutes + r.stopMinutes, 41.48, EXACT, "T");
  assertClose(r.timeScore, 60.495, ROUNDED, "timeScore");
  assertClose(r.overallScore, 78.815, ROUNDED, "overallScore");
  assertClose(r.totalEnergyKWh, 3.2999, ROUNDED, "totalEnergyKWh");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("Route B beats Route A on overall score (70/30 trade-off)", () => {
  const a = evaluateRoute(makeInput(ROUTE_A));
  const b = evaluateRoute(makeInput(ROUTE_B));
  assert.ok(b.overallScore > a.overallScore);
});

test("time equality: 106.4 min passes, 106.3 min is blocked", () => {
  // Needed = T + return + reserve = 48.2 + 43.2 + 15 = 106.4 min.
  const exact = evaluateRoute(makeInput(ROUTE_A, { remainingMinutes: 106.4 }));
  assert.equal(exact.feasibility, FEASIBILITY.PASS, exact.reasons.join(" | "));

  const short = evaluateRoute(makeInput(ROUTE_A, { remainingMinutes: 106.3 }));
  assert.equal(short.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(short.reasons.some((x) => x.includes("Not enough time") && x.includes("0.10 min")));
});

test("battery equality: exact 5.904666... passes, 5.9047 passes, 5.9046 and 5.9 are blocked", () => {
  // Needed = E + reserve = 3.904666... + 2 = 5.904666... = 8857/1500 exactly.
  const cases = [
    [8857 / 1500, FEASIBILITY.PASS],
    [5.9047, FEASIBILITY.PASS],
    [5.9046, FEASIBILITY.BLOCKED],
    [5.9, FEASIBILITY.BLOCKED],
  ];
  for (const [battery, expected] of cases) {
    const r = evaluateRoute(makeInput(ROUTE_A, { currentBatteryKWh: battery }));
    assert.equal(r.feasibility, expected, `battery ${battery}: ${r.reasons.join(" | ")}`);
    if (expected === FEASIBILITY.BLOCKED) {
      assert.ok(r.reasons.some((x) => x.includes("Not enough battery")));
    }
  }
});

test("a 20° outbound segment blocks the route; scores still calculated", () => {
  const r = evaluateRoute(makeInput([{ distanceKm: 1.0, slopeDeg: 20 }]));
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(r.reasons.some((x) => x.includes("Outbound segment 1") && x.includes("exceeds")));
  assert.ok(Number.isFinite(r.overallScore));
});

test("a 20° segment on the RETURN only also blocks; S uses outbound only", () => {
  const r = evaluateRoute({
    ...makeInput([{ distanceKm: 1.0, slopeDeg: 3 }]),
    returnSegments: [{ distanceKm: 1.0, slopeDeg: 20 }],
  });
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(r.reasons.some((x) => x.startsWith("Return segment 1")));
  assertClose(r.safetyScore, 80, EXACT, "safetyScore"); // 100 × (1 − 0.2)
});

test("a null slope makes the route unverified with null scores", () => {
  const r = evaluateRoute(makeInput([
    { distanceKm: 1.0, slopeDeg: 3 },
    { distanceKm: 1.0, slopeDeg: null },
  ]));
  assert.equal(r.feasibility, FEASIBILITY.UNVERIFIED);
  assert.equal(r.safetyScore, null);
  assert.equal(r.timeScore, null);
  assert.equal(r.overallScore, null);
  assert.equal(r.driveMinutes, null);
  assert.equal(r.totalEnergyKWh, null);
  assertClose(r.distanceKm, 2.0, EXACT, "distanceKm (lengths are known)");
});

test("definite blocker + unverified segment -> BLOCKED, null scores, all reasons listed", () => {
  const r = evaluateRoute(makeInput([
    { distanceKm: 1.0, slopeDeg: 20 },
    { distanceKm: 1.0, slopeDeg: null },
  ]));
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.equal(r.overallScore, null);
  assert.ok(r.reasons.some((x) => x.includes("exceeds")));
  assert.ok(r.reasons.some((x) => x.includes("slope is missing")));
});

test("returnSegments null -> blocked with a no-return-path reason", () => {
  const r = evaluateRoute(makeInput(ROUTE_A, { returnSegments: null }));
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(r.reasons.some((x) => x.includes("No return path")));
  assert.equal(r.returnMinutes, null);
  assert.equal(r.totalEnergyKWh, null);
});

test("returnSegments [] while outbound leaves base -> unverified (missing data)", () => {
  const r = evaluateRoute(makeInput(ROUTE_A, { returnSegments: [] }));
  assert.equal(r.feasibility, FEASIBILITY.UNVERIFIED);
  assert.ok(r.reasons.some((x) => x.includes("Return route is empty")));
  assert.equal(r.returnMinutes, null);
  assert.equal(r.overallScore, null);
});

test("H <= 0 -> blocked, timeScore and overallScore null, no NaN/Infinity", () => {
  // 15 min remaining − 15 min reserve = 0 usable minutes.
  const r = evaluateRoute(makeInput(ROUTE_A, { remainingMinutes: 15 }));
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(r.reasons.some((x) => x.includes("No usable mission time")));
  assert.equal(r.timeScore, null);
  assert.equal(r.overallScore, null);
  assertClose(r.safetyScore, 60, EXACT, "safetyScore still known");

  const negative = evaluateRoute(makeInput(ROUTE_A, { remainingMinutes: 10 }));
  assert.equal(negative.feasibility, FEASIBILITY.BLOCKED);
  assert.equal(negative.timeScore, null);
});

test("zero-distance route: only stop + auxiliary costs; safety and overall N/A", () => {
  // Drive 0 min, 0 kWh. T = 0 + 5 = 5;  U = 100 × (1 − 5/105) = 95.238
  // E = 0 + 0 + 0.2 × 5 / 60 = 0.016667 kWh
  for (const outbound of [[], [{ distanceKm: 0, slopeDeg: 3 }]]) {
    const r = evaluateRoute({ ...makeInput(outbound), returnSegments: [] });
    assert.equal(r.feasibility, FEASIBILITY.PASS, r.reasons.join(" | "));
    assert.equal(r.distanceKm, 0);
    assert.equal(r.driveMinutes, 0);
    assert.equal(r.returnMinutes, 0);
    assert.equal(r.outboundEnergyKWh, 0);
    assert.equal(r.returnEnergyKWh, 0);
    assertClose(r.totalEnergyKWh, 0.2 * 5 / 60, EXACT, "totalEnergyKWh");
    assert.equal(r.safetyScore, null);
    assertClose(r.timeScore, 95.238, ROUNDED, "timeScore");
    assert.equal(r.overallScore, null);
  }
});

test("missing scenario inputs -> unverified, null scores (never 0)", () => {
  for (const field of ["remainingMinutes", "currentBatteryKWh", "stopMinutes"]) {
    const r = evaluateRoute(makeInput(ROUTE_A, { [field]: null }));
    assert.equal(r.feasibility, FEASIBILITY.UNVERIFIED, field);
    assert.equal(r.overallScore, null, field);
  }
  const nothing = evaluateRoute(undefined);
  assert.equal(nothing.feasibility, FEASIBILITY.UNVERIFIED);
});
