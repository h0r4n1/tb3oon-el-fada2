// Tests for server/ranking.js. Run with: node --test tests/*.test.js
//
// Route A and Route B are the milestone 2 routes (120 min, 10 kWh, 5 min stop):
//   A: C = 58.229, S = 60,     T = 48.2
//   B: C = 78.815, S = 86.667, T = 41.48
// So by hand: B is Recommended (higher C) and Fastest (lower T).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, removeDuplicatePaths } from "../server/ranking.js";
import { evaluateRoute } from "../server/route-math.js";

// Builds a full Candidate-like object for ranking tests. Only the fields
// ranking reads matter. Each call gets its own path (a counter), so test
// candidates are never accidentally treated as duplicates of each other.
let pathCounter = 0;
function cand(id, fields = {}) {
  pathCounter += 1;
  return {
    id,
    geometry: [[0, 0], [pathCounter, 1]],
    returnGeometry: [[pathCounter, 1], [0, 0]],
    driveMinutes: 30,
    stopMinutes: 5,
    safetyScore: 50,
    timeScore: 50,
    overallScore: 50,
    scienceValue: 1,
    feasibility: "pass",
    reasons: [],
    ...fields,
  };
}

// Turns segments into a ranked-ready candidate using the real evaluateRoute.
function evaluated(id, segments, scienceValue) {
  const evaluation = evaluateRoute({
    outboundSegments: segments,
    returnSegments: [...segments].reverse(),
    stopMinutes: 5,
    remainingMinutes: 120,
    currentBatteryKWh: 10,
  });
  return cand(id, { ...evaluation, scienceValue });
}

const ROUTE_A = [{ distanceKm: 1.0, slopeDeg: 3 }, { distanceKm: 1.0, slopeDeg: 9 }];
const ROUTE_B = [{ distanceKm: 1.6, slopeDeg: 2 }, { distanceKm: 0.8, slopeDeg: 2 }];

const ids = (list) => list.map((c) => c.id);
const byId = (list, id) => list.find((c) => c.id === id);
const hasReason = (c, text) => c.reasons.some((r) => r.startsWith(text));

test("Route A vs B: B is recommended and fastest; A is science-focused (5 vs 3)", () => {
  const a = evaluated("route-a", ROUTE_A, 5);
  const b = evaluated("route-b", ROUTE_B, 3);
  const { candidates, messages } = rankCandidates([a, b]); // A listed first on purpose

  assert.deepEqual(ids(candidates), ["route-b", "route-a"]); // recommended first
  const [first, second] = candidates;
  assert.ok(hasReason(first, "Recommended"));
  assert.ok(hasReason(first, "Fastest"));
  assert.ok(!hasReason(first, "Science-focused"));
  assert.ok(hasReason(second, "Science-focused"));
  assert.ok(!hasReason(second, "Recommended"));
  assert.deepEqual(messages, []);
});

test("recommended tie-break: equal C -> higher S wins", () => {
  const low = cand("low-s", { overallScore: 70, safetyScore: 60 });
  const high = cand("high-s", { overallScore: 70, safetyScore: 80 });
  assert.deepEqual(ids(rankCandidates([low, high]).candidates), ["high-s", "low-s"]);
});

test("recommended tie-break: equal C and S -> lower T wins", () => {
  // T = driveMinutes + stopMinutes: 40 + 5 = 45 vs 30 + 5 = 35.
  const slow = cand("slow", { overallScore: 70, safetyScore: 80, driveMinutes: 40 });
  const quick = cand("quick", { overallScore: 70, safetyScore: 80, driveMinutes: 30 });
  const { candidates } = rankCandidates([slow, quick]);
  assert.deepEqual(ids(candidates), ["quick", "slow"]);
  assert.ok(hasReason(candidates[0], "Recommended"));
});

