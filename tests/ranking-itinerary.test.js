// Tests for milestone 4 ranking changes in server/ranking.js:
//   - duplicate removal includes the visited target ids,
//   - capCandidates keeps at most 6 and never hides a role holder.
// Run with: node --test tests/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDuplicatePaths, rankCandidates, capCandidates, MAX_CANDIDATES } from "../server/ranking.js";

const PATH = [[0, 0], [1, 1]];
const BACK = [[1, 1], [0, 0]];

// cand: a minimal candidate. Same path for all unless overridden.
function cand(id, fields = {}) {
  return {
    id, geometry: PATH, returnGeometry: BACK,
    driveMinutes: 30, stopMinutes: 5, safetyScore: 50, timeScore: 50, overallScore: 50,
    scienceValue: 1, feasibility: "pass", reasons: [], ...fields,
  };
}
const ids = (list) => list.map((c) => c.id);

test("same path + different stops are different itineraries; same stops are duplicates", () => {
  const visits = new Map([
    ["plain", ["dest"]],
    ["with-stop", ["rock", "dest"]],
    ["plain-copy", ["dest"]],
  ]);
  const unique = removeDuplicatePaths([cand("plain"), cand("with-stop"), cand("plain-copy")], visits);
  assert.deepEqual(ids(unique), ["plain", "with-stop"]);
  assert.ok(unique[0].reasons.some((r) => r.includes('"plain-copy"')));
});

test("no visit information -> behaves like before (path only)", () => {
  assert.deepEqual(ids(removeDuplicatePaths([cand("a"), cand("b")])), ["a"]);
});

test("capCandidates: at most 6 kept, eligible first, message says how many were hidden", () => {
  const ranked = rankCandidates(
    Array.from({ length: 9 }, (_, i) =>
      cand(`c${i}`, {
        geometry: [[0, 0], [i, 1]], // different paths
        overallScore: 90 - i,
        feasibility: i < 4 ? "pass" : "blocked",
      })
    )
  ).candidates;
  const { candidates, message } = capCandidates(ranked);
  assert.equal(MAX_CANDIDATES, 6);
  assert.equal(candidates.length, 6);
  assert.deepEqual(ids(candidates), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  assert.equal(message, "3 more candidate routes were hidden (at most 6 are shown).");
});

test("capCandidates: a role holder ranked low is never hidden", () => {
  // Seven eligible routes; the science-focused one is ranked last by score.
  const list = Array.from({ length: 7 }, (_, i) =>
    cand(`c${i}`, { geometry: [[0, 0], [i, 1]], overallScore: 90 - i, scienceValue: i === 6 ? 9 : 1 })
  );
  const ranked = rankCandidates(list).candidates;
  const { candidates, message } = capCandidates(ranked);
  assert.equal(candidates.length, 6);
  const science = candidates.find((c) => c.reasons.some((r) => r.startsWith("Science-focused")));
  assert.equal(science?.id, "c6", "science-focused route kept");
  assert.equal(message, "1 more candidate route was hidden (at most 6 are shown).");
});

test("capCandidates: 6 or fewer -> unchanged, no message", () => {
  const list = [cand("a"), cand("b", { geometry: [[0, 0], [2, 2]] })];
  assert.deepEqual(capCandidates(list), { candidates: list, message: null });
});
