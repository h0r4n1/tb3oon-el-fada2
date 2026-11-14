// NEBULA - The rover traverse as a route network (owned by Abood, Route Engineer).
//
// data/map-layers/rover_path_2d.geojson is NASA's real Mars 2020 (Perseverance)
// traverse: the path the rover actually drove, as 559 LineString pieces in
// [lon, lat] order, with one elevation per point. It is source mission data,
// NOT a computed crewed-rover route and NOT a terrain-safety proof.
//
// This file turns that path into something the route engine can use:
//   - one ordered list of points (vertices) with cleaned elevations,
//   - "continuous runs": stretches with no gap in the data (a route may never
//     jump across a gap, because we don't know the ground in between),
//   - snapping: finding where a {lat, lon} point touches the traverse,
//   - slicing: the part of the traverse between two vertices,
//   - segments of about 50 m with an along-route slope for each.
//
// Units: metres along the path are kept in metres here. Kilometres for the
// route maths come only from pathDistanceKm (the single metres -> km place).

import { loadMapData } from "./map-data.js";
import { ApiError } from "./errors.js";
import { haversineDistanceM, pathDistanceKm } from "./geo.js";

// --- Named constants (proposed for server/config.ts once the team agrees) ---

// A piece that starts more than 10 m from where the previous piece ended
// begins a new continuous run. Measured on the real data: normal spacing is
// ~1 m (99% under 7.8 m); the five real gaps are 43 to 299 m.
export const TRAVERSE_GAP_TOLERANCE_M = 10;

// Slopes are measured over windows of about 50 m along the path. Neighbouring
// points are ~1 m apart, so point-to-point slopes are mostly noise; Abood's
// analysis of 5-100 m windows chose ~50 m.
export const SLOPE_WINDOW_M = 50;

// A requested point "is on the traverse" if a vertex lies within 25 m of it.
export const SNAP_TOLERANCE_M = 25;

// The rover often drove past the same place more than once. Matching
// vertices more than 100 m apart ALONG THE PATH count as separate passes.
export const PASS_SEPARATION_M = 100;

// At most this many passes per point are considered (closest first), so the
// number of candidate routes stays small.
export const MAX_PASSES_PER_POINT = 3;

// The data marks missing elevation with 2.2e-05. Real elevations here are
// about -2586 to -1786, so anything above -100 is treated as unknown (null).
export const ELEVATION_NODATA_ABOVE_M = -100;

// cleanElevation: returns the elevation in (unverified) metres, or null if it
// is missing, not a number, or the no-data marker. Never 0 for unknown.
export function cleanElevation(value) {
  if (!Number.isFinite(value) || value > ELEVATION_NODATA_ABOVE_M) return null;
  return value;
}

// isValidLonLat: true if a GeoJSON position has a usable lon and lat
// (lon in [-180, 180) as in server/contracts.ts, lat in [-90, 90]).
function isValidLonLat(position) {
  const [lon, lat] = position;
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -180 && lon < 180 && lat >= -90 && lat <= 90;
}

// buildTraverse: flattens the GeoJSON pieces into one ordered vertex list.
//
// Each vertex is { lon, lat, elevationM, cumulativeM, runIndex, sol }:
//   elevationM  - cleaned elevation (null when unknown)
//   cumulativeM - metres driven along the traverse from its very first point.
//                 Gaps are NOT counted (we never pretend to drive across one).
//   runIndex    - which continuous run the vertex belongs to (0, 1, 2, ...)
//   sol         - the Mars day of the drive (from the piece's properties)
// Consecutive duplicate points (same lon and lat) are dropped; the first
// copy is kept. Returns { vertices, gaps, isSynthetic }, where each gap is
// { atCumulativeM, gapM, sol } (where along the path it falls and how wide).
// SUPERSEDED_PREFIX_TOLERANCE_M: how closely an earlier piece must match the
// start of a later piece (point by point) to count as a partial download of
// it. Measured on the real data: the matches are 0 m (one pair 0.4 m).
export const SUPERSEDED_PREFIX_TOLERANCE_M = 1;

