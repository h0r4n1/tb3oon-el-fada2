// NEBULA - Planning routes along the real traverse (owned by Abood, Route Engineer).
//
// Turns one RouteRequest into candidate itineraries that FOLLOW THE TRAVERSE:
//   outbound = the traverse between the origin and the destination,
//   return   = the traverse from the itinerary endpoint back to base
//              (retracing known ground, so its terrain is known too).
// Nothing is ever drawn as a straight line, and no route crosses a data gap.
//
// It also suggests up to 3 optional science detours (brief Signature 2):
//   - "stop on the way": a listed target already on the outbound path
//     (no extra driving, only stop time and auxiliary energy), and
//   - "extension": a listed target farther along the traverse than the
//     destination, in the same continuous run (more driving both ways).
// Every detour is evaluated with the full round-trip checks.

import { evaluateRoute } from "./route-math.js";
import { summariseStops } from "./candidates.js";
import { compareForRecommendation, outboundMinutes } from "./ranking.js";
import { haversineDistanceM } from "./geo.js";
import {
  SNAP_TOLERANCE_M,
  SLOPE_WINDOW_M,
  snapToTraverse,
  sliceVertices,
  segmentSlice,
  toGeometry,
} from "./traverse.js";

// At most this many science detours are suggested per request.
export const MAX_DETOUR_SUGGESTIONS = 3;

// Source id for the traverse, as already listed in data/region.json.
export const TRAVERSE_SOURCE_IDS = ["m20-traverse"];

// Honesty notes shown on every traverse-based candidate (brief: label
// observed / derived / simulated clearly; never imply a safety guarantee).
const REAL_TRAVERSE_NOTE =
  "Route follows the real Perseverance traverse (source mission data), not a computed crewed route.";
const SYNTHETIC_TRAVERSE_NOTE = "SYNTHETIC test traverse, not real mission data.";
const SLOPE_NOTE =
  `Slopes are along-route rise/run over ~${SLOPE_WINDOW_M} m windows only; cross-slope is not captured, ` +
  "there is no obstacle detection, and this is not a terrain-safety proof.";
const DATUM_NOTE = "Elevation units and vertical datum are unverified.";
const NO_TARGETS_NOTE = "targets.geojson was not available, so science values and detours are not included.";

// metres: formats a distance for reasons, e.g. 12.3 -> "12 m".
const metres = (m) => `${Math.round(m)} m`;

// snapRequestPoint: snaps one requested point (origin, destination or base)
// onto the traverse. If it is too far away, adds a readable error and returns
// null. Otherwise returns the snap result ({ passes, nearestM }).
function snapRequestPoint(traverse, point, label, errors) {
  const snap = snapToTraverse(traverse, point);
  if (snap.passes.length === 0) {
    const distance = snap.nearestM === null ? "too far" : `${metres(snap.nearestM)} away`;
    errors.push(
      `${label} is not on the traverse (nearest traverse point is ${distance}; limit ${SNAP_TOLERANCE_M} m). ` +
        "Choose a point on the rover path."
    );
    return null;
  }
  return snap;
}

// nearestTargetTo: the listed target closest to a point, if one lies within
// the snap tolerance; otherwise null. Used to recognise "the destination is
// this target". Returns { id, distanceM } or null.
function nearestTargetTo(targets, point) {
  let best = null;
  for (const [id, target] of targets) {
    if (!target.point) continue;
    const distanceM = haversineDistanceM(target.point, point);
    if (distanceM <= SNAP_TOLERANCE_M && (best === null || distanceM < best.distanceM)) {
      best = { id, distanceM };
    }
  }
  return best;
}

// isNearVertex: true if a vertex is within the snap tolerance of a point.
function isNearVertex(vertex, point) {
  return haversineDistanceM(vertex, point) <= SNAP_TOLERANCE_M;
}

