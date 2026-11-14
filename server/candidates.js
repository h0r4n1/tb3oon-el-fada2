// NEBULA - Reading curated candidate routes (owned by Abood, Route Engineer).
//
// The data teammate supplies hand-made ("curated") routes in data/candidates.json
// and science targets in data/targets.geojson. This file:
//   1. checks those files have the agreed shape (docs/candidates-format.md),
//   2. turns each route's points into segments {distanceKm, slopeDeg},
//   3. decides which routes match a request (origin, destination, stops),
//   4. adds up stop minutes and science value for the targets a route visits.
// It never invents a route, a slope or a science rating.

import { ApiError } from "./errors.ts";
import { haversineDistanceM, pathDistanceKm } from "./geo.js";

// How close (in metres) a route's start/end must be to the requested point to
// count as "the same place". Proposed for server/config.ts later
// (routeMatchToleranceM); kept here until the backend team agrees.
export const ROUTE_MATCH_TOLERANCE_M = 50;

// The ways a slope may have been worked out. Anything else counts as unknown.
//   elevation-gradient   - from the elevation grid (preferred, per the brief)
//   along-track-rise-run - height change along the route only; misses cross-slope
export const KNOWN_SLOPE_METHODS = ["elevation-gradient", "along-track-rise-run"];

// isContractPoint: true if [lon, lat] is a valid GeoJSON position under the
// team contract (server/contracts.ts): lon in [-180, 180), lat in [-90, 90].
// A third number (altitude) is allowed by GeoJSON, but the contract's
// geometry is exactly [lon, lat], so we keep only the first two numbers.
function isContractPoint(pair) {
  return (
    Array.isArray(pair) &&
    pair.length >= 2 &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1]) &&
    pair[0] >= -180 &&
    pair[0] < 180 &&
    pair[1] >= -90 &&
    pair[1] <= 90
  );
}

// isContractId: true for a non-empty text id of at most 100 characters,
// matching the `id` rule in server/contracts.ts.
function isContractId(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 100;
}

// isPlainObject: true for {...} objects (not null, not a list).
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// readCandidateFile: checks the top level of candidates.json.
// A file with the wrong overall shape is a data problem for the whole
// planner, so it throws the same INVALID_DATA error that server/data.ts uses.
// Returns { dataVersion, sourceIds, isSynthetic, candidates }.
export function readCandidateFile(data) {
  if (!isPlainObject(data) || !Array.isArray(data.candidates)) {
    throw new ApiError(503, "INVALID_DATA", "candidates.json must be an object with a \"candidates\" list.");
  }
  return {
    dataVersion: isContractId(data.dataVersion) ? data.dataVersion : null,
    sourceIds: Array.isArray(data.sourceIds) ? data.sourceIds.filter(isContractId) : [],
    isSynthetic: data.isSynthetic === true,
    candidates: data.candidates,
  };
}

// readTargets: turns targets.geojson (a GeoJSON FeatureCollection) into a
// lookup table: target id -> { scienceValue, stopMinutes, point }.
// scienceValue must be 1, 2 or 3 (Naser's rubric), otherwise it is null.
// stopMinutes must be 0 or more, otherwise it is null. Never 0 for unknown.
// point is the target's location as named {lat, lon}, converted from the
// GeoJSON Point's [lon, lat]; null if the feature has no valid Point.
export function readTargets(data) {
  if (!isPlainObject(data) || !Array.isArray(data.features)) {
    throw new ApiError(503, "INVALID_DATA", "targets.geojson must be a GeoJSON FeatureCollection with a \"features\" list.");
  }
  const targets = new Map();
  for (const feature of data.features) {
    const props = feature?.properties; // ?. avoids a crash if feature is null
    if (!isContractId(props?.id)) continue; // a target with no id can't be referenced
    const position = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
    targets.set(props.id, {
      scienceValue: [1, 2, 3].includes(props.scienceValue) ? props.scienceValue : null,
      stopMinutes:
        Number.isFinite(props.stopMinutes) && props.stopMinutes >= 0 ? props.stopMinutes : null,
      point: isContractPoint(position) ? { lat: position[1], lon: position[0] } : null,
    });
  }
  return targets;
}

