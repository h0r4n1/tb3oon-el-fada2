// NEBULA - Route engine entry point (owned by Abood, Route Engineer).
//
// The API (server/app.ts) calls planRoutes(request) for POST /api/routes.
// The API has already checked the request's shape, region, version, coverage
// and base. This file does all route calculations: it loads the curated
// routes, keeps the ones that fit the request, evaluates each (time, energy,
// scores, feasibility including the trip home) and ranks them.
// It never returns a made-up route: no match means an empty list plus a message.

import { MISSION_CONFIG } from "./config.ts";
import { loadJsonData } from "./data.ts";
import { evaluateRoute } from "./route-math.js";
import { rankCandidates } from "./ranking.js";
import {
  readCandidateFile,
  readTargets,
  prepareCandidate,
  matchesRequest,
  summariseStops,
} from "./candidates.js";

/**
 * planRoutes: plans and ranks routes for one request (brief sections 6 and 7).
 *
 * Steps:
 *  1. Load data/candidates.json and data/targets.geojson. If a file is missing,
 *     loadJsonData throws DATA_NOT_READY (503); we let it pass through untouched.
 *  2. Refuse stale data: candidates.json must have the request's dataVersion.
 *  3. Check every candidate; broken ones are skipped with a readable error.
 *  4. Keep the candidates that match origin, destination, base and stops.
 *  5. Evaluate each with evaluateRoute (server-supplied config, the crew's
 *     current remaining minutes and battery).
 *  6. Rank them (recommended first) and return the RouteResult contract.
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
  const errors = [];

  // `result` builds the reply. requestId and dataVersion are echoed so the
  // frontend can discard stale answers (brief section 7).
  const result = (candidates) => ({
    requestId: request.requestId,
    dataVersion: request.dataVersion,
    candidates,
    errors,
  });

  // Step 1. Promise.all loads both files at the same time. Any thrown error
  // (DATA_NOT_READY, INVALID_DATA) is deliberately NOT caught here.
  const [candidateData, targetData] = await Promise.all([
    loadData("candidates.json"),
    loadData("targets.geojson"),
  ]);
  const file = readCandidateFile(candidateData);
  const targets = readTargets(targetData);

  // Step 2. Mixing route data from a different data version could put routes
  // in the wrong place, so we return nothing rather than guess.
  if (file.dataVersion !== request.dataVersion) {
    errors.push(
      `candidates.json is for data version "${file.dataVersion ?? "missing"}", ` +
        `but this request uses "${request.dataVersion}". No routes were planned.`
    );
    return result([]);
  }

  // Steps 3 to 5.
  const evaluated = [];
  const scienceExcludedIds = new Set();
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
    if (!stops.scienceComplete) scienceExcludedIds.add(prepared.id);

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
    evaluated.push({
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

  if (evaluated.length === 0) {
    errors.push(
      "No curated route matches this origin, destination and stop list. " +
        "Choose a listed science target as the destination."
    );
    return result([]);
  }

  // Step 6.
  const ranked = rankCandidates(evaluated, { scienceExcludedIds });
  errors.push(...ranked.messages);
  return result(ranked.candidates);
}
