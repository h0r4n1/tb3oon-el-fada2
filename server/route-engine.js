// NEBULA - Route engine entry point (owned by Abood, Route Engineer).
//
// The API (server/app.ts) calls planRoutes(request) for POST /api/routes.
// The API has already checked the request's shape, region, version, coverage
// and base. This file does all route calculations.
//
// Two ways to find routes ("modes"):
//   1. TRAVERSE mode (preferred): routes follow the real Perseverance traverse
//      in data/map-layers/rover_path_2d.geojson (server/traverse-planner.js).
//   2. CURATED mode (fallback): hand-made routes in data/candidates.json, used
//      only if the traverse file is not available (server/candidates.js).
// Either way the candidates are evaluated, ranked and capped at 6.
// It never returns a made-up route: no match means an empty list plus a message.

import { MISSION_CONFIG } from "./config.ts";
import { loadJsonData } from "./data.ts";
import { ApiError } from "./errors.ts";
import { evaluateRoute } from "./route-math.js";
import { rankCandidates, capCandidates } from "./ranking.js";
import { loadTraverse } from "./traverse.js";
import { planTraverseRoutes } from "./traverse-planner.js";
import {
  readCandidateFile,
  readTargets,
  prepareCandidate,
  matchesRequest,
  summariseStops,
} from "./candidates.js";

// isDataNotReady: true for the team's "this data file hasn't been supplied
// yet" error (thrown by loadJsonData / loadMapData).
function isDataNotReady(error) {
  return error instanceof ApiError && error.code === "DATA_NOT_READY";
}

// loadTraverseIfAvailable: the traverse, or null if its file is missing.
// Any OTHER problem (e.g. INVALID_DATA) is passed on, not hidden.
async function loadTraverseIfAvailable(loadData) {
  try {
    return await loadTraverse(loadData);
  } catch (error) {
    if (isDataNotReady(error)) return null;
    throw error;
  }
}

// planWithTraverse: TRAVERSE mode. Loads targets.geojson; if it is missing,
// planning still works for requests with no stops (no science values, with a
// reason), but a request with stops gets DATA_NOT_READY (team decision).
async function planWithTraverse(request, traverse, loadData, config) {
  let targets = null;
  try {
    targets = readTargets(await loadData("targets.geojson"));
  } catch (error) {
    if (!isDataNotReady(error) || request.stopIds.length > 0) throw error;
  }
  return planTraverseRoutes(request, traverse, targets, config);
}