// placeStops: checks that the requested stops lie on the outbound slice in
// the requested order. For each stop it finds the FIRST slice vertex (at or
// after the previous stop) within the snap tolerance of the target.
// Returns { positions } (index in the slice for each stop) or { problem }
// (a readable sentence saying what is wrong).
function placeStops(slice, stopIds, targets) {
  const positions = [];
  let from = 0;
  for (const id of stopIds) {
    const point = targets.get(id).point;
    let found = -1;
    for (let i = from; i < slice.length; i++) {
      if (isNearVertex(slice[i], point)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      // Is it on the slice at all, just earlier than the previous stop?
      const earlier = slice.slice(0, from).some((v) => isNearVertex(v, point));
      return {
        problem: earlier
          ? `Stops are not in travel order: "${id}" comes before the previous stop along this route.`
          : `Stop "${id}" is not on the traverse between the origin and the destination.`,
      };
    }
    positions.push(found);
    from = found;
  }
  return { positions };
}

// bestReturn: the return slice from a vertex back to base. Uses the base pass
// in the SAME continuous run that is closest along the path (retracing known
// ground). Returns { slice, pass } or null when no base pass shares the run
// (then there is no return path, and the route will be blocked).
function bestReturn(traverse, fromIndex, basePasses) {
  const from = traverse.vertices[fromIndex];
  const sameRun = basePasses.filter((p) => p.runIndex === from.runIndex);
  if (sameRun.length === 0) return null;
  const pass = sameRun.reduce((best, p) =>
    Math.abs(p.cumulativeM - from.cumulativeM) < Math.abs(best.cumulativeM - from.cumulativeM) ? p : best
  );
  return { slice: sliceVertices(traverse, fromIndex, pass.vertexIndex), pass };
}

// evaluateItinerary: turns one itinerary into a full Candidate object.
//
// An itinerary is { id, outboundSlice, returnSlice (or null), visitTargetIds, notes }.
// Steps: cut both slices into ~50 m segments, add up stop minutes and science
// for the visited targets, run evaluateRoute (time, energy, scores, verdict),
// and attach honesty notes. coveragePercent = share of all driven km (outbound
// and return) whose slope is known: data coverage, NOT a safety guarantee.
// Returns { candidate, scienceComplete }.
function evaluateItinerary(itinerary, context) {
  const { request, targets, config, isSynthetic } = context;
  const outboundSegments = segmentSlice(itinerary.outboundSlice);
  const returnSegments = itinerary.returnSlice === null ? null : segmentSlice(itinerary.returnSlice);
  const stops = summariseStops(itinerary.visitTargetIds, targets ?? new Map(), config);

  const evaluation = evaluateRoute(
    {
      outboundSegments,
      returnSegments,
      stopMinutes: stops.stopMinutes,
      remainingMinutes: request.remainingMinutes,
      currentBatteryKWh: request.currentBatteryKWh,
    },
    config
  );

  // Coverage: how much of the driving has a known slope.
  const driven = [...outboundSegments, ...(returnSegments ?? [])];
  const totalKm = driven.reduce((sum, s) => sum + s.distanceKm, 0);
  const knownKm = driven.filter((s) => s.slopeDeg !== null).reduce((sum, s) => sum + s.distanceKm, 0);
  const coveragePercent = totalKm > 0 ? (100 * knownKm) / totalKm : null;

  const candidate = {
    id: itinerary.id,
    geometry: toGeometry(itinerary.outboundSlice),
    returnGeometry: itinerary.returnSlice === null ? [] : toGeometry(itinerary.returnSlice),
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
      isSynthetic ? SYNTHETIC_TRAVERSE_NOTE : REAL_TRAVERSE_NOTE,
      SLOPE_NOTE,
      DATUM_NOTE,
      ...(targets ? [] : [NO_TARGETS_NOTE]),
      ...itinerary.notes,
      ...stops.notes,
      ...evaluation.reasons,
    ],
    coveragePercent,
    sourceIds: TRAVERSE_SOURCE_IDS,
  };
  return { candidate, scienceComplete: stops.scienceComplete };
}

// passNote: explains which pass of the traverse a point was matched to, so
// the choice is visible (the rover often passed the same place twice).
function passNote(label, pass, snap) {
  const several = snap.passes.length > 1 ? ` (it is near the traverse at ${snap.passes.length} places)` : "";
  return (
    `${label} matched the traverse pass from sol ${pass.sol ?? "unknown"}, ` +
    `${metres(pass.cumulativeM)} along the traverse, ${metres(pass.distanceM)} from the requested point${several}.`
  );
}

