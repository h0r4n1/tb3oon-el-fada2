// Tests for TRAVERSE mode of planRoutes (server/traverse-planner.js).
// Run with: node --test tests/*.test.js
//
// SYNTHETIC fixtures only (tests/fixtures/synthetic-traverse*.geojson), not Mars data.
// Map in km east (x) / north (y) of lat 0, lon 0 (base at (0,0)):
//   sol 1: (0,0) -> (2,0) rising 5 m / 100 m;  sol 2: (2,0) -> (2,1) flat, no-data at y 0.50-0.52;
//   sol 3: (2,1) -> (1,1) -> (1,0.012);       sol 10: (1.2,-0.3) -> (1.8,-0.3) after a gap.
// Targets: syn-quarter (0.5,0) sci 1 | syn-cross (1,0) sci 3 | syn-east (2,0) sci 2 |
//          syn-north (2,0.3) sci 3 | syn-island (1.5,-0.3) sci 3 | syn-far (0,5) sci 2.
//
// HAND CALCULATION for sol 1 (used below). Slope = atan(0.05) = 2.86241°,
// q = 2.86241 / 15 = 0.190827, (1 + 2q) = 1.381655.
//   per km: drive = 60 × 1.381655 / 5 = 16.5799 min; energy = 0.5 × 1.381655 = 0.690827 kWh.
// Base -> syn-east (2 km), return 2 km, 5 min stop at syn-east:
//   drive 33.1597 min each way; energy 1.381655 kWh each way
//   T = 38.1597; S = 100 × (1 − 0.190827) = 80.9173
//   U = 100 × (1 − 38.1597/105) = 63.6574;  C = 0.7 × 80.9173 + 0.3 × 63.6574 = 75.7393
//   E = 2.76331 + 0.2 × (33.1597 + 33.1597 + 5)/60 = 3.00104 kWh
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planRoutes } from "../server/route-engine.js";
import { routeResultSchema } from "../server/contracts.ts";
import { MISSION_CONFIG } from "../server/config.js";
import { ApiError } from "../server/errors.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const TRAVERSE_FILES = {
  "map-layers/rover_path_2d.geojson": "synthetic-traverse.geojson",
  "targets.geojson": "synthetic-traverse-targets.geojson",
};

// makeLoader: stands in for loadJsonData. Files it doesn't have give
// DATA_NOT_READY, exactly like the real loader does for a missing file.
function makeLoader(files = TRAVERSE_FILES) {
  return async (filename) => {
    if (!files[filename]) throw new ApiError(503, "DATA_NOT_READY", `${filename} not supplied (test).`);
    return JSON.parse(await readFile(new URL(files[filename], FIXTURES), "utf8"));
  };
}

const k = 180 / (Math.PI * 3389.5); // 1 km on Mars, in degrees
const at = (x, y) => ({ lat: y * k, lon: x * k });
const BASE = at(0, 0);

function makeRequest(overrides = {}) {
  return {
    requestId: "trv-req", regionId: "synthetic-test", dataVersion: "synthetic-v1",
    origin: BASE, base: BASE, destination: at(2, 0), stopIds: [],
    remainingMinutes: 120, currentBatteryKWh: 10, config: MISSION_CONFIG,
    ...overrides,
  };
}
const plan = (overrides, loader = makeLoader()) => planRoutes(makeRequest(overrides), { loadData: loader });

