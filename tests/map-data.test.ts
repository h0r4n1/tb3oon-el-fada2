import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { loadJsonData } from "../server/data.ts";
import { ApiError } from "../server/errors.ts";
import { loadMapData, MAP_DATA_FILES, type MapDataLayer } from "../server/map-data.ts";

// Synthetic structural fixtures, not Mars observations or mission routes.
const waypoints = {
  type: "FeatureCollection", name: "Synthetic waypoints", bbox: [0, 0, 2, 2],
  features: [{
    type: "Feature", id: "synthetic-point", properties: { sol: 1, Note: "Test only", nested: { keep: true } },
    geometry: { type: "Point", coordinates: [1, 2, 3] }
  }]
};
const roverPath = {
  type: "FeatureCollection", name: "Synthetic traverse",
  crs: { type: "name", properties: { name: "synthetic-reference-frame" } },
  features: [{
    type: "Feature", properties: { sol: 1, length: 2 },
    geometry: { type: "LineString", coordinates: [[0, 0, 4], [1, 1, 5]] }
  }]
};
const fixtureFor = (layer: MapDataLayer) => layer === "waypoints" ? waypoints : roverPath;

test("both map endpoints return unwrapped GeoJSON while region and engine are unavailable", async () => {
  const app = createApp({
    regionLoader: async () => { assert.fail("Map layers must not require region data"); },
    planner: () => { assert.fail("Map layers must not invoke the route engine"); },
    mapDataLoader: async (layer) => loadMapData(layer, async () => fixtureFor(layer))
  });
  for (const layer of ["waypoints", "rover-path"] as const) {
    const response = await app(new Request(`http://localhost/api/map-data/${layer}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/geo+json");
    assert.deepEqual(await response.json(), fixtureFor(layer));
  }
});

test("layer names map only to the exact uploaded filenames", async () => {
  for (const layer of ["waypoints", "rover-path"] as const) {
    let requestedFile: string | undefined;
    await loadMapData(layer, async (filename) => {
      requestedFile = filename;
      return fixtureFor(layer);
    });
    assert.equal(requestedFile, MAP_DATA_FILES[layer]);
  }
  assert.equal(MAP_DATA_FILES.waypoints, "waypoints_slims.geojson");
  assert.equal(MAP_DATA_FILES["rover-path"], "rover_path.geojson");
});

test("map loaders reject malformed collections and wrong geometry types", async () => {
  for (const invalid of [
    { type: "FeatureCollection", features: "invalid" },
    { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1] } }] },
    { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, Infinity] } }] },
    roverPath
  ]) {
    await assert.rejects(loadMapData("waypoints", async () => invalid), (error: unknown) =>
      error instanceof ApiError && error.status === 503 && error.code === "INVALID_DATA");
  }
  await assert.rejects(loadMapData("rover-path", async () => waypoints), (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_DATA");
});

test("missing and malformed map datasets return explicit 503 errors", async () => {
  for (const code of ["DATA_NOT_READY", "INVALID_DATA"]) {
    const app = createApp({ mapDataLoader: async () => {
      throw new ApiError(503, code, "Synthetic data failure");
    } });
    const response = await app(new Request("http://localhost/api/map-data/waypoints"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, code);
  }
});

test("map endpoints allow GET only and do not expose arbitrary files", async () => {
  const app = createApp();
  for (const layer of ["waypoints", "rover-path"]) {
    const response = await app(new Request(`http://localhost/api/map-data/${layer}`, { method: "POST" }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal((await app(new Request("http://localhost/api/map-data/sources"))).status, 404);
  assert.equal((await app(new Request("http://localhost/api/map-data/%2e%2e%2fregion.json"))).status, 404);
});

test("underscores are accepted in safe data filenames while path traversal is rejected", async () => {
  await assert.rejects(loadJsonData("synthetic_missing_83b128.geojson"), (error: unknown) =>
    error instanceof ApiError && error.code === "DATA_NOT_READY");
  await assert.rejects(loadJsonData("../rover_path.geojson"), (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_DATA_FILE");
});
