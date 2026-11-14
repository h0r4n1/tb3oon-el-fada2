// Tests for planRoutes in server/route-engine.js. Run with: node --test tests/*.test.js
//
// Uses SYNTHETIC demonstration fixtures in tests/fixtures/ (not Mars data).
// Synthetic map: base at lat 0, lon 0; destination "syn-delta" 2 km east.
//   syn-route-a          1 km @3° + 1 km @9°      (Route A)
//   syn-route-b          1.6 km @2° + 0.8 km @2°  (Route B)
//   syn-route-c-steep    has a 20° segment         -> blocked
//   syn-route-a-copy     same path as A            -> removed as duplicate
//   syn-route-e-unknown  one slope unknown         -> unverified
//   syn-route-f-broken   wrong number of segments  -> skipped with an error
//   syn-route-g-elsewhere goes to "syn-ridge"      -> not part of this trip
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planRoutes } from "../server/route-engine.js";
import { routeResultSchema } from "../server/contracts.ts";
import { MISSION_CONFIG } from "../server/config.ts";
import { ApiError } from "../server/errors.ts";
import { createApp } from "../server/app.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const FIXTURE_FILES = {
  "candidates.json": "synthetic-candidates.json",
  "targets.geojson": "synthetic-targets.geojson",
};

// Stands in for loadJsonData, reading the synthetic fixtures instead of data/.
// Files it doesn't provide (e.g. the traverse) give DATA_NOT_READY, exactly
// like the real loader, so planRoutes falls back to curated mode.
async function fixtureLoader(filename) {
  if (!(filename in FIXTURE_FILES)) throw new ApiError(503, "DATA_NOT_READY", `${filename} not supplied (test).`);
  return JSON.parse(await readFile(new URL(FIXTURE_FILES[filename], FIXTURES), "utf8"));
}

// Loader for small inline examples: returns the given objects by filename
// (DATA_NOT_READY for files it doesn't provide, like the real loader).
const inlineLoader = (files) => async (filename) => {
  if (!(filename in files)) throw new ApiError(503, "DATA_NOT_READY", `${filename} not supplied (test).`);
  return structuredClone(files[filename]);
};

const KM_IN_DEGREES = 180 / (Math.PI * 3389.5); // 1 km on Mars, in degrees
const BASE = { lat: 0, lon: 0 };
const DELTA = { lat: 0, lon: 2 * KM_IN_DEGREES };
const RIDGE = { lat: 1 * KM_IN_DEGREES, lon: 0 };

