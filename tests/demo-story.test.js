// DEMO STORY checks on the REAL data (read-only), plus unit checks for the
// 14 Nov engine fixes:
//   (a) targets anchored by waypoint id, (b) superseded partial-download
//   pieces dropped, (c) best-case lower bound for unknown ground,
//   (d) alternative passes near the base are UNVERIFIED (unmapped hop),
//   (e) a destination within 1 m of a listed target is that target.
// The expected numbers were measured on the real traverse on 14 Nov 2026
// (120 min, 10 kWh, server config). Skipped if the real data is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { planRoutes } from "../server/route-engine.js";
import { loadTraverse, dropSupersededPieces } from "../server/traverse.js";
import { loadJsonData } from "../server/data.js";
import { evaluateRoute } from "../server/route-math.js";
import { routeResultSchema } from "../server/contracts.ts";
import { MISSION_CONFIG } from "../server/config.js";

const FILES = ["data/map-layers/rover_path_2d.geojson", "data/targets.geojson", "data/region.json"];
const skip = FILES.some((f) => !existsSync(f)) ? "real data not present" : false;

const region = existsSync("data/region.json") ? JSON.parse(readFileSync("data/region.json", "utf8")) : null;
const targets = existsSync("data/targets.geojson")
  ? Object.fromEntries(JSON.parse(readFileSync("data/targets.geojson", "utf8")).features.map((f) =>
      [f.properties.id, { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }]))
  : {};

