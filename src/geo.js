// NEBULA - Geometry helpers for Mars (owned by Abood, Route Engineer).
//
// Small, reusable math used by the route engine. Plain browser-compatible
// JavaScript module: no libraries, works in the browser and in Node tests.

import { MISSION_CONFIG } from "./config.js";

// clamp: keeps a number inside a range.
// Example: clamp(1.3, 0, 1) -> 1, clamp(-0.2, 0, 1) -> 0, clamp(0.5, 0, 1) -> 0.5.
// The brief uses clamping in several formulas (q_i, the haversine "a" value,
// and the time score U), so it lives here once.
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// toRadians: converts degrees to radians.
// Our coordinates are stored in degrees (brief section 5), but JavaScript's
// Math.sin / Math.cos expect radians. 180 degrees = PI radians.
export function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// isValidPoint: checks that a point looks like {lat, lon} with real numbers.
// Latitude must be between -90 and 90 degrees. We do not invent a value for
// a bad point; callers get null instead (brief: "missing values are null,
// never zero").
function isValidPoint(point) {
  return (
    point !== null &&
    typeof point === "object" &&
    Number.isFinite(point.lat) && // rejects null, undefined, NaN, Infinity, strings
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90
  );
}

// haversineDistanceM: the distance in METRES between two points on Mars,
// measured along the surface (not a straight line through the planet).
//
// Implements the brief's section 5 formula exactly:
//   a = sin²(deltaLat/2) + cos(lat1)·cos(lat2)·sin²(deltaLon/2)
//   d = 2R · atan2(√a, √(1−a))      with angles in radians
// R is the Mars radius from config (3,389,500 m), treating Mars as a sphere,
// which the brief declares is an acceptable approximation for short distances.
//
// Why our own function? Leaflet's built-in distance uses EARTH's radius, which
// would give wrong Mars distances. The brief says to avoid it for mission math.
//
// Inputs: two points {lat, lon} in decimal degrees.
// Returns: a number in metres, or null if either point is missing/invalid.
export function haversineDistanceM(pointA, pointB, config = MISSION_CONFIG) {
  if (!isValidPoint(pointA) || !isValidPoint(pointB)) {
    return null;
  }

  const R = config.marsRadiusM;
  const lat1 = toRadians(pointA.lat);
  const lat2 = toRadians(pointB.lat);
  const deltaLat = toRadians(pointB.lat - pointA.lat);
  const deltaLon = toRadians(pointB.lon - pointA.lon);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  // Computer rounding can push "a" a tiny bit above 1 (or below 0) for points
  // that are almost opposite each other. Math.sqrt(1 - a) would then be the
  // square root of a negative number (NaN). Clamping, as the brief requires,
  // prevents that.
  const safeA = clamp(a, 0, 1);

  return 2 * R * Math.atan2(Math.sqrt(safeA), Math.sqrt(1 - safeA));
}