function makeRequest(overrides = {}) {
  return {
    requestId: "req-1",
    regionId: "synthetic-test",
    dataVersion: "synthetic-v1",
    origin: BASE,
    stopIds: [],
    destination: DELTA,
    base: BASE,
    remainingMinutes: 120,
    currentBatteryKWh: 10,
    config: MISSION_CONFIG,
    ...overrides,
  };
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`
  );
}
const ROUNDED = 0.0005;
const ids = (list) => list.map((c) => c.id);
const byId = (list, id) => list.find((c) => c.id === id);

test("synthetic Jezero-like scenario: ranked, deduplicated, explained", async () => {
  const result = await planRoutes(makeRequest(), { loadData: fixtureLoader });

  // Echoed for stale-response checks.
  assert.equal(result.requestId, "req-1");
  assert.equal(result.dataVersion, "synthetic-v1");

  // B first (recommended), then A, then blocked C, then unverified E.
  // a-copy removed (duplicate), f skipped (broken), g not on this trip.
  assert.deepEqual(ids(result.candidates), [
    "syn-route-b",
    "syn-route-a",
    "syn-route-c-steep",
    "syn-route-e-unknown",
  ]);
  const [b, a, c, e] = result.candidates;

  // Hand-checked numbers from milestone 2.
  assertClose(b.overallScore, 78.815, ROUNDED, "B overall");
  assertClose(b.totalEnergyKWh, 3.2999, ROUNDED, "B energy");
  assertClose(a.overallScore, 58.229, ROUNDED, "A overall");
  assertClose(a.safetyScore, 60, ROUNDED, "A safety");
  assertClose(a.returnMinutes, 43.2, ROUNDED, "A return minutes");
  assertClose(a.totalEnergyKWh, 3.9047, ROUNDED, "A energy");
  assert.equal(a.stopMinutes, 5); // one stop at syn-delta
  assert.equal(a.scienceValue, 3);

  // Roles. Both visit only syn-delta (science 3 = 3), so the tie goes to B's higher C.
  assert.ok(b.reasons.includes("Recommended: highest overall score."));
  assert.ok(b.reasons.some((r) => r.startsWith("Fastest")));
  assert.ok(b.reasons.some((r) => r.startsWith("Science-focused")));
  assert.ok(a.reasons.some((r) => r.includes('"syn-route-a-copy"')));

  assert.equal(c.feasibility, "blocked");
  assert.ok(c.reasons.some((r) => r.includes("exceeds")));
  assert.equal(e.feasibility, "unverified");
  assert.equal(e.overallScore, null);

  // Every candidate is marked synthetic.
  for (const candidate of result.candidates) {
    assert.ok(candidate.reasons.some((r) => r.startsWith("SYNTHETIC")));
    assert.deepEqual(candidate.sourceIds, ["synthetic-test-only"]);
  }
  // The broken candidate is reported, not silently dropped.
  assert.ok(result.errors.some((m) => m.includes("syn-route-f-broken")));
});

test("planRoutes output passes the team's routeResultSchema", async () => {
  const result = await planRoutes(makeRequest(), { loadData: fixtureLoader });
  const check = routeResultSchema.safeParse(result);
  assert.ok(check.success, JSON.stringify(check.error?.issues));
});

test("end to end through the team's API handler returns 200", async () => {
  const region = {
    id: "synthetic-test", name: "Synthetic test region", status: "demo",
    bounds: { south: -1, west: -1, north: 1, east: 1 },
    base: { ...BASE, label: "Synthetic base", isFictional: true },
    sourceIds: ["synthetic-test-only"], dataVersion: "synthetic-v1",
  };
  const app = createApp({
    planner: (request) => planRoutes(request, { loadData: fixtureLoader }),
    regionLoader: async () => region,
  });
  const { config, ...body } = makeRequest(); // the browser doesn't send config
  void config;
  const response = await app(new Request("http://localhost/api/routes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).candidates[0].id, "syn-route-b");
});

test("single matching candidate says it is the only feasible route", async () => {
  const result = await planRoutes(makeRequest({ destination: RIDGE }), { loadData: fixtureLoader });
  assert.deepEqual(ids(result.candidates), ["syn-route-g-elsewhere"]);
  assert.ok(result.candidates[0].reasons.includes("Only one feasible route was found."));
});

test("a destination with no curated route returns no candidates and a message", async () => {
  const result = await planRoutes(
    makeRequest({ destination: { lat: 0.5, lon: 0.5 } }),
    { loadData: fixtureLoader }
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((m) => m.startsWith("No curated route matches")));
});

test("stops must be visited in the requested order", async () => {
  // Every route to syn-delta visits only syn-delta, so asking to stop at
  // syn-ridge on the way can't be satisfied.
  const result = await planRoutes(makeRequest({ stopIds: ["syn-ridge"] }), { loadData: fixtureLoader });
  assert.deepEqual(result.candidates, []);
});

test("stale candidates.json data version -> no routes, clear message", async () => {
  const result = await planRoutes(makeRequest({ dataVersion: "other-v2" }), { loadData: fixtureLoader });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.dataVersion, "other-v2"); // still echoes the request
  assert.ok(result.errors[0].includes("synthetic-v1"));
});

test("DATA_NOT_READY from the loader passes through untouched", async () => {
  const missing = async (filename) => {
    throw new ApiError(503, "DATA_NOT_READY", `The data team has not supplied ${filename} yet.`);
  };
  await assert.rejects(planRoutes(makeRequest(), { loadData: missing }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "DATA_NOT_READY");
    assert.equal(error.status, 503);
    return true;
  });
});

test("a badly shaped candidates.json is INVALID_DATA (503)", async () => {
  const loader = inlineLoader({ "candidates.json": { routes: [] }, "targets.geojson": { features: [] } });
  await assert.rejects(planRoutes(makeRequest(), { loadData: loader }), { code: "INVALID_DATA" });
});

// --- Small inline examples (also SYNTHETIC) for data edge cases. ---
const k = KM_IN_DEGREES;
function inlineFiles({ candidate, targetProps = { id: "t", scienceValue: 2, stopMinutes: 5 } }) {
  return inlineLoader({
    "candidates.json": { dataVersion: "synthetic-v1", isSynthetic: true, sourceIds: ["synthetic-test-only"], candidates: [candidate] },
    "targets.geojson": { type: "FeatureCollection", features: [{ type: "Feature", properties: targetProps }] },
  });
}
const straight = (slope, method = "elevation-gradient") => ({
  id: "only",
  visitTargetIds: ["t"],
  outbound: { geometry: [[0, 0], [k, 0]], segments: [{ slopeDeg: slope, method }] },
  return: { geometry: [[k, 0], [0, 0]], segments: [{ slopeDeg: slope, method }] },
});
const toOneKm = makeRequest({ destination: { lat: 0, lon: k } });

test("unrated target: counted as not rated, named in reasons, not science-focused", async () => {
  const result = await planRoutes(toOneKm, {
    loadData: inlineFiles({ candidate: straight(3), targetProps: { id: "t", scienceValue: null, stopMinutes: 5 } }),
  });
  const [only] = result.candidates;
  assert.equal(only.scienceValue, 0);
  assert.ok(only.reasons.some((r) => r.includes("unrated: t")));
  assert.ok(!only.reasons.some((r) => r.startsWith("Science-focused")));
  assert.ok(routeResultSchema.safeParse(result).success);
});

test("target missing stop time uses the configured default (5 min) and says so", async () => {
  const result = await planRoutes(toOneKm, {
    loadData: inlineFiles({ candidate: straight(3), targetProps: { id: "t", scienceValue: 2 } }),
  });
  assert.equal(result.candidates[0].stopMinutes, 5);
  assert.ok(result.candidates[0].reasons.some((r) => r.includes("default 5 min")));
});

test("target id missing from targets.geojson -> unverified (stop time unknown)", async () => {
  const result = await planRoutes(toOneKm, {
    loadData: inlineFiles({ candidate: straight(3), targetProps: { id: "someone-else", scienceValue: 2 } }),
  });
  assert.equal(result.candidates[0].feasibility, "unverified");
  assert.equal(result.candidates[0].stopMinutes, null);
});

test("slope without a derivation method is treated as unknown -> unverified", async () => {
  // null, not undefined: passing undefined would make straight() use its default method.
  const result = await planRoutes(toOneKm, { loadData: inlineFiles({ candidate: straight(3, null) }) });
  const [only] = result.candidates;
  assert.equal(only.feasibility, "unverified");
  assert.ok(only.reasons.some((r) => r.includes("no recorded derivation method")));
});

test("along-track rise/run slopes carry the cross-slope limitation note", async () => {
  const result = await planRoutes(toOneKm, {
    loadData: inlineFiles({ candidate: straight(3, "along-track-rise-run") }),
  });
  assert.equal(result.candidates[0].feasibility, "pass");
  assert.ok(result.candidates[0].reasons.some((r) => r.includes("cross-slope is not captured")));
});

test("return: null in the data -> blocked, empty return line, still valid contract", async () => {
  const result = await planRoutes(toOneKm, { loadData: inlineFiles({ candidate: { ...straight(3), return: null } }) });
  const [only] = result.candidates;
  assert.equal(only.feasibility, "blocked");
  assert.deepEqual(only.returnGeometry, []);
  assert.ok(only.reasons.some((r) => r.includes("No return path")));
  assert.ok(routeResultSchema.safeParse(result).success);
});