// buildLeg: checks one direction of a route ({geometry, segments}) and turns
// it into evaluateRoute's segment list.
//
// - geometry: at least 2 valid [lon, lat] points.
// - segments: exactly one entry per pair of neighbouring points.
// - Each segment's LENGTH is measured from the geometry with pathDistanceKm,
//   so the data can never give a distance that disagrees with the map line.
// - Each segment's SLOPE comes from the data, and is only trusted if it says
//   how it was derived (brief: hazards record their derivation method).
//
// Returns { geometry, segments, notes } on success or { error } if the leg is
// too broken to use at all. `notes` are reasons to show on the candidate.
function buildLeg(leg, label) {
  if (!isPlainObject(leg) || !Array.isArray(leg.geometry) || leg.geometry.length < 2) {
    return { error: `${label} route needs a geometry with at least 2 points.` };
  }
  if (!leg.geometry.every(isContractPoint)) {
    return { error: `${label} route has an invalid [lon, lat] point.` };
  }
  const geometry = leg.geometry.map((pair) => [pair[0], pair[1]]); // drop altitude
  const pointPairs = geometry.length - 1;
  if (!Array.isArray(leg.segments) || leg.segments.length !== pointPairs) {
    return {
      error: `${label} route has ${geometry.length} points, so it needs ${pointPairs} segment entries.`,
    };
  }

  const notes = [];
  let mentionedAlongTrack = false;
  const segments = leg.segments.map((entry, i) => {
    // The length of this piece, from point i to point i + 1.
    const distanceKm = pathDistanceKm([geometry[i], geometry[i + 1]]);

    let slopeDeg = entry?.slopeDeg ?? null; // missing -> null (unknown)
    const method = entry?.method;
    if (slopeDeg !== null && !KNOWN_SLOPE_METHODS.includes(method)) {
      // A number without a recorded method can't be checked, so we don't trust it.
      notes.push(`${label} segment ${i + 1}: slope has no recorded derivation method; treated as unknown.`);
      slopeDeg = null;
    }
    if (method === "along-track-rise-run" && slopeDeg !== null && !mentionedAlongTrack) {
      notes.push(`${label} slopes are along-route rise/run only; cross-slope is not captured.`);
      mentionedAlongTrack = true; // say it once per leg, not once per segment
    }
    return { distanceKm, slopeDeg };
  });

  return { geometry, segments, notes };
}

// prepareCandidate: checks one entry in candidates.json and builds both legs.
// Returns { id, outbound, ret, visitTargetIds, coveragePercent, sourceIds }
// or { error } (a readable sentence) if it can't be used safely.
// `ret` is null when the data says there is no return path.
export function prepareCandidate(raw, fileSourceIds = []) {
  if (!isPlainObject(raw) || !isContractId(raw.id)) {
    return { error: "A candidate in candidates.json has no valid id; it was skipped." };
  }
  const id = raw.id;

  const outbound = buildLeg(raw.outbound, "Outbound");
  if (outbound.error) return { error: `Candidate "${id}" skipped: ${outbound.error}` };

  // "return": null in the data = no way back (a definite blocker later).
  let ret = null;
  if (raw.return !== null) {
    ret = buildLeg(raw.return, "Return");
    if (ret.error) return { error: `Candidate "${id}" skipped: ${ret.error}` };
  }

  if (!Array.isArray(raw.visitTargetIds) || !raw.visitTargetIds.every(isContractId)) {
    return { error: `Candidate "${id}" skipped: visitTargetIds must be a list of target ids.` };
  }

  const coveragePercent =
    Number.isFinite(raw.coveragePercent) && raw.coveragePercent >= 0 && raw.coveragePercent <= 100
      ? raw.coveragePercent
      : null;

  // Combine file-level and route-level source ids, without repeats.
  const ownSources = Array.isArray(raw.sourceIds) ? raw.sourceIds.filter(isContractId) : [];
  const sourceIds = [...new Set([...fileSourceIds, ...ownSources])];

  return { id, outbound, ret, visitTargetIds: raw.visitTargetIds, coveragePercent, sourceIds };
}