test("fastest tie-break: equal T -> higher overall score wins", () => {
  const a = cand("a", { driveMinutes: 20, overallScore: 60 });
  const b = cand("b", { driveMinutes: 20, overallScore: 65 });
  const c = cand("c", { driveMinutes: 25, overallScore: 90 }); // recommended, but slower
  const { candidates } = rankCandidates([a, b, c]);
  assert.ok(hasReason(byId(candidates, "b"), "Fastest"));
  assert.ok(!hasReason(byId(candidates, "a"), "Fastest"));
  assert.ok(hasReason(byId(candidates, "c"), "Recommended"));
});

test("science tie-break: equal science value -> higher overall score wins", () => {
  const a = cand("a", { scienceValue: 4, overallScore: 60 });
  const b = cand("b", { scienceValue: 4, overallScore: 70 });
  const { candidates } = rankCandidates([a, b]);
  assert.ok(hasReason(byId(candidates, "b"), "Science-focused"));
  assert.ok(!hasReason(byId(candidates, "a"), "Science-focused"));
});

test("science-focused skips routes with incomplete science values", () => {
  const rich = cand("rich-but-unrated", { scienceValue: 6 });
  const plain = cand("plain", { scienceValue: 2 });
  const { candidates } = rankCandidates([rich, plain], {
    scienceExcludedIds: new Set(["rich-but-unrated"]),
  });
  assert.ok(hasReason(byId(candidates, "plain"), "Science-focused"));
  assert.ok(!hasReason(byId(candidates, "rich-but-unrated"), "Science-focused"));
});

test("single eligible candidate says so; blocked candidate is sorted after it", () => {
  const blocked = cand("blocked-high-score", { feasibility: "blocked", overallScore: 99, reasons: ["Too steep."] });
  const ok = cand("ok", { overallScore: 40 });
  const { candidates } = rankCandidates([blocked, ok]);
  assert.deepEqual(ids(candidates), ["ok", "blocked-high-score"]);
  assert.ok(candidates[0].reasons.includes("Only one feasible route was found."));
  assert.deepEqual(candidates[1].reasons, ["Too steep."]); // no roles for blocked
});

test("order is eligible, then blocked, then unverified (data order inside groups)", () => {
  const list = [
    cand("u1", { feasibility: "unverified", overallScore: null }),
    cand("b1", { feasibility: "blocked" }),
    cand("p1", { overallScore: 60 }),
    cand("b2", { feasibility: "blocked" }),
    cand("p2", { overallScore: 80 }),
  ];
  assert.deepEqual(ids(rankCandidates(list).candidates), ["p2", "p1", "b1", "b2", "u1"]);
});

test("identical paths are shown once, with a note naming the duplicate", () => {
  const geometry = [[0, 0], [1, 1]];
  const returnGeometry = [[1, 1], [0, 0]];
  const first = cand("first", { geometry, returnGeometry });
  const copy = cand("copy", { geometry, returnGeometry });
  const different = cand("different");
  const unique = removeDuplicatePaths([first, copy, different]);
  assert.deepEqual(ids(unique), ["first", "different"]);
  assert.ok(unique[0].reasons.some((r) => r.includes('"copy"')));
  assert.deepEqual(first.reasons, [], "input object was not modified");
});

test("null overallScore is handled safely and never recommended", () => {
  // e.g. a zero-distance route: eligible, but no overall score.
  const noScore = cand("no-score", { overallScore: null, safetyScore: null, driveMinutes: 0 });
  const scored = cand("scored", { overallScore: 10 });
  const { candidates } = rankCandidates([noScore, scored]);
  assert.deepEqual(ids(candidates), ["scored", "no-score"]);
  assert.ok(hasReason(candidates[0], "Recommended"));
  assert.ok(hasReason(byId(candidates, "no-score"), "Fastest")); // T = 5 is lowest

  const alone = rankCandidates([cand("only-null", { overallScore: null, safetyScore: null })]);
  assert.ok(!hasReason(alone.candidates[0], "Recommended"));
});

test("no eligible candidate -> a readable message, routes still returned", () => {
  const { candidates, messages } = rankCandidates([cand("x", { feasibility: "blocked" })]);
  assert.equal(candidates.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /No candidate route passed/);
});