// countUnknownElevations: how many points of a piece have no usable elevation.
function countUnknownElevations(feature) {
  const n = feature.geometry.coordinates.length;
  const elevations = feature.properties?.elevations;
  let unknown = 0;
  for (let j = 0; j < n; j++) {
    if (cleanElevation(Array.isArray(elevations) ? elevations[j] : null) === null) unknown += 1;
  }
  return unknown;
}

// isPrefixOf: true if every point of `shorter` lies within the tolerance of the
// point at the same position in `longer` (the shorter piece is a copy of the
// start of the longer one).
function isPrefixOf(shorter, longer) {
  const a = shorter.geometry.coordinates;
  const b = longer.geometry.coordinates;
  if (a.length > b.length) return false;
  return a.every((position, j) =>
    haversineDistanceM({ lon: position[0], lat: position[1] }, { lon: b[j][0], lat: b[j][1] }) <=
      SUPERSEDED_PREFIX_TOLERANCE_M
  );
}

// dropSupersededPieces: the NASA file contains partial downloads. When the
// rover's drive data arrived in parts, an earlier piece (e.g. sol 350,
// 9_2982 -> 9_3478) was later re-sent as part of a longer piece starting at
// the SAME place (sol 352, 9_2982 -> 9_5676). Keeping both made the path
// jump backwards, which looked like "gaps". For each group of pieces with the
// same fromRMC, we keep ONE piece: the longest; on a tie, the one with fewer
// unknown elevations; then the later one. A piece is only dropped if it is
// really a copy of the start of the kept piece (checked point by point).
// Pieces without a fromRMC are always kept.
// Returns { kept: [features], dropped: [{ index, sol, fromRMC, toRMC, keptIndex }] }.
export function dropSupersededPieces(features) {
  const groups = new Map();
  features.forEach((feature, index) => {
    const from = feature.properties?.fromRMC;
    if (typeof from !== "string") return;
    if (!groups.has(from)) groups.set(from, []);
    groups.get(from).push(index);
  });

  const droppedIndexes = new Map(); // index -> keptIndex
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const keep = [...indexes].sort((i, j) =>
      features[j].geometry.coordinates.length - features[i].geometry.coordinates.length ||
      countUnknownElevations(features[i]) - countUnknownElevations(features[j]) ||
      j - i
    )[0];
    for (const index of indexes) {
      if (index !== keep && isPrefixOf(features[index], features[keep])) droppedIndexes.set(index, keep);
    }
  }

  const kept = [];
  const dropped = [];
  features.forEach((feature, index) => {
    if (droppedIndexes.has(index)) {
      const p = feature.properties ?? {};
      dropped.push({ index, sol: p.sol ?? null, fromRMC: p.fromRMC, toRMC: p.toRMC ?? null, keptIndex: droppedIndexes.get(index) });
    } else {
      kept.push(feature);
    }
  });
  return { kept, dropped };
}