async function plan(origin, destination, extra = {}) {
  const base = { lat: region.base.lat, lon: region.base.lon };
  const result = await planRoutes({
    requestId: "demo",
    regionId: region.id,
    dataVersion: region.dataVersion,
    origin: origin ?? base,
    destination,
    base,
    stopIds: [],
    remainingMinutes: 120,
    currentBatteryKWh: 10,
    config: MISSION_CONFIG,
    ...extra,
  });
  assert.ok(routeResultSchema.safeParse(result).success, "result matches the team contract");
  return result;
}
const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ~${expected}, got ${actual}`);
const has = (candidate, text) => candidate.reasons.some((r) => r.includes(text));

test("REAL (b): superseded pieces dropped -> one continuous traverse, no gaps", { skip }, async () => {
  const traverse = await loadTraverse(loadJsonData);
  assert.equal(traverse.gaps.length, 0);
  assert.equal(traverse.droppedPieces.length, 6);
  close(traverse.vertices.at(-1).cumulativeM / 1000, 45.04, 0.01, "traverse km");
});

test("REAL (a): targets anchor to their own drive by id", { skip }, async () => {
  const traverse = await loadTraverse(loadJsonData);
  assert.equal(traverse.anchors.get("3_0"), 0); // the base is the very first point
  assert.equal(traverse.vertices[traverse.anchors.get("9_5676")].sol, 352); // not the sol 137 pass
  close(traverse.vertices[traverse.anchors.get("9_5676")].cumulativeM, 3833, 1, "9_5676 metres along");
});

test("REAL demo: base -> 5_0 passes (~27.8 min driving, ~1.27 kWh)", { skip }, async () => {
  const { candidates } = await plan(null, targets["5_0"]);
  const best = candidates[0];
  assert.equal(best.feasibility, "pass");
  assert.ok(has(best, "Recommended:"));
  assert.ok(has(best, "anchored by waypoint id"));
  close(best.driveMinutes + best.returnMinutes, 27.8, 0.1, "drive + return min");
  close(best.totalEnergyKWh, 1.27, 0.01, "total kWh");
});

test("REAL demo: base -> 7_1172 passes (~65.8 min driving, ~2.99 kWh)", { skip }, async () => {
  const { candidates } = await plan(null, targets["7_1172"]);
  const best = candidates[0];
  assert.equal(best.feasibility, "pass");
  close(best.driveMinutes + best.returnMinutes, 65.8, 0.1, "drive + return min");
  close(best.totalEnergyKWh, 2.99, 0.01, "total kWh");
});

test("REAL demo: base -> 9_5676 is BLOCKED with the engine's own time reason", { skip }, async () => {
  const { candidates, errors } = await plan(null, targets["9_5676"]);
  const direct = candidates.find((c) => c.id === "trv-0-2464");
  assert.equal(direct.feasibility, "blocked");
  assert.ok(has(direct, "Not enough time"));
  // Short by 16.9 min, i.e. ~1.9 min short even without its 15 min stop.
  close(direct.driveMinutes + direct.returnMinutes + 15 - 120, 1.9, 0.1, "short without the stop");
  assert.ok(candidates.every((c) => c.feasibility !== "pass"));
  assert.ok(errors.some((e) => e.includes("No candidate route passed")));
});

test("REAL demo: from 5_0, the South Seitah detour passes and 9_5676 is rejected", { skip }, async () => {
  const { candidates } = await plan(null, targets["5_0"]);
  const seitah = candidates.find((c) => has(c, 'to "7_1172"'));
  const far = candidates.find((c) => has(c, 'to "9_5676"'));
  assert.equal(seitah.feasibility, "pass");
  assert.equal(far.feasibility, "blocked");
  assert.ok(has(far, "Not enough time"));
});

test("REAL (d): routes starting from another pass near the base are UNVERIFIED", { skip }, async () => {
  const { candidates } = await plan(null, targets["5_0"]);
  const viaSol33 = candidates.find((c) => c.id === "trv-180-678");
  assert.equal(viaSol33.feasibility, "unverified");
  assert.ok(has(viaSol33, "crosses unmapped ground"));
  assert.equal(viaSol33.overallScore, null); // unknown terrain never improves a score
  // Every return ends at the anchored base (the first traverse point).
  const traverse = await loadTraverse(loadJsonData);
  const start = traverse.vertices[0];
  for (const c of candidates) assert.deepEqual(c.returnGeometry.at(-1), [start.lon, start.lat]);
});

test("REAL (e): a destination more than 1 m from a target is not that target", { skip }, async () => {
  const t = targets["5_0"];
  const nudged = { lat: t.lat + 0.0001, lon: t.lon }; // ~6 m north
  const { candidates } = await plan(null, nudged);
  assert.ok(candidates.every((c) => !has(c, 'listed target "5_0"')));
});

test("REAL mid-mission: return to base from the 5_0 drive end follows the traverse", { skip }, async () => {
  const base = { lat: region.base.lat, lon: region.base.lon };
  const { candidates } = await plan(targets["5_0"], base);
  assert.equal(candidates[0].feasibility, "pass");
  close(candidates[0].returnMinutes, 13.9, 0.1, "return min");
});

// --- Unit checks (no real data needed) ---

test("(c) lower bound: unknown slope that can't fit even if flat -> BLOCKED", () => {
  // 10 km of unknown slope: even flat, 120 min out + 120 back > 120 min.
  const unknown = [{ distanceKm: 10, slopeDeg: null }];
  const r = evaluateRoute({ outboundSegments: unknown, returnSegments: unknown, stopMinutes: 0,
    remainingMinutes: 120, currentBatteryKWh: 10 });
  assert.equal(r.feasibility, "blocked");
  assert.ok(r.reasons.some((x) => x.includes("even in the best case")));
  assert.equal(r.overallScore, null);
});

test("(c) lower bound: unknown slope that could fit if flat -> stays UNVERIFIED", () => {
  const unknown = [{ distanceKm: 1, slopeDeg: null }];
  const r = evaluateRoute({ outboundSegments: unknown, returnSegments: unknown, stopMinutes: 0,
    remainingMinutes: 120, currentBatteryKWh: 10 });
  assert.equal(r.feasibility, "unverified");
  assert.equal(r.driveMinutes, null); // never a guessed number
});

test("(c) lower bound: battery short even if flat -> BLOCKED", () => {
  // Flat best case: 4 km each way = 4 kWh + aux 0.2 kW x 96 min = 0.32 kWh;
  // plus the 2 kWh reserve = 6.32 kWh > 5 kWh available.
  const unknown = [{ distanceKm: 4, slopeDeg: null }];
  const r = evaluateRoute({ outboundSegments: unknown, returnSegments: unknown, stopMinutes: 0,
    remainingMinutes: 120, currentBatteryKWh: 5 });
  assert.equal(r.feasibility, "blocked");
  assert.ok(r.reasons.some((x) => x.includes("Not enough battery even in the best case")));
});

test("(b) dropSupersededPieces keeps the longest copy; never drops a different path", () => {
  const piece = (fromRMC, coords, elevations) => ({
    type: "Feature",
    properties: { fromRMC, toRMC: "x", elevations: elevations ?? coords.map(() => -2500) },
    geometry: { type: "LineString", coordinates: coords },
  });
  const partial = piece("1_0", [[0, 0], [0.001, 0]]);
  const full = piece("1_0", [[0, 0], [0.001, 0], [0.002, 0]]);
  const different = piece("1_0", [[0, 0], [0, 0.001]]); // same start, other direction
  const sameButNoData = piece("2_0", [[1, 1], [1.001, 1]], [2.2e-5, 2.2e-5]);
  const sameWithData = piece("2_0", [[1, 1], [1.001, 1]]);

  const a = dropSupersededPieces([partial, full]);
  assert.deepEqual(a.kept, [full]);
  const b = dropSupersededPieces([partial, different, full]);
  assert.ok(b.kept.includes(different), "a piece that is not a prefix is kept");
  const c = dropSupersededPieces([sameWithData, sameButNoData]);
  assert.deepEqual(c.kept, [sameWithData], "identical copies: keep the one with known elevations");
});
