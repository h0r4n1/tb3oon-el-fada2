// Tests for server/route-math.js (evaluateSegment). Run with: node --test tests/*.test.js
//
// Every expected value below was calculated by hand from the brief's
// section 6 formulas with the default config (v0 = 5 km/h, L = 15°,
// e0 = 0.5 kWh/km). The working is shown in each test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSegment, FEASIBILITY } from "../server/route-math.js";

const TOL = 1e-9; // tolerance for exact-by-hand values

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`
  );
}

test("1.0 km at 3° -> q 0.2, 3.571 km/h, 16.8 min, 0.7 kWh", () => {
  // q = 3/15 = 0.2;  v = 5/(1+0.4) = 3.5714...;  t = 60×1/3.5714 = 16.8;
  // e = 0.5×1×1.4 = 0.7
  const r = evaluateSegment(1.0, 3);
  assertClose(r.q, 0.2, TOL, "q");
  assertClose(r.speedKmh, 3.571, 0.0005, "speed (km/h)"); // 3.571 is rounded
  assertClose(r.driveMinutes, 16.8, TOL, "minutes");
  assertClose(r.energyKWh, 0.7, TOL, "energy (kWh)");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("1.0 km at 9° -> q 0.6, 2.273 km/h, 26.4 min, 1.1 kWh", () => {
  // q = 9/15 = 0.6;  v = 5/(1+1.2) = 2.2727...;  t = 60×1/2.2727 = 26.4;
  // e = 0.5×1×2.2 = 1.1
  const r = evaluateSegment(1.0, 9);
  assertClose(r.q, 0.6, TOL, "q");
  assertClose(r.speedKmh, 2.273, 0.0005, "speed (km/h)");
  assertClose(r.driveMinutes, 26.4, TOL, "minutes");
  assertClose(r.energyKWh, 1.1, TOL, "energy (kWh)");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("flat: 1.0 km at 0° -> q 0, 5 km/h, 12 min, 0.5 kWh", () => {
  // q = 0;  v = 5/1 = 5;  t = 60×1/5 = 12;  e = 0.5×1×1 = 0.5
  const r = evaluateSegment(1.0, 0);
  assert.equal(r.q, 0);
  assertClose(r.speedKmh, 5, TOL, "speed (km/h)");
  assertClose(r.driveMinutes, 12, TOL, "minutes");
  assertClose(r.energyKWh, 0.5, TOL, "energy (kWh)");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("exactly at the limit (15°) is allowed", () => {
  // q = 15/15 = 1;  v = 5/3 = 1.667;  t = 60×1/(5/3) = 36;  e = 0.5×1×3 = 1.5
  const r = evaluateSegment(1.0, 15);
  assert.equal(r.q, 1);
  assertClose(r.driveMinutes, 36, TOL, "minutes");
  assertClose(r.energyKWh, 1.5, TOL, "energy (kWh)");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("above 15° (20°) -> q clamped to 1 and segment blocked", () => {
  // q = clamp(20/15 = 1.333, 0, 1) = 1;  same numbers as 15°, but blocked.
  const r = evaluateSegment(1.0, 20);
  assert.equal(r.q, 1);
  assertClose(r.speedKmh, 5 / 3, TOL, "speed (km/h)");
  assertClose(r.driveMinutes, 36, TOL, "minutes");
  assertClose(r.energyKWh, 1.5, TOL, "energy (kWh)");
  assert.equal(r.feasibility, FEASIBILITY.BLOCKED);
  assert.ok(r.reasons.length > 0, "a reason is given");
});

test("zero-length segment -> 0 min, 0 kWh, no division by zero", () => {
  const r = evaluateSegment(0, 9);
  assert.equal(r.driveMinutes, 0);
  assert.equal(r.energyKWh, 0);
  assert.ok(Number.isFinite(r.speedKmh), "speed is a real number");
  assert.equal(r.feasibility, FEASIBILITY.PASS);
});

test("negative slope -> all null, unverified", () => {
  const r = evaluateSegment(1.0, -3);
  assert.equal(r.q, null);
  assert.equal(r.speedKmh, null);
  assert.equal(r.driveMinutes, null);
  assert.equal(r.energyKWh, null);
  assert.equal(r.feasibility, FEASIBILITY.UNVERIFIED);
});

test("missing slope or length -> null (never 0), unverified", () => {
  for (const [d, s] of [[1.0, null], [1.0, undefined], [null, 3], [1.0, NaN], [-1, 3]]) {
    const r = evaluateSegment(d, s);
    assert.equal(r.driveMinutes, null, `d=${d}, s=${s}`);
    assert.equal(r.energyKWh, null, `d=${d}, s=${s}`);
    assert.equal(r.feasibility, FEASIBILITY.UNVERIFIED, `d=${d}, s=${s}`);
  }
});