export function buildTraverse(geojson) {
  const vertices = [];
  const gaps = [];
  let runIndex = 0;
  // anchors: waypoint id (site_drive, e.g. "9_5676") -> vertex index. A
  // piece's toRMC is where that drive ENDED, so the id is anchored to the
  // piece's last vertex; its fromRMC (if not already known) to its first.
  // Targets are anchored by id instead of by coordinates, because the rover
  // often passed close to the same spot on different sols.
  const anchors = new Map();
  const { kept, dropped } = dropSupersededPieces(geojson.features);

  kept.forEach((feature) => {
    let pieceStartIndex = null; // vertex index where this piece's first point sits
    const coordinates = feature.geometry.coordinates;
    const elevations = feature.properties?.elevations; // may be missing
    const sol = Number.isFinite(feature.properties?.sol) ? feature.properties.sol : null;

    coordinates.forEach((position, j) => {
      if (!isValidLonLat(position)) {
        throw new ApiError(503, "INVALID_DATA", "rover_path_2d.geojson has an invalid [lon, lat] position.");
      }
      const point = {
        lon: position[0],
        lat: position[1],
        elevationM: cleanElevation(Array.isArray(elevations) ? elevations[j] : null),
        cumulativeM: 0,
        runIndex,
        sol,
      };

      const previous = vertices[vertices.length - 1];
      if (previous) {
        const stepM = haversineDistanceM(previous, point);
        if (j === 0 && stepM > TRAVERSE_GAP_TOLERANCE_M) {
          // A new piece starts too far from the last one: record a gap and
          // start a new run. The gap's width is NOT added to cumulativeM.
          runIndex += 1;
          point.runIndex = runIndex;
          gaps.push({ atCumulativeM: previous.cumulativeM, gapM: stepM, sol });
          point.cumulativeM = previous.cumulativeM;
        } else if (stepM === 0) {
          if (j === 0) pieceStartIndex = vertices.length - 1; // starts on the previous vertex
          return; // duplicate of the previous point: skip it
        } else {
          point.cumulativeM = previous.cumulativeM + stepM;
        }
      }
      if (j === 0) pieceStartIndex = vertices.length;
      vertices.push(point);
    });

    // Anchors for this piece (first point -> fromRMC, last point -> toRMC).
    const props = feature.properties ?? {};
    if (pieceStartIndex !== null) {
      if (typeof props.fromRMC === "string" && !anchors.has(props.fromRMC)) anchors.set(props.fromRMC, pieceStartIndex);
      if (typeof props.toRMC === "string") anchors.set(props.toRMC, vertices.length - 1);
    }
  });

  // `isSynthetic` lets test fixtures label themselves honestly.
  // `droppedPieces` records what dropSupersededPieces removed (for the docs).
  return { vertices, gaps, anchors, droppedPieces: dropped, isSynthetic: geojson.isSynthetic === true };
}

// The parsed traverse is kept in memory per loader function, so the 1.6 MB
// file is read and processed once per server process, not on every request.
// Only successful loads are cached: if the file is missing now, a later
// request will try again. (After the data files change, restart the server.)
const traverseCache = new Map();

// loadTraverse: loads rover_path_2d.geojson through the team's loadMapData
// (which checks the GeoJSON structure and reports DATA_NOT_READY /
// INVALID_DATA) and builds the traverse. `loader` lets tests supply files.
export async function loadTraverse(loader) {
  if (traverseCache.has(loader)) return traverseCache.get(loader);
  const geojson = await loadMapData("rover-path", loader);
  const traverse = buildTraverse(geojson);
  traverseCache.set(loader, traverse);
  return traverse;
}