// totalTripMinutes: outbound drive + stops + return drive, or null if unknown.
function totalTripMinutes(candidate) {
  const outbound = outboundMinutes(candidate);
  return outbound === null || candidate.returnMinutes === null ? null : outbound + candidate.returnMinutes;
}

// describeReserves: plain-English effect on the return reserves after the
// whole trip (outbound, stops and the drive home).
function describeReserves(candidate, request, config) {
  const reserveKWh = (config.batteryCapacityKWh * config.batteryReservePercent) / 100;
  const trip = totalTripMinutes(candidate);
  const battery =
    candidate.totalEnergyKWh === null
      ? "battery margin unknown"
      : (() => {
          const margin = request.currentBatteryKWh - candidate.totalEnergyKWh - reserveKWh;
          return margin >= 0
            ? `${margin.toFixed(2)} kWh above the ${reserveKWh} kWh battery reserve`
            : `${(-margin).toFixed(2)} kWh short of the ${reserveKWh} kWh battery reserve`;
        })();
  const time =
    trip === null
      ? "time margin unknown"
      : (() => {
          const margin = request.remainingMinutes - trip - config.minimumTimeReserveMinutes;
          return margin >= 0
            ? `${margin.toFixed(1)} min above the ${config.minimumTimeReserveMinutes} min time reserve`
            : `${(-margin).toFixed(1)} min short of the ${config.minimumTimeReserveMinutes} min time reserve`;
        })();
  return `After returning to base: ${battery}; ${time}.`;
}

// findDetours: picks up to MAX_DETOUR_SUGGESTIONS listed targets that are not
// yet visited by the best itinerary:
//   "on-route"  - the target is already on the outbound slice (no extra driving),
//   "extension" - the target is farther along the traverse than the
//                 destination, in the same continuous run.
// A target is offered once (on-route preferred, because it adds no driving).
// Sorted by higher science value, then less extra driving.
function findDetours(best, traverse, targets) {
  const visited = new Set(best.visitTargetIds);
  const originIndex = best.originIndex;
  const destIndex = best.destIndex;
  const direction = Math.sign(destIndex - originIndex); // +1 forwards, -1 backwards, 0 = no movement
  const dest = traverse.vertices[destIndex];
  const suggestions = [];

  for (const [id, target] of targets) {
    if (visited.has(id) || !target.point) continue;

    const onRouteIndex = best.outboundSlice.findIndex((v) => isNearVertex(v, target.point));
    if (onRouteIndex !== -1) {
      suggestions.push({ type: "on-route", id, target, extraM: 0, slicePosition: onRouteIndex });
      continue;
    }
    if (direction === 0) continue; // no travel direction to extend along

    // Walk on from the destination, staying inside the same continuous run.
    // Once we come within range of the target, keep walking while still in
    // range and remember the CLOSEST vertex; stop when we move out of range.
    let closest = null; // { index, distanceM }
    for (let j = destIndex + direction; j >= 0 && j < traverse.vertices.length; j += direction) {
      const vertex = traverse.vertices[j];
      if (vertex.runIndex !== dest.runIndex) break; // never cross a gap
      const distanceM = haversineDistanceM(vertex, target.point);
      if (distanceM <= SNAP_TOLERANCE_M) {
        if (closest === null || distanceM < closest.distanceM) closest = { index: j, distanceM };
      } else if (closest !== null) {
        break; // we have passed the target
      }
    }
    if (closest !== null) {
      suggestions.push({
        type: "extension",
        id,
        target,
        extraM: Math.abs(traverse.vertices[closest.index].cumulativeM - dest.cumulativeM),
        newDestIndex: closest.index,
      });
    }
  }

  return suggestions
    .sort((a, b) => (b.target.scienceValue ?? 0) - (a.target.scienceValue ?? 0) || a.extraM - b.extraM)
    .slice(0, MAX_DETOUR_SUGGESTIONS);
}

