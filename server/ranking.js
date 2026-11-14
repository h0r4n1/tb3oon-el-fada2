// NEBULA - Ranking candidate routes (owned by Abood, Route Engineer).
//
// Takes already-evaluated Candidate objects and decides which one is
// "Recommended", "Fastest" and "Science-focused", following brief section 6:
//   - Only "pass" routes are eligible for any role.
//   - Recommended:     highest overallScore; ties -> higher safetyScore,
//                      then lower outbound time T.
//   - Fastest:         lowest T; ties -> higher overallScore.
//   - Science-focused: highest scienceValue; ties -> higher overallScore.
//   - Identical paths are shown once. Alternatives are never invented.
// Blocked and unverified routes are still returned (after the eligible ones)
// so the UI can explain why they were rejected.

import { FEASIBILITY } from "./route-math.js";

// outboundMinutes: the brief's T = outbound driving minutes + stop minutes.
// Returns null if either part is unknown (never pretends unknown is 0).
export function outboundMinutes(candidate) {
  const { driveMinutes, stopMinutes } = candidate;
  if (!Number.isFinite(driveMinutes) || !Number.isFinite(stopMinutes)) return null;
  return driveMinutes + stopMinutes;
}

// compareHigherFirst: sort helper for "bigger number wins".
// A null (unknown or N/A) always loses to a real number, so a route with no
// overall score can never be placed above a scored one. Returns a negative
// number if a should come first, positive if b should, 0 if it's a tie.
function compareHigherFirst(a, b) {
  const aKnown = Number.isFinite(a);
  const bKnown = Number.isFinite(b);
  if (aKnown && bKnown) return b - a;
  if (aKnown) return -1; // only a is known -> a first
  if (bKnown) return 1; // only b is known -> b first
  return 0; // both unknown -> tie
}

// compareLowerFirst: sort helper for "smaller number wins" (used for time).
// Again, null always loses.
function compareLowerFirst(a, b) {
  const aKnown = Number.isFinite(a);
  const bKnown = Number.isFinite(b);
  if (aKnown && bKnown) return a - b;
  if (aKnown) return -1;
  if (bKnown) return 1;
  return 0;
}

// compareForRecommendation: the brief's ranking order for eligible routes.
// 1) higher overallScore C, 2) higher safetyScore S, 3) lower time T.
// `||` moves on to the next rule only when the previous one is a tie (0).
// Scores are compared at full precision; rounding is for display only.
// Exported so the traverse planner can find the best itinerary to build
// science detours from, without adding role labels.
export function compareForRecommendation(a, b) {
  return (
    compareHigherFirst(a.overallScore, b.overallScore) ||
    compareHigherFirst(a.safetyScore, b.safetyScore) ||
    compareLowerFirst(outboundMinutes(a), outboundMinutes(b))
  );
}

// itineraryKey: a text "fingerprint" of an itinerary: outbound path, return
// path AND the targets it stops at. The same path with different stops is a
// DIFFERENT itinerary (e.g. a science detour that only adds a stop on the
// way), so both must be kept.
function itineraryKey(candidate, visitIds) {
  return JSON.stringify([candidate.geometry, candidate.returnGeometry, visitIds]);
}

// removeDuplicatePaths: keeps the first candidate for each identical
// itinerary and notes the dropped ids in the kept one's reasons (brief:
// "Deduplicate identical paths"). `visitIdsById` maps candidate id -> the
// target ids it stops at (missing = no stops). Works on copies, so the
// caller's objects are unchanged.
export function removeDuplicatePaths(candidates, visitIdsById = new Map()) {
  const keptByKey = new Map(); // fingerprint -> the candidate we kept
  const kept = [];
  for (const candidate of candidates) {
    const key = itineraryKey(candidate, visitIdsById.get(candidate.id) ?? []);
    const existing = keptByKey.get(key);
    if (existing) {
      existing.reasons.push(`Identical path also listed as "${candidate.id}"; shown once.`);
    } else {
      // Copy the object and its reasons list so we never modify the input.
      const copy = { ...candidate, reasons: [...candidate.reasons] };
      keptByKey.set(key, copy);
      kept.push(copy);
    }
  }
  return kept;
}