// isNear: true if a [lon, lat] point is within the match tolerance of a
// {lat, lon} point. Note the conversion from GeoJSON order to named fields.
function isNear(pair, point) {
  const metres = haversineDistanceM({ lat: pair[1], lon: pair[0] }, point);
  return metres !== null && metres <= ROUTE_MATCH_TOLERANCE_M;
}

// includesInOrder: true if every id in `wanted` appears in `list`, in the
// same order (other ids may sit in between). Example: wanted [b, d] is in
// list [a, b, c, d], but wanted [d, b] is not.
function includesInOrder(list, wanted) {
  let position = 0;
  for (const id of list) {
    if (id === wanted[position]) position++;
  }
  return position === wanted.length;
}

// matchesRequest: does this prepared candidate fit what the crew asked for?
//   - outbound starts at request.origin and ends at request.destination,
//   - the return (if any) starts where the outbound ends (the itinerary
//     endpoint, brief section 6) and ends at request.base,
//   - it visits every requested stop, in the requested order.
// A candidate with NO return path can still match; it is then reported as
// blocked, so the UI can explain why.
export function matchesRequest(prepared, request) {
  const out = prepared.outbound.geometry;
  const start = out[0];
  const end = out[out.length - 1];
  if (!isNear(start, request.origin) || !isNear(end, request.destination)) return false;

  if (prepared.ret !== null) {
    const back = prepared.ret.geometry;
    const endPoint = { lat: end[1], lon: end[0] };
    if (!isNear(back[0], endPoint) || !isNear(back[back.length - 1], request.base)) return false;
  }

  return includesInOrder(prepared.visitTargetIds, request.stopIds ?? []);
}

// summariseStops: adds up stop minutes and science value for the unique
// targets a candidate visits.
//   - stopMinutes: each target's own stop time; if a target has none, the
//     configured default (brief: "default science stop 5 minutes") is used
//     and a note says so. An id missing from targets.geojson makes the total
//     unknown (null), so the route becomes unverified.
//   - scienceValue: sum of 1/2/3 ratings of UNIQUE targets (brief: "sum
//     unique visited targets only"). Unrated targets are not counted, are
//     named in a note, and mark the science value as incomplete.
// Returns { stopMinutes, scienceValue, scienceComplete, notes }.
export function summariseStops(visitTargetIds, targets, config) {
  const notes = [];
  const uniqueIds = [...new Set(visitTargetIds)];
  let stopMinutes = 0;
  let scienceValue = 0;
  const unrated = [];

  for (const id of uniqueIds) {
    const target = targets.get(id);
    if (!target) {
      notes.push(`Target "${id}" is not in targets.geojson; its stop time and science value are unknown.`);
      stopMinutes = null; // unknown stays unknown
      unrated.push(id);
      continue;
    }
    if (stopMinutes !== null) {
      if (target.stopMinutes !== null) {
        stopMinutes += target.stopMinutes;
      } else {
        stopMinutes += config.defaultStopMinutes;
        notes.push(`Target "${id}" has no stop time; the default ${config.defaultStopMinutes} min was used.`);
      }
    }
    if (target.scienceValue !== null) {
      scienceValue += target.scienceValue;
    } else {
      unrated.push(id);
    }
  }

  if (unrated.length > 0) {
    notes.push(
      `Science value counts rated targets only; unrated: ${unrated.join(", ")}. ` +
        "This route is not eligible to be called science-focused."
    );
  }
  return { stopMinutes, scienceValue, scienceComplete: unrated.length === 0, notes };
}
