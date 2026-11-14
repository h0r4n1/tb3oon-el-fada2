// Tests for server/traverse.js. Run with: node --test tests/*.test.js
//
// Uses the SYNTHETIC traverse in tests/fixtures/synthetic-traverse.geojson
// (not Mars data). Map, in km east (x) / north (y) of lat 0, lon 0:
//   sol 1:  (0,0) -> (2,0), rising 5 m per 100 m      -> slope atan(0.05) = 2.8624°
//   sol 2:  (2,0) -> (2,1), flat, NO-DATA for y 0.50..0.52 km
//   sol 3:  (2,1) -> (1,1) -> (1,0.012)               -> passes (1,0) again, 12 m away
//   sol 10: (1.2,-0.3) -> (1.8,-0.3)                  -> after a ~371 m GAP
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTraverse,
  cleanElevation,
  loadTraverse,
  segmentSlice,
  sliceVertices,
  snapToTraverse,
  SNAP_TOLERANCE_M,
} from "../server/traverse.js";

const traverse = buildTraverse(
  JSON.parse(readFileSync(new URL("./fixtures/synthetic-traverse.geojson", import.meta.url), "utf8"))
);
const k = 180 / (Math.PI * 3389.5); // 1 km on Mars, in degrees
const at = (x, y) => ({ lat: y * k, lon: x * k }); // km grid -> {lat, lon}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`);
}

test("cleanElevation: the 2.2e-05 marker and anything above -100 m become null (never 0)", () => {
  assert.equal(cleanElevation(2.2e-5), null);
  assert.equal(cleanElevation(-50), null);
  assert.equal(cleanElevation(null), null);
  assert.equal(cleanElevation(Number.NaN), null);
  assert.equal(cleanElevation(-2569.91), -2569.91);
});

test("buildTraverse: duplicates dropped, cumulative distance, one gap, two runs", () => {
  assert.equal(traverse.isSynthetic, true);
  assert.equal(traverse.gaps.length, 1, "exactly one gap (before sol 10)");
  assert.equal(traverse.gaps[0].sol, 10);
  assert.ok(traverse.gaps[0].gapM > 300, "the gap is ~371 m wide");
  const runs = new Set(traverse.vertices.map((v) => v.runIndex));
  assert.deepEqual([...runs], [0, 1]);

  // No two neighbouring vertices are identical.
  for (let i = 1; i < traverse.vertices.length; i++) {
    const a = traverse.vertices[i - 1], b = traverse.vertices[i];
    assert.ok(a.lon !== b.lon || a.lat !== b.lat, `duplicate at ${i}`);
  }
  // Along-path distance: sol 1 (2 km) + sol 2 (1 km) + sol 3 (1 + 0.988 km) = 4,988 m.
  // Tolerance 1 mm: the sol 3 west leg follows a line of latitude, which on a
  // sphere is 0.04 mm shorter than on a flat sheet of paper.
  const lastOfRun0 = traverse.vertices.filter((v) => v.runIndex === 0).at(-1);
  assertClose(lastOfRun0.cumulativeM, 4988, 0.001, "cumulative metres at the end of run 0");
  // The gap's width is NOT counted: run 1 starts at the same cumulative distance.
  const firstOfRun1 = traverse.vertices.find((v) => v.runIndex === 1);
  assert.equal(firstOfRun1.cumulativeM, lastOfRun0.cumulativeM, "run 1 starts where run 0 ended");
});

test("snapToTraverse: (1,0) is near the traverse twice -> two passes (sol 1 and sol 3)", () => {
  const snap = snapToTraverse(traverse, at(1, 0));
  assert.equal(snap.passes.length, 2);
  assert.deepEqual(snap.passes.map((p) => p.sol), [1, 3]); // closest first: 0 m, then 12 m
  assertClose(snap.passes[0].distanceM, 0, 1e-6, "sol 1 pass distance");
  assertClose(snap.passes[1].distanceM, 12, 1e-6, "sol 3 pass distance");
});

test("snapToTraverse: a point far from the traverse has no passes and reports the distance", () => {
  const snap = snapToTraverse(traverse, at(0.5, 0.5)); // 500 m from the nearest line
  assert.equal(snap.passes.length, 0);
  assertClose(snap.nearestM, 500, 1e-6, "nearest metres");
  assert.ok(snap.nearestM > SNAP_TOLERANCE_M);
});

test("sliceVertices: works in both directions and refuses to cross a gap", () => {
  const forwards = sliceVertices(traverse, 0, 100);
  const backwards = sliceVertices(traverse, 100, 0);
  assert.equal(forwards.length, 101);
  assert.deepEqual(backwards, [...forwards].reverse());
  const lastIndex = traverse.vertices.length - 1; // in run 1, after the gap
  assert.equal(sliceVertices(traverse, 0, lastIndex), null);
});

test("segmentSlice: 2 km of sol 1 -> forty 50 m segments at 2.8624° (hand-checked)", () => {
  // Rise 2.5 m per 50 m: slope = atan(2.5 / 50) = atan(0.05) = 2.86241°.
  const segments = segmentSlice(sliceVertices(traverse, 0, 200));
  assert.equal(segments.length, 40);
  for (const s of segments) {
    assertClose(s.distanceKm, 0.05, 1e-9, "segment km");
    assertClose(s.slopeDeg, 2.86241, 0.00001, "slope degrees");
    assert.equal(s.method, "along-track-rise-run");
  }
});

test("segmentSlice: a window touching a no-data elevation has slope null", () => {
  // Along sol 2 (indices 200..300), y from 0 to 1 km; no-data at y 0.50..0.52.
  const segments = segmentSlice(sliceVertices(traverse, 200, 300));
  const unknown = segments.filter((s) => s.slopeDeg === null);
  assert.ok(unknown.length >= 1 && unknown.length <= 2, `${unknown.length} unknown windows`);
  assert.ok(segments.some((s) => s.slopeDeg === 0), "the flat parts are known (0°)");
});

test("segmentSlice: a short leftover (< 25 m) is merged into the previous window", () => {
  // 0..7 = 70 m: one 50 m window + 20 m leftover -> merged into one 70 m segment.
  const segments = segmentSlice(sliceVertices(traverse, 0, 7));
  assert.equal(segments.length, 1);
  assertClose(segments[0].distanceKm, 0.07, 1e-9, "merged km");
  // 0..8 = 80 m: 50 m + 30 m leftover -> kept as two segments.
  assert.equal(segmentSlice(sliceVertices(traverse, 0, 8)).length, 2);
});

test("segmentSlice: zero or one vertex -> no segments (zero distance)", () => {
  assert.deepEqual(segmentSlice([traverse.vertices[0]]), []);
  assert.deepEqual(segmentSlice([]), []);
});

test("loadTraverse: parses once per loader (cached) and passes DATA_NOT_READY through", async () => {
  let reads = 0;
  const loader = async () => {
    reads += 1;
    return JSON.parse(readFileSync(new URL("./fixtures/synthetic-traverse.geojson", import.meta.url), "utf8"));
  };
  const first = await loadTraverse(loader);
  const second = await loadTraverse(loader);
  assert.equal(first, second);
  assert.equal(reads, 1);

  const { ApiError } = await import("../server/errors.ts");
  const missing = async () => {
    throw new ApiError(503, "DATA_NOT_READY", "not yet");
  };
  await assert.rejects(loadTraverse(missing), { code: "DATA_NOT_READY" });
});