// rankCandidates: removes duplicates, assigns roles and sorts.
//
// Inputs:
//   candidates - Candidate objects (already evaluated by evaluateRoute)
//   options.scienceExcludedIds - ids whose scienceValue is incomplete (a
//       visited target has no rating). They can't be "Science-focused",
//       because their true science value is unknown.
//   options.visitIdsById - candidate id -> visited target ids, used by
//       duplicate removal (same path + different stops = different itinerary).
//
// Returns { candidates, messages }:
//   candidates - recommended first, then other eligible routes, then blocked,
//                then unverified (each group keeps its original data order).
//   messages   - readable notes for the result's `errors` list (e.g. when no
//                route is feasible, since there's no candidate to attach it to).
export function rankCandidates(
  candidates,
  { scienceExcludedIds = new Set(), visitIdsById = new Map() } = {}
) {
  const messages = [];
  const unique = removeDuplicatePaths(candidates, visitIdsById);

  const eligible = unique.filter((c) => c.feasibility === FEASIBILITY.PASS);
  const blocked = unique.filter((c) => c.feasibility === FEASIBILITY.BLOCKED);
  const unverified = unique.filter((c) => c.feasibility === FEASIBILITY.UNVERIFIED);

  // Sort eligible routes best-first. JavaScript's sort is "stable": exact
  // ties stay in the order the data file listed them.
  const sortedEligible = [...eligible].sort(compareForRecommendation);

  // Role labels are collected per candidate, then put at the START of its
  // reasons so the UI shows them first.
  const roles = new Map(sortedEligible.map((c) => [c, []]));

  // Recommended: the top of the sorted list, but only if it HAS an overall
  // score (a zero-distance route has none, and we don't invent one).
  const recommended = sortedEligible[0];
  if (recommended && Number.isFinite(recommended.overallScore)) {
    roles.get(recommended).push("Recommended: highest overall score.");
  }

  // Fastest: lowest T, ties broken by higher overall score.
  const fastest = [...eligible].sort(
    (a, b) =>
      compareLowerFirst(outboundMinutes(a), outboundMinutes(b)) ||
      compareHigherFirst(a.overallScore, b.overallScore)
  )[0];
  if (fastest && outboundMinutes(fastest) !== null) {
    roles.get(fastest).push("Fastest: lowest outbound travel and stop time.");
  }

  // Science-focused: highest science value among routes whose science value
  // is complete; ties broken by higher overall score. A value of 0 means no
  // rated target is visited, so there's nothing to call "science-focused".
  const scienceCandidates = eligible.filter(
    (c) => !scienceExcludedIds.has(c.id) && c.scienceValue > 0
  );
  const scienceFocused = scienceCandidates.sort(
    (a, b) =>
      compareHigherFirst(a.scienceValue, b.scienceValue) ||
      compareHigherFirst(a.overallScore, b.overallScore)
  )[0];
  if (scienceFocused) {
    roles.get(scienceFocused).push("Science-focused: highest science value of the feasible routes.");
  }

  if (eligible.length === 1) {
    roles.get(eligible[0]).push("Only one feasible route was found.");
  } else if (eligible.length === 0 && unique.length > 0) {
    messages.push("No candidate route passed every check; see each route's reasons.");
  }

  for (const [candidate, labels] of roles) {
    candidate.reasons.unshift(...labels); // unshift = add to the front
  }

  return {
    candidates: [...sortedEligible, ...blocked, ...unverified],
    messages,
  };
}

// The most candidates a single response returns (team decision, milestone 4).
export const MAX_CANDIDATES = 6;

// ROLE_PREFIXES: the start of the role reasons written by rankCandidates.
const ROLE_PREFIXES = ["Recommended:", "Fastest:", "Science-focused:"];

// capCandidates: keeps at most `limit` candidates from an already-ranked list.
// Candidates holding a role (Recommended / Fastest / Science-focused) are
// always kept, so a role is never hidden; the rest fill the remaining places
// in ranked order (eligible first). The ranked order is preserved.
// Returns { candidates, message }; message says how many were hidden, or is
// null if nothing was hidden.
export function capCandidates(ranked, limit = MAX_CANDIDATES) {
  if (ranked.length <= limit) return { candidates: ranked, message: null };

  const hasRole = (c) => c.reasons.some((r) => ROLE_PREFIXES.some((p) => r.startsWith(p)));
  const keep = new Set(ranked.filter(hasRole).slice(0, limit));
  for (const candidate of ranked) {
    if (keep.size >= limit) break;
    keep.add(candidate); // a Set ignores candidates already added
  }
  const candidates = ranked.filter((c) => keep.has(c));
  const hidden = ranked.length - candidates.length;
  return {
    candidates,
    message: `${hidden} more candidate route${hidden === 1 ? " was" : "s were"} hidden (at most ${limit} are shown).`,
  };
}
