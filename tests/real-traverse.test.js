// REAL-DATA check of traverse mode (read-only). Run with: node --test tests/*.test.js
//
// Reads data/map-layers/*.geojson (NASA Mars 2020 traverse + waypoints) and
// data/region.json through the team's own loaders; never writes anything.
// Plans base -> waypoints 5_0, 7_1172 and 9_5676 and PRINTS, for each:
// length along the path, time, energy, verdict, reasons, the continuous run
// of each point, the distance from the waypoint to the nearest traverse
// vertex, and where the data gaps fall. A gap between the base and a
// waypoint is reported prominently.
// Skipped (with a message) if the data files are not present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { planRoutes } from "../server/route-engine.js";
import { loadTraverse, snapToTraverse } from "../server/traverse.js";
import { loadJsonData } from "../server/data.js";
import { routeResultSchema } from "../server/contracts.ts";
import { MISSION_CONFIG } from "../server/config.js";

const FILES = ["data/map-layers/rover_path_2d.geojson", "data/map-layers/waypoints_2d.geojson", "data/region.json"];
const missing = FILES.filter((f) => !existsSync(f));
const skip = missing.length > 0 ? `real data not present (${missing.join(", ")})` : false;

const WAYPOINTS = ["5_0", "7_1172", "9_5676"];
const km = (m) => `${(m / 1000).toFixed(3)} km`;
const fixed = (n, digits) => (n === null ? "null" : n.toFixed(digits));

test("REAL DATA: plan base -> 5_0, 7_1172, 9_5676 along the Perseverance traverse", { skip }, async () => {
  const region = JSON.parse(readFileSync("data/region.json", "utf8"));
  const waypoints = JSON.parse(readFileSync("data/map-layers/waypoints_2d.geojson", "utf8")).features;
  const traverse = await loadTraverse(loadJsonData); // same cached object planRoutes uses
  const base = { lat: region.base.lat, lon: region.base.lon };
  const baseSnap = snapToTraverse(traverse, base);
  const baseRuns = new Set(baseSnap.passes.map((p) => p.runIndex));

  const log = (line = "") => console.log(`  [real data] ${line}`);
  log(`Traverse: ${traverse.vertices.length} vertices, ${traverse.gaps.length} gaps, ` +
    `${km(traverse.vertices.at(-1).cumulativeM)} along the path (gaps excluded).`);
  traverse.gaps.forEach((g, i) =>
    log(`  gap ${i + 1}: at ${km(g.atCumulativeM)} along the path, ${g.gapM.toFixed(0)} m wide, before sol ${g.sol} ` +
      `(run ${i} | run ${i + 1})`));
  log(`Base "${region.base.label}": passes ${baseSnap.passes.map((p) =>
    `run ${p.runIndex} @ ${km(p.cumulativeM)} (sol ${p.sol}, ${p.distanceM.toFixed(1)} m)`).join("; ")}`);

  for (const name of WAYPOINTS) {
    const [site, drive] = name.split("_").map(Number);
    const feature = waypoints.find((f) => f.properties.site === site && f.properties.drive === drive);
    assert.ok(feature, `waypoint ${name} exists`);
    const point = { lat: feature.properties.lat, lon: feature.properties.lon };
    const snap = snapToTraverse(traverse, point);
    const nearest = snap.passes[0];

    log();
    log(`=== base -> ${name} (sol ${feature.properties.sol}) ===`);
    log(`nearest traverse vertex: ${snap.nearestM.toFixed(2)} m away; passes within 25 m: ` +
      snap.passes.map((p) => `run ${p.runIndex} @ ${km(p.cumulativeM)} (sol ${p.sol}, ${p.distanceM.toFixed(1)} m)`).join("; "));

    // Prominent gap report: is the waypoint's NEAREST vertex in a different run from the base?
    if (nearest && !baseRuns.has(nearest.runIndex)) {
      const from = Math.min(...baseSnap.passes.map((p) => p.cumulativeM));
      const between = traverse.gaps.filter((g) => g.atCumulativeM >= from && g.atCumulativeM <= nearest.cumulativeM);
      log(`!!! GAP WARNING: ${name}'s nearest vertex is in run ${nearest.runIndex}, the base is in run(s) ` +
        `${[...baseRuns].join(", ")}. ${between.length} gap(s) lie between them: ` +
        between.map((g) => `${km(g.atCumulativeM)} (${g.gapM.toFixed(0)} m wide)`).join(", ") +
        ". A route can only use a pass that shares a run with the base.");
    }

    const result = await planRoutes({
      requestId: `real-${name}`, regionId: region.id, dataVersion: region.dataVersion,
      origin: base, base, destination: point, stopIds: [],
      remainingMinutes: MISSION_CONFIG.missionDurationMinutes,
      currentBatteryKWh: MISSION_CONFIG.batteryCapacityKWh, config: MISSION_CONFIG,
    }); // default loader = the real data/ files, read-only

    const check = routeResultSchema.safeParse(result);
    assert.ok(check.success, `${name}: ${JSON.stringify(check.error?.issues?.[0])}`);
    if (result.errors.length) log(`errors: ${result.errors.join(" | ")}`);
    if (result.candidates.length === 0) log("NO ROUTE offered.");

    for (const c of result.candidates) {
      log(`candidate ${c.id}: ${c.feasibility.toUpperCase()}`);
      log(`  length along the path ${fixed(c.distanceKm, 3)} km out, return ${fixed(c.returnMinutes, 1)} min; ` +
        `drive ${fixed(c.driveMinutes, 1)} min + stops ${fixed(c.stopMinutes, 1)} min; ` +
        `energy out ${fixed(c.outboundEnergyKWh, 3)} / back ${fixed(c.returnEnergyKWh, 3)} / total ${fixed(c.totalEnergyKWh, 3)} kWh; ` +
        `S ${fixed(c.safetyScore, 1)}, U ${fixed(c.timeScore, 1)}, C ${fixed(c.overallScore, 1)}, coverage ${fixed(c.coveragePercent, 1)}%`);
      c.reasons.forEach((r) => log(`  - ${r}`));
    }

    if (name === "5_0") {
      // 5_0 is ~1.09 km along the traverse from the base's sol 14 start. The
      // rover also passed within 9 m of the base on sol 33 (176 m into the
      // drive), so a second, shorter route from that pass is offered too.
      const fromStart = result.candidates.find((c) => c.reasons.some((r) => r.startsWith("Origin matched the traverse pass from sol 14")));
      assert.ok(fromStart, "the route from the sol 14 start is offered");
      assert.ok(Math.abs(fromStart.distanceKm - 1.091) < 0.01, `sol 14 route length ${fromStart.distanceKm} km`);
      const recommended = result.candidates[0];
      assert.ok(recommended.reasons[0].startsWith("Recommended"));
      assert.ok(recommended.distanceKm <= fromStart.distanceKm, "recommended is not longer than the sol 14 route");
      for (const c of result.candidates) {
        assert.ok(c.reasons.includes("Route follows the real Perseverance traverse (source mission data), not a computed crewed route."));
      }
    }
  }
});