// buildDetourItinerary: the best itinerary plus one detour.
//   on-route:  same path; the new stop is inserted in travel order.
//   extension: the outbound slice now runs to the new target; the old
//              destination becomes an intermediate stop (if it was a listed
//              target), and the return starts from the new endpoint.
function buildDetourItinerary(best, detour, number, traverse, basePasses) {
  const id = `${best.id}+detour-${number}`;
  if (detour.type === "on-route") {
    // Insert the new stop among the existing stops by its position on the path.
    const stops = best.stopIds.map((stopId, i) => ({ stopId, position: best.stopPositions[i] }));
    stops.push({ stopId: detour.id, position: detour.slicePosition });
    stops.sort((a, b) => a.position - b.position);
    const stopIds = stops.map((s) => s.stopId);
    return {
      ...best,
      id,
      visitTargetIds: [...stopIds, ...(best.finalTargetId ? [best.finalTargetId] : [])],
      notes: [...best.notes],
    };
  }

  const outboundSlice = sliceVertices(traverse, best.originIndex, detour.newDestIndex);
  const ret = bestReturn(traverse, detour.newDestIndex, basePasses);
  const notes = [...best.notes];
  if (!best.finalTargetId) {
    notes.push("The previous destination is passed on the way (it is not a listed target, so no stop there).");
  }
  return {
    ...best,
    id,
    outboundSlice,
    returnSlice: ret ? ret.slice : null,
    visitTargetIds: [...best.stopIds, ...(best.finalTargetId ? [best.finalTargetId] : []), detour.id],
    notes,
  };
}