// snapToTraverse: where does a {lat, lon} point touch the traverse?
//
// Finds every vertex within SNAP_TOLERANCE_M and groups them into passes (a
// new pass starts when the next matching vertex is in another run or more
// than PASS_SEPARATION_M further along the path). Each pass keeps its
// closest vertex. Returns:
//   { passes: [{ vertexIndex, distanceM, runIndex, sol, cumulativeM }],  closest first, max 3
//     nearestM }  distance to the nearest vertex anywhere (for error messages)
export function snapToTraverse(traverse, point) {
  const passes = [];
  let current = null; // the pass being built
  let lastMatch = null;
  let nearestM = Infinity;

  traverse.vertices.forEach((vertex, index) => {
    const distanceM = haversineDistanceM(vertex, point);
    if (distanceM < nearestM) nearestM = distanceM;
    if (distanceM > SNAP_TOLERANCE_M) return;

    const startsNewPass =
      lastMatch === null ||
      vertex.runIndex !== lastMatch.runIndex ||
      vertex.cumulativeM - lastMatch.cumulativeM > PASS_SEPARATION_M;
    if (startsNewPass) {
      current = { vertexIndex: index, distanceM };
      passes.push(current);
    } else if (distanceM < current.distanceM) {
      current.vertexIndex = index; // a closer vertex in the same pass
      current.distanceM = distanceM;
    }
    lastMatch = vertex;
  });

  const described = passes
    .map((pass) => {
      const vertex = traverse.vertices[pass.vertexIndex];
      return { ...pass, runIndex: vertex.runIndex, sol: vertex.sol, cumulativeM: vertex.cumulativeM };
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_PASSES_PER_POINT);

  return { passes: described, nearestM: Number.isFinite(nearestM) ? nearestM : null };
}

// sliceVertices: the vertices from one index to another along the traverse,
// in travel order (it works in either direction). Returns null if the two
// vertices are in different runs, because that slice would cross a gap.
export function sliceVertices(traverse, fromIndex, toIndex) {
  const { vertices } = traverse;
  if (vertices[fromIndex].runIndex !== vertices[toIndex].runIndex) return null;
  const step = fromIndex <= toIndex ? 1 : -1; // forwards or backwards
  const slice = [];
  for (let i = fromIndex; i !== toIndex + step; i += step) slice.push(vertices[i]);
  return slice;
}

// lengthAlongM: metres along the path between two vertices of a slice.
// cumulativeM already holds the along-path distance, so the difference is
// exact; Math.abs makes it work for backwards slices too.
function lengthAlongM(a, b) {
  return Math.abs(b.cumulativeM - a.cumulativeM);
}

// windowSlopeDeg: along-route slope for one window of vertices.
//   slope = degrees(atan(|elevation change| / horizontal distance along path))
// Returns null (unknown) if ANY vertex in the window has no elevation: a
// no-data hole inside the window could hide a steep spot, and unknown terrain
// must never look known. This is "along-track rise/run": it cannot see
// cross-slope, so it is not a terrain-safety proof.
function windowSlopeDeg(windowVertices) {
  if (windowVertices.some((v) => v.elevationM === null)) return null;
  const first = windowVertices[0];
  const last = windowVertices[windowVertices.length - 1];
  const horizontalM = lengthAlongM(first, last);
  if (!(horizontalM > 0)) return null; // can't divide by zero
  const riseM = Math.abs(last.elevationM - first.elevationM);
  return (Math.atan(riseM / horizontalM) * 180) / Math.PI; // radians -> degrees
}

// segmentSlice: cuts a slice into ~50 m windows and returns evaluateRoute's
// segments: [{ distanceKm, slopeDeg, method }].
//   - A window is closed at the first vertex 50 m or more along the path.
//   - A leftover shorter than 25 m is merged into the previous window, so we
//     never judge slope over a tiny, noisy stretch.
//   - distanceKm comes from pathDistanceKm (the one metres -> km conversion).
// A slice of 0 or 1 vertices gives [] (zero distance).
export function segmentSlice(slice) {
  if (!Array.isArray(slice) || slice.length < 2) return [];

  // Step 1: find the vertex positions where windows start and end.
  // WINDOW_ROUNDING_M: 5 steps of 10 m can add up to 49.99999999 m inside
  // the computer; this tiny allowance (a millionth of a millimetre) makes
  // that count as the 50 m it really is.
  const WINDOW_ROUNDING_M = 1e-9;
  const cuts = [0];
  for (let i = 1; i < slice.length; i++) {
    const alongM = lengthAlongM(slice[cuts[cuts.length - 1]], slice[i]);
    if (alongM >= SLOPE_WINDOW_M - WINDOW_ROUNDING_M) cuts.push(i);
  }
  const lastIndex = slice.length - 1;
  if (cuts[cuts.length - 1] !== lastIndex) {
    const leftoverM = lengthAlongM(slice[cuts[cuts.length - 1]], slice[lastIndex]);
    if (leftoverM < SLOPE_WINDOW_M / 2 && cuts.length > 1) {
      cuts[cuts.length - 1] = lastIndex; // stretch the last window to the end
    } else {
      cuts.push(lastIndex);
    }
  }

  // Step 2: build one segment per window.
  const segments = [];
  for (let w = 1; w < cuts.length; w++) {
    const windowVertices = slice.slice(cuts[w - 1], cuts[w] + 1); // inclusive end
    segments.push({
      distanceKm: pathDistanceKm(windowVertices.map((v) => [v.lon, v.lat])),
      slopeDeg: windowSlopeDeg(windowVertices),
      method: "along-track-rise-run",
    });
  }
  return segments;
}

// toGeometry: turns vertices into GeoJSON [lon, lat] pairs for the Candidate.
export function toGeometry(slice) {
  return slice.map((v) => [v.lon, v.lat]);
}