// planWithCandidates: CURATED mode (milestone 3, unchanged behaviour).
// Loads candidates.json and targets.geojson (missing -> DATA_NOT_READY),
// refuses stale data, checks and matches each curated candidate, and
// evaluates the matching ones.
async function planWithCandidates(request, loadData, config) {
  const errors = [];
  const result = { candidates: [], errors, visitIdsById: new Map(), scienceExcludedIds: new Set() };

  // Promise.all loads both files at the same time. Errors are NOT caught.
  const [candidateData, targetData] = await Promise.all([
    loadData("candidates.json"),
    loadData("targets.geojson"),
  ]);
  const file = readCandidateFile(candidateData);
  const targets = readTargets(targetData);

  // Mixing route data from a different data version could put routes in the
  // wrong place, so we return nothing rather than guess.
  if (file.dataVersion !== request.dataVersion) {
    errors.push(
      `candidates.json is for data version "${file.dataVersion ?? "missing"}", ` +
        `but this request uses "${request.dataVersion}". No routes were planned.`
    );
    return result;
  }

  const seenIds = new Set();
  for (const raw of file.candidates) {
    const prepared = prepareCandidate(raw, file.sourceIds);
    if (prepared.error) {
      errors.push(prepared.error);
      continue;
    }
    if (seenIds.has(prepared.id)) {
      errors.push(`Candidate id "${prepared.id}" appears more than once; only the first was used.`);
      continue;
    }
    seenIds.add(prepared.id);

    if (!matchesRequest(prepared, request)) continue; // not for this trip

    const stops = summariseStops(prepared.visitTargetIds, targets, config);
    if (!stops.scienceComplete) result.scienceExcludedIds.add(prepared.id);
    result.visitIdsById.set(prepared.id, prepared.visitTargetIds);

    const evaluation = evaluateRoute(
      {
        outboundSegments: prepared.outbound.segments,
        returnSegments: prepared.ret === null ? null : prepared.ret.segments,
        stopMinutes: stops.stopMinutes,
        remainingMinutes: request.remainingMinutes,
        currentBatteryKWh: request.currentBatteryKWh,
      },
      config
    );

    // Build the Candidate object field by field, using the exact names in
    // server/contracts.ts (candidateSchema), so nothing extra leaks out.
    result.candidates.push({
      id: prepared.id,
      geometry: prepared.outbound.geometry,
      // No return path -> empty line; feasibility is "blocked" with a reason.
      returnGeometry: prepared.ret === null ? [] : prepared.ret.geometry,
      distanceKm: evaluation.distanceKm,
      driveMinutes: evaluation.driveMinutes,
      stopMinutes: evaluation.stopMinutes,
      returnMinutes: evaluation.returnMinutes,
      outboundEnergyKWh: evaluation.outboundEnergyKWh,
      returnEnergyKWh: evaluation.returnEnergyKWh,
      totalEnergyKWh: evaluation.totalEnergyKWh,
      safetyScore: evaluation.safetyScore,
      timeScore: evaluation.timeScore,
      overallScore: evaluation.overallScore,
      scienceValue: stops.scienceValue,
      feasibility: evaluation.feasibility,
      reasons: [
        ...(file.isSynthetic ? ["SYNTHETIC demonstration data, not a real Mars route."] : []),
        ...prepared.outbound.notes,
        ...(prepared.ret ? prepared.ret.notes : []),
        ...stops.notes,
        ...evaluation.reasons,
      ],
      coveragePercent: prepared.coveragePercent,
      sourceIds: prepared.sourceIds,
    });
  }

  if (result.candidates.length === 0) {
    errors.push(
      "No curated route matches this origin, destination and stop list. " +
        "Choose a listed science target as the destination."
    );
  }
  return result;
}

/**
 * planRoutes: plans and ranks routes for one request (brief sections 6 and 7).
 *
 *  1. Try the traverse (data/map-layers/rover_path_2d.geojson). If it exists,
 *     use TRAVERSE mode; if it is missing, use CURATED mode (candidates.json).
 *     If both are missing, DATA_NOT_READY (503) passes through untouched.
 *  2. Rank the candidates (recommended first; blocked/unverified after).
 *  3. Keep at most 6 (role holders always kept) and say how many were hidden.
 *  4. Echo requestId and dataVersion so the frontend can drop stale answers.
 *
 * `options.loadData` exists only so tests can supply synthetic files without
 * writing into data/ (which the data teammate owns). The API never passes it.
 *
 * @param {import('./contracts.ts').RouteRequest} request
 * @param {{ loadData?: (filename: string) => Promise<unknown> }} [options]
 * @returns {Promise<import('./contracts.ts').RouteResult>}
 */
export async function planRoutes(request, { loadData = loadJsonData } = {}) {
  // The API always supplies its own config; fall back to the same file if not.
  const config = request.config ?? MISSION_CONFIG;

  const traverse = await loadTraverseIfAvailable(loadData);
  const planned = traverse
    ? await planWithTraverse(request, traverse, loadData, config)
    : await planWithCandidates(request, loadData, config);

  const errors = [...planned.errors];
  let candidates = [];
  if (planned.candidates.length > 0) {
    const ranked = rankCandidates(planned.candidates, {
      scienceExcludedIds: planned.scienceExcludedIds,
      visitIdsById: planned.visitIdsById,
    });
    errors.push(...ranked.messages);
    const capped = capCandidates(ranked.candidates);
    if (capped.message) errors.push(capped.message);
    candidates = capped.candidates;
  }

  return {
    requestId: request.requestId,
    dataVersion: request.dataVersion,
    candidates,
    errors,
  };
}