// planTraverseRoutes: the traverse planner's entry point.
//
// Inputs: the request, the built traverse, targets (a Map from readTargets,
// or null if targets.geojson was not available) and the mission config.
// Returns { candidates, errors, visitIdsById, scienceExcludedIds } for the
// route engine to rank. `errors` explains anything that could not be planned.
//
// Rules (agreed with Abood, milestone 4):
//   - Origin, destination and base must each be within 25 m of the traverse.
//   - The traverse may pass a point more than once: every combination of an
//     origin pass and a destination pass in the same continuous run becomes
//     its own candidate, labelled with the sol of each pass.
//   - A destination within 25 m of the base means "return to base": outbound
//     is empty and the drive home is the return leg.
//   - A listed target within 25 m of the destination counts as the final
//     stop (stop minutes + science value), once, even if also in stopIds.
//   - Requested stops must lie on the outbound slice in stopIds order.
export function planTraverseRoutes(request, traverse, targets, config) {
  const errors = [];
  const result = { candidates: [], errors, visitIdsById: new Map(), scienceExcludedIds: new Set() };
  const context = { request, targets, config, isSynthetic: traverse.isSynthetic };

  // `add` evaluates an itinerary and records it in the result.
  const add = (itinerary) => {
    const { candidate, scienceComplete } = evaluateItinerary(itinerary, context);
    result.candidates.push(candidate);
    result.visitIdsById.set(candidate.id, itinerary.visitTargetIds);
    if (!scienceComplete) result.scienceExcludedIds.add(candidate.id);
    return candidate;
  };

  // 1. Snap the three request points onto the traverse.
  const origin = snapRequestPoint(traverse, request.origin, "Origin", errors);
  const destination = snapRequestPoint(traverse, request.destination, "Destination", errors);
  const base = snapRequestPoint(traverse, request.base, "Base", errors);
  if (!origin || !destination || !base) return result;

  // 2. Return-to-base request: the frontend sends the base as the destination.
  if (haversineDistanceM(request.destination, request.base) <= SNAP_TOLERANCE_M) {
    if (request.stopIds.length > 0) {
      errors.push("Stops can't be added to a return-to-base plan; plan them as an outbound trip instead.");
      return result;
    }
    for (const o of origin.passes) {
      const ret = bestReturn(traverse, o.vertexIndex, base.passes);
      if (!ret) continue; // this origin pass has no way home without crossing a gap
      add({
        id: `trv-home-${o.vertexIndex}`,
        outboundSlice: [traverse.vertices[o.vertexIndex]], // zero-length outbound
        returnSlice: ret.slice,
        visitTargetIds: [],
        notes: [
          "Return-to-base plan: the drive home is the return leg.",
          passNote("Current position", o, origin),
        ],
      });
    }
    if (result.candidates.length === 0) {
      errors.push("No continuous stretch of the traverse links the current position to base (it would cross a data gap).");
    }
    return result;
  }

  // 3. Is the destination a listed target? Then it is the final stop.
  let finalTargetId = null;
  const finalNotes = [];
  if (targets) {
    const match = nearestTargetTo(targets, request.destination);
    if (match) {
      finalTargetId = match.id;
      finalNotes.push(`Destination matches listed target "${match.id}" (${metres(match.distanceM)} away); it counts as the final stop.`);
    }
  }

  // 4. Check the requested stops exist and have a location.
  for (const id of request.stopIds) {
    const target = targets?.get(id);
    if (!target) {
      errors.push(`Stop "${id}" is not a listed target.`);
      return result;
    }
    if (!target.point) {
      errors.push(`Stop "${id}" has no location in targets.geojson.`);
      return result;
    }
  }
  // The destination target is counted once, at the end, even if requested.
  const stopIds = request.stopIds.filter((id) => id !== finalTargetId);

  // 5. Build one itinerary per origin-pass x destination-pass combination.
  const problems = new Set();
  let crossesGap = false;
  const itineraries = [];
  for (const o of origin.passes) {
    for (const d of destination.passes) {
      const outboundSlice = sliceVertices(traverse, o.vertexIndex, d.vertexIndex);
      if (outboundSlice === null) {
        crossesGap = true; // different continuous runs
        continue;
      }
      const placement = placeStops(outboundSlice, stopIds, targets);
      if (placement.problem) {
        problems.add(placement.problem);
        continue;
      }
      const ret = bestReturn(traverse, d.vertexIndex, base.passes);
      const notes = [passNote("Origin", o, origin), passNote("Destination", d, destination), ...finalNotes];
      if (ret) notes.push(`Return retraces the traverse to base (pass from sol ${ret.pass.sol ?? "unknown"}).`);
      itineraries.push({
        id: `trv-${o.vertexIndex}-${d.vertexIndex}`,
        originIndex: o.vertexIndex,
        destIndex: d.vertexIndex,
        outboundSlice,
        returnSlice: ret ? ret.slice : null,
        stopIds,
        stopPositions: placement.positions,
        finalTargetId,
        visitTargetIds: [...stopIds, ...(finalTargetId ? [finalTargetId] : [])],
        notes,
      });
    }
  }

  if (itineraries.length === 0) {
    errors.push(...problems);
    if (crossesGap && problems.size === 0) {
      errors.push(
        "The origin and destination are in different continuous stretches of the traverse; " +
          "a route would cross a gap in the data, so none is offered."
      );
    }
    return result;
  }

  const evaluated = itineraries.map((itinerary) => ({ itinerary, candidate: add(itinerary) }));

  // 6. Science detours, built from the best feasible itinerary only.
  if (!targets) return result;
  const feasible = evaluated.filter((e) => e.candidate.feasibility === "pass");
  if (feasible.length === 0) return result;
  const best = [...feasible].sort((a, b) => compareForRecommendation(a.candidate, b.candidate))[0];

  findDetours(best.itinerary, traverse, targets).forEach((detour, i) => {
    const itinerary = buildDetourItinerary(best.itinerary, detour, i + 1, traverse, base.passes);
    const candidate = add(itinerary);

    // Describe the detour relative to the itinerary it extends.
    const before = totalTripMinutes(best.candidate);
    const after = totalTripMinutes(candidate);
    const addedMinutes = before === null || after === null ? "unknown" : `+${(after - before).toFixed(1)} min`;
    const addedKWh =
      best.candidate.totalEnergyKWh === null || candidate.totalEnergyKWh === null
        ? "unknown"
        : `+${(candidate.totalEnergyKWh - best.candidate.totalEnergyKWh).toFixed(3)} kWh`;
    const kind =
      detour.type === "on-route"
        ? "stop on the way, no extra driving"
        : `extension beyond the destination, +${(detour.extraM / 1000).toFixed(2)} km each way`;
    candidate.reasons.unshift(
      `Optional science detour (${kind}) to "${detour.id}" (science ${detour.target.scienceValue ?? "unrated"}), ` +
        `compared with "${best.candidate.id}": ${addedMinutes}, ${addedKWh}. ` +
        describeReserves(candidate, request, config)
    );
  });

  return result;
}
