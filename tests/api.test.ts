import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { MISSION_CONFIG } from "../server/config.ts";
import { loadJsonData } from "../server/data.ts";
import { ApiError } from "../server/errors.ts";
import type { Region, RoutePlanner } from "../server/contracts.ts";

// Synthetic fixtures for API validation only, not Mars observations or a real route.
const region: Region = {
  id: "synthetic-test", name: "Synthetic test region", status: "demo",
  bounds: { south: 0, west: 0, north: 2, east: 2 },
  base: { lat: 1, lon: 1, label: "Synthetic base", isFictional: true },
  sourceIds: ["synthetic-test-only"], dataVersion: "test-v1"
};
const validRequest = {
  requestId: "test-request", regionId: region.id, dataVersion: region.dataVersion,
  origin: { lat: 1, lon: 1 }, destination: { lat: 1.1, lon: 1.1 },
  base: { lat: 1, lon: 1 }, stopIds: [], remainingMinutes: 120, currentBatteryKWh: 10
};
const resultFor: RoutePlanner = (request) => ({
  requestId: request.requestId, dataVersion: request.dataVersion, candidates: [], errors: []
});
const app = (planner: RoutePlanner = resultFor) => createApp({
  planner, regionLoader: async () => region
});
const request = (body: unknown = validRequest) => new Request("http://localhost/api/routes", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
});
async function errorCode(response: Response) {
  return (await response.json()).error.code;
}

test("health works without region data or a completed engine", async () => {
  const response = await createApp()(new Request("http://localhost/api/health"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("valid request reaches JS-compatible planner with server-owned config", async () => {
  let called = false;
  const handler = app((input) => {
    called = true;
    assert.deepEqual(input.config, MISSION_CONFIG);
    assert.deepEqual(input.origin, validRequest.origin);
    return resultFor(input);
  });
  const response = await handler(request({ ...validRequest, config: { maxSlopeDegrees: 90 } }));
  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.equal((await response.json()).requestId, validRequest.requestId);
});

test("invalid coordinates, budgets and duplicate stops never reach the planner", async () => {
  const handler = app(() => { assert.fail("Planner must not run on invalid input"); });
  for (const invalid of [
    { origin: { lat: 91, lon: 1 } },
    { destination: { lat: 1, lon: 180 } },
    { remainingMinutes: -1 }, { remainingMinutes: 121 },
    { currentBatteryKWh: 11 }, { stopIds: ["duplicate", "duplicate"] }
  ]) {
    const response = await handler(request({ ...validRequest, ...invalid }));
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), "INVALID_REQUEST");
  }
});

test("malformed JSON, content type and oversized streams have explicit errors", async () => {
  const handler = app();
  const malformed = await handler(new Request("http://localhost/api/routes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken"
  }));
  assert.equal(malformed.status, 400);
  assert.equal(await errorCode(malformed), "INVALID_JSON");
  assert.equal((await handler(new Request("http://localhost/api/routes", {
    method: "POST", body: "{}"
  }))).status, 415);
  const large = await handler(new Request("http://localhost/api/routes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(65537)
  }));
  assert.equal(large.status, 413);
  assert.equal(await errorCode(large), "BODY_TOO_LARGE");
});

test("stale data, preview regions, wrong base and coverage failures are rejected", async () => {
  for (const [patch, status, code] of [
    [{ dataVersion: "old" }, 409, "DATA_VERSION_MISMATCH"],
    [{ regionId: "other" }, 409, "DATA_VERSION_MISMATCH"],
    [{ destination: { lat: 3, lon: 1 } }, 422, "OUTSIDE_COVERAGE"],
    [{ base: { lat: 1.01, lon: 1 } }, 422, "BASE_MISMATCH"]
  ] as const) {
    const response = await app()(request({ ...validRequest, ...patch }));
    assert.equal(response.status, status);
    assert.equal(await errorCode(response), code);
  }
  const preview = createApp({ planner: resultFor, regionLoader: async () => ({ ...region, status: "preview" }) });
  assert.equal(await errorCode(await preview(request())), "REGION_PREVIEW_ONLY");
});

test("absent data and unimplemented engine return 503 without fake candidates", async () => {
  const missingData = createApp({ regionLoader: async () => {
    throw new ApiError(503, "DATA_NOT_READY", "No region dataset yet.");
  } });
  const dataResponse = await missingData(request());
  assert.equal(dataResponse.status, 503);
  assert.equal(await errorCode(dataResponse), "DATA_NOT_READY");
  const missingEngine = createApp({ regionLoader: async () => region });
  const engineResponse = await missingEngine(request());
  assert.equal(engineResponse.status, 503);
  assert.equal(await errorCode(engineResponse), "DATA_NOT_READY");
});

test("invalid or stale engine output is rejected", async () => {
  for (const output of [
    { requestId: "stale", dataVersion: region.dataVersion, candidates: [], errors: [] },
    { requestId: validRequest.requestId, dataVersion: "stale", candidates: [], errors: [] },
    { requestId: validRequest.requestId, dataVersion: region.dataVersion, candidates: [{ distanceKm: NaN }], errors: [] }
  ]) {
    const response = await app(() => output)(request());
    assert.equal(response.status, 502);
    assert.equal(await errorCode(response), "INVALID_ENGINE_RESULT");
  }
});

test("an unverified candidate preserves explicit unknown numeric values", async () => {
  const response = await app((input) => ({
    requestId: input.requestId, dataVersion: input.dataVersion, errors: [],
    candidates: [{
      id: "synthetic-unknown", geometry: [[1, 1], [1.1, 1.1]], returnGeometry: [],
      distanceKm: null, driveMinutes: null, stopMinutes: 0, returnMinutes: null,
      outboundEnergyKWh: null, returnEnergyKWh: null, totalEnergyKWh: null,
      safetyScore: null, timeScore: null, overallScore: null, scienceValue: 0,
      feasibility: "unverified", reasons: ["Synthetic unknown terrain"],
      coveragePercent: null, sourceIds: ["synthetic-test-only"]
    }]
  }))(request());
  assert.equal(response.status, 200);
  const candidate = (await response.json()).candidates[0];
  assert.equal(candidate.safetyScore, null);
  assert.equal(candidate.feasibility, "unverified");
});

test("wrong methods and missing endpoints are explicit", async () => {
  const handler = app();
  const wrongMethod = await handler(new Request("http://localhost/api/routes"));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal((await handler(new Request("http://localhost/api/missing"))).status, 404);
});

test("data loader rejects paths outside data directory", async () => {
  await assert.rejects(loadJsonData("../package.json"), (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_DATA_FILE");
});