function assertClose(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`);
}
const ROUNDED = 0.0005;
const hasReason = (c, text) => c.reasons.some((r) => r.includes(text));
const isDetour = (c) => c.id.includes("+detour-");

test("base -> syn-east: outbound and return follow the traverse (hand-checked numbers)", async () => {
  const result = await plan();
  const main = result.candidates.find((c) => !isDetour(c));
  assert.equal(main.feasibility, "pass");
  assertClose(main.distanceKm, 2, 1e-9, "distanceKm");
  assertClose(main.driveMinutes, 33.1597, ROUNDED, "driveMinutes");
  assertClose(main.returnMinutes, 33.1597, ROUNDED, "returnMinutes");
  assertClose(main.outboundEnergyKWh, 1.381655, 1e-6, "outboundEnergyKWh");
  assertClose(main.safetyScore, 80.9173, ROUNDED, "safetyScore");
  assertClose(main.timeScore, 63.6574, ROUNDED, "timeScore");
  assertClose(main.overallScore, 75.7393, ROUNDED, "overallScore");
  assertClose(main.totalEnergyKWh, 3.00104, ROUNDED, "totalEnergyKWh");
  assert.equal(main.stopMinutes, 5, "syn-east is the destination target -> final stop");
  assert.equal(main.scienceValue, 2);
  assert.equal(main.coveragePercent, 100);

  // The path is the traverse itself: starts at base, ends at (2,0), return reversed.
  assert.deepEqual(main.geometry[0], [0, 0]);
  assertClose(main.geometry.at(-1)[0], 2 * k, 1e-12, "end lon");
  assert.deepEqual(main.returnGeometry, [...main.geometry].reverse());

  // Honesty notes (synthetic fixture -> SYNTHETIC line instead of the Perseverance one).
  assert.ok(hasReason(main, "SYNTHETIC test traverse"));
  assert.ok(hasReason(main, "cross-slope is not captured"));
  assert.ok(hasReason(main, "vertical datum are unverified"));
  assert.ok(hasReason(main, 'Destination matches listed target "syn-east"'));
  assert.ok(routeResultSchema.safeParse(result).success);
});

test("destination target counts once even if it is also in stopIds", async () => {
  const result = await plan({ stopIds: ["syn-east"] });
  const main = result.candidates.find((c) => !isDetour(c));
  assert.equal(main.stopMinutes, 5); // not 10
  assert.equal(main.scienceValue, 2); // not 4
});

test("a destination across a data gap gets no route and a clear error", async () => {
  const result = await plan({ destination: at(1.5, -0.3) }); // syn-island, after the gap
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((m) => m.includes("would cross a gap")));
});

test("a no-data elevation on the way makes the route unverified with null scores", async () => {
  // (2, 0.8) is reached along sol 2, through the no-data patch at y 0.50-0.52.
  const result = await plan({ destination: at(2, 0.8) });
  const main = result.candidates.find((c) => !isDetour(c));
  assert.equal(main.feasibility, "unverified");
  assert.equal(main.overallScore, null);
  assert.ok(main.coveragePercent > 90 && main.coveragePercent < 100, `coverage ${main.coveragePercent}`);
  assert.ok(hasReason(main, "Terrain slope is missing or unknown"));
});

test("snapping: a destination 500 m from the traverse is refused with its distance", async () => {
  const result = await plan({ destination: at(0.5, 0.5) });
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((m) => m.startsWith("Destination is not on the traverse") && m.includes("500 m")));
});

test("ambiguity: (1,0) is passed twice -> one candidate per pass, labelled with its sol", async () => {
  const result = await plan({ destination: at(1, 0) });
  const mains = result.candidates.filter((c) => !isDetour(c));
  assert.equal(mains.length, 2);
  const viaSol1 = mains.find((c) => hasReason(c, "Destination matched the traverse pass from sol 1"));
  const viaSol3 = mains.find((c) => hasReason(c, "Destination matched the traverse pass from sol 3"));
  assert.ok(viaSol1 && viaSol3, "both passes are offered and labelled");
  assertClose(viaSol1.distanceKm, 1, 1e-9, "direct pass km");
  assertClose(viaSol3.distanceKm, 4.988, 0.001, "loop pass km");
  assert.ok(hasReason(viaSol1, "near the traverse at 2 places"));
  // The short direct route is recommended and listed first.
  assert.equal(result.candidates[0].id, viaSol1.id);
  assert.ok(hasReason(viaSol1, "Recommended:"));
});

test("mid-mission origin: plans from the rover's current position; return still goes to base", async () => {
  // Rover at (0.6, 0): outbound 1.4 km, return (2,0) -> base 2 km.
  const result = await plan({ origin: at(0.6, 0) });
  const main = result.candidates.find((c) => !isDetour(c));
  assertClose(main.distanceKm, 1.4, 1e-9, "outbound km");
  assertClose(main.driveMinutes, 1.4 * 16.5799, ROUNDED, "outbound minutes");
  assertClose(main.returnMinutes, 33.1597, ROUNDED, "return minutes (to base, not to the origin)");
  assertClose(main.geometry[0][0], 0.6 * k, 1e-12, "starts at the rover");
  assert.deepEqual(main.returnGeometry.at(-1), [0, 0]);
});

test("return to base (destination = base): outbound empty, the drive home is the return leg", async () => {
  // Rover at (0.6, 0): return 0.6 km = 0.6 × 16.5799 = 9.9479 min.
  const result = await plan({ origin: at(0.6, 0), destination: BASE });
  assert.equal(result.candidates.length, 1);
  const [home] = result.candidates;
  assert.equal(home.distanceKm, 0);
  assert.equal(home.driveMinutes, 0);
  assertClose(home.returnMinutes, 0.6 * 16.5799, ROUNDED, "return minutes");
  assert.equal(home.safetyScore, null); // N/A for zero outbound distance
  assert.equal(home.overallScore, null);
  assert.equal(home.feasibility, "pass");
  assert.ok(hasReason(home, "Return-to-base plan"));
  assert.ok(routeResultSchema.safeParse(result).success);
});

test("stops out of order are refused with a reason", async () => {
  // Travelling east, syn-quarter (0.5 km) comes BEFORE syn-cross (1 km).
  const result = await plan({ stopIds: ["syn-cross", "syn-quarter"] });
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((m) => m.includes("not in travel order")));

  const inOrder = await plan({ stopIds: ["syn-quarter", "syn-cross"] });
  const main = inOrder.candidates.find((c) => !isDetour(c));
  assert.equal(main.stopMinutes, 15); // quarter + cross + destination syn-east
  assert.equal(main.scienceValue, 1 + 3 + 2);
});

test("a stop that is not on the outbound slice is refused; unknown ids too", async () => {
  const offRoute = await plan({ stopIds: ["syn-north"] });
  assert.ok(offRoute.errors.some((m) => m.includes('"syn-north" is not on the traverse between')));
  const unknown = await plan({ stopIds: ["no-such-target"] });
  assert.ok(unknown.errors.some((m) => m.includes('"no-such-target" is not a listed target')));
});

test("science detours: on-the-way stops and an extension, each with costs and reserves", async () => {
  const result = await plan();
  const detours = result.candidates.filter(isDetour);
  assert.equal(detours.length, 3, "limit of 3 suggestions");

  // Highest science first: syn-cross (3, on the way) and syn-north (3, extension), then syn-quarter (1).
  const cross = detours.find((c) => hasReason(c, '"syn-cross"'));
  const north = detours.find((c) => hasReason(c, '"syn-north"'));
  const quarter = detours.find((c) => hasReason(c, '"syn-quarter"'));
  assert.ok(cross && north && quarter);

  // On the way: no extra driving, +5 min stop, +0.2 × 5/60 = +0.017 kWh.
  assert.ok(hasReason(cross, "stop on the way, no extra driving"));
  assert.ok(hasReason(cross, "+5.0 min, +0.017 kWh"));
  assert.ok(hasReason(cross, "After returning to base:"));

  // Extension to (2, 0.3): +0.3 km flat each way: +3.6 min each way, +0.15 kWh each way,
  // +5 min stop; extra aux = 0.2 × (7.2 + 5)/60 = 0.0407 -> +12.2 min, +0.341 kWh.
  assert.ok(hasReason(north, "extension beyond the destination, +0.30 km each way"));
  assert.ok(hasReason(north, "+12.2 min, +0.341 kWh"));
  assertClose(north.distanceKm, 2.3, 1e-9, "extended outbound km");
  assert.equal(north.scienceValue, 2 + 3, "old destination target is now an intermediate stop");
});

test("an excessive detour is still returned, blocked, with its reasons", async () => {
  // Battery 5.2 kWh: main trip needs 3.00104 + 2 reserve = 5.001 (pass);
  // the syn-north extension needs 3.00104 + 0.341 + 2 = 5.342 (blocked).
  const result = await plan({ currentBatteryKWh: 5.2 });
  const main = result.candidates.find((c) => !isDetour(c));
  const north = result.candidates.find((c) => hasReason(c, '"syn-north"'));
  assert.equal(main.feasibility, "pass");
  assert.equal(north.feasibility, "blocked");
  assert.ok(hasReason(north, "Not enough battery"));
  assert.ok(hasReason(north, "short of the 2 kWh battery reserve"));
  // Blocked candidates come after eligible ones.
  assert.ok(result.candidates.indexOf(north) > result.candidates.indexOf(main));
});

test("same path with different stops are different itineraries (not de-duplicated)", async () => {
  const result = await plan();
  const main = result.candidates.find((c) => !isDetour(c));
  const cross = result.candidates.find((c) => hasReason(c, '"syn-cross"'));
  assert.deepEqual(cross.geometry, main.geometry, "identical path on the ground");
  assert.notEqual(cross.id, main.id);
  assert.ok(!hasReason(main, "Identical path also listed"));
});

test("targets.geojson missing: plans without science when there are no stops", async () => {
  const noTargets = makeLoader({ "map-layers/rover_path_2d.geojson": "synthetic-traverse.geojson" });
  const result = await plan({}, noTargets);
  assert.equal(result.candidates.length, 1, "no detours without targets");
  assert.equal(result.candidates[0].scienceValue, 0);
  assert.equal(result.candidates[0].stopMinutes, 0);
  assert.ok(hasReason(result.candidates[0], "targets.geojson was not available"));

  await assert.rejects(plan({ stopIds: ["syn-cross"] }, noTargets), { code: "DATA_NOT_READY" });
});

test("traverse mode takes precedence over candidates.json when both exist", async () => {
  const both = makeLoader({
    ...TRAVERSE_FILES,
    "candidates.json": "synthetic-candidates.json",
  });
  const result = await plan({}, both);
  assert.ok(result.candidates.every((c) => c.id.startsWith("trv-")));
});

test("planRoutes output in traverse mode passes routeResultSchema in every scenario", async () => {
  for (const overrides of [
    {}, { destination: at(1, 0) }, { destination: at(2, 0.8) }, { currentBatteryKWh: 5.2 },
    { origin: at(0.6, 0), destination: BASE }, { destination: at(1.5, -0.3) },
  ]) {
    const result = await plan(overrides);
    const check = routeResultSchema.safeParse(result);
    assert.ok(check.success, `${JSON.stringify(overrides)}: ${JSON.stringify(check.error?.issues?.[0])}`);
    assert.equal(result.requestId, "trv-req");
  }
});
