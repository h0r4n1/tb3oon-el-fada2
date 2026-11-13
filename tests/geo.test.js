// Tests for src/geo.js. Run with: npm test   (or: node --test tests/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineDistanceM, clamp, pathDistanceKm } from "../src/geo.js";

// Decimals are not stored exactly in computers, so we compare
// "close enough" instead of exactly equal.
function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`
  );
}

test("brief fixture: 0.001 radian equatorial arc = 3,389.5 m", () => {
  // Hand calculation: arc length = R × angle = 3,389,500 × 0.001 = 3,389.5 m.
  // 0.001 radians converted to degrees = 0.001 × 180 / PI.
  const lonDeg = (0.001 * 180) / Math.PI;
  const d = haversineDistanceM({ lat: 0, lon: 0 }, { lat: 0, lon: lonDeg });
  assertClose(d, 3389.5, 1e-6, "distance (m)");
});

test("same point is 0 m", () => {
  assert.equal(haversineDistanceM({ lat: 18.4, lon: 77.5 }, { lat: 18.4, lon: 77.5 }), 0);
});

test("opposite sides of Mars = half the circumference (clamp keeps it from NaN)", () => {
  // Hand calculation: PI × R = 3.14159... × 3,389,500 ≈ 10,648,433 m.
  const d = haversineDistanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
  assertClose(d, Math.PI * 3389500, 1e-3, "distance (m)");
});

test("missing or invalid points return null, never 0", () => {
  const ok = { lat: 0, lon: 0 };
  assert.equal(haversineDistanceM(null, ok), null);
  assert.equal(haversineDistanceM(ok, { lat: null, lon: 0 }), null);
  assert.equal(haversineDistanceM(ok, { lat: 0 }), null);
  assert.equal(haversineDistanceM(ok, { lat: 95, lon: 0 }), null);
  assert.equal(haversineDistanceM(ok, { lat: "1", lon: 0 }), null);
});

test("clamp keeps values in range", () => {
  assert.equal(clamp(1.3, 0, 1), 1);
  assert.equal(clamp(-0.2, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

// ---------------- Milestone 2: pathDistanceKm ----------------

test("pathDistanceKm: 0.001 rad equatorial polyline = 3.3895 km", () => {
  // GeoJSON order is [lon, lat]. 3,389.5 m ÷ 1000 = 3.3895 km.
  const lonDeg = (0.001 * 180) / Math.PI;
  assertClose(pathDistanceKm([[0, 0], [lonDeg, 0]]), 3.3895, 1e-9, "km");
});

test("pathDistanceKm: adds up several pieces", () => {
  // Two 0.001 rad steps along the equator = 2 × 3.3895 = 6.779 km.
  const step = (0.001 * 180) / Math.PI;
  assertClose(pathDistanceKm([[0, 0], [step, 0], [2 * step, 0]]), 6.779, 1e-9, "km");
});

test("pathDistanceKm: invalid point, empty list or non-list -> null", () => {
  assert.equal(pathDistanceKm([[0, 0], [null, 0]]), null);
  assert.equal(pathDistanceKm([[0, 0], [0, 95]]), null); // latitude 95 is impossible
  assert.equal(pathDistanceKm([[0, 0], [5]]), null); // pair missing a value
  assert.equal(pathDistanceKm([]), null);
  assert.equal(pathDistanceKm(null), null);
});

test("pathDistanceKm: a single point is 0 km; altitude values are ignored", () => {
  assert.equal(pathDistanceKm([[77.5, 18.4]]), 0);
  const lonDeg = (0.001 * 180) / Math.PI;
  assertClose(pathDistanceKm([[0, 0, -2500], [lonDeg, 0, -2400]]), 3.3895, 1e-9, "km");
});
