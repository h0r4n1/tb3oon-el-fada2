// Local path helpers for the drive view, radar and guidance banner.
//
// They turn a route's real [lon, lat] coordinates (from the route engine) into
// flat local metres around the base, so the drive view can draw the path ahead
// of the simulated rover. This is DISPLAY geometry only: route time, energy,
// scores and verdicts always come from the engine, never from here.

const MARS_RADIUS_M = 3389500;
const DEG = Math.PI / 180;

// [lon, lat] -> {x: metres east, z: metres north} of the origin point.
export function toLocal([lon, lat], origin) {
  return {
    x: (lon - origin.lon) * DEG * MARS_RADIUS_M * Math.cos(origin.lat * DEG),
    z: (lat - origin.lat) * DEG * MARS_RADIUS_M,
  };
}

// A path: local points plus the running distance (metres) at each point.
export function makePath(geometry, origin) {
  const pts = geometry.map((coordinate) => toLocal(coordinate, origin));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return { geometry, pts, cum, length: cum.at(-1) ?? 0 };
}

// Index of the last point at or before distance s (binary search).
export function indexAt(path, s) {
  const { cum } = path;
  if (cum.length < 2 || s <= 0) return 0;
  if (s >= path.length) return cum.length - 1;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Point at distance s along the path (interpolated between real vertices).
export function pointAt(path, s) {
  const { pts, cum } = path;
  if (pts.length === 0) return { x: 0, z: 0 };
  const i = indexAt(path, s);
  if (i >= pts.length - 1) return { ...pts.at(-1) };
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
}

// Same, but as [lon, lat] for the 2D map (interpolated, display only).
export function lonLatAt(path, s) {
  const { geometry, cum } = path;
  if (geometry.length === 0) return null;
  const i = indexAt(path, s);
  if (i >= geometry.length - 1) return geometry.at(-1);
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / span)) : 0;
  return [geometry[i][0] + (geometry[i + 1][0] - geometry[i][0]) * t, geometry[i][1] + (geometry[i + 1][1] - geometry[i][1]) * t];
}

// Heading (radians clockwise from north) around distance s, smoothed over a
// window of +-w metres so that repeated or very short segments do not flicker.
// Returns null where the path does not move (for example, a zero-length leg).
export function headingAt(path, s, w = 15) {
  const a = pointAt(path, Math.max(0, s - w));
  const b = pointAt(path, Math.min(path.length, s + w));
  if (Math.hypot(b.x - a.x, b.z - a.z) < 0.5) return null;
  return Math.atan2(b.x - a.x, b.z - a.z);
}

// Smallest signed angle from b to a, in [-pi, pi]. Positive = clockwise (right).
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// The next maneuver from distance s: the first place within `lookahead` metres
// where the smoothed heading changes by more than `threshold` radians.
// kind: 'arrive' (near the end), 'bear' / 'turn' (with dir), or 'continue'.
export function nextManeuver(path, s, { lookahead = 220, step = 8, threshold = 0.42 } = {}) {
  const remaining = Math.max(0, path.length - s);
  if (remaining < 20) return { kind: 'arrive', distance: remaining };
  const h0 = headingAt(path, s);
  if (h0 === null) return { kind: 'continue', distance: remaining };
  for (let d = step; d <= lookahead && s + d < path.length - 5; d += step) {
    const h = headingAt(path, s + d);
    if (h === null) continue;
    const diff = angleDiff(h, h0);
    if (Math.abs(diff) > threshold) {
      // Size the maneuver by the heading just AFTER the bend (40 m on), so a
      // sharp corner is a "turn", not the start of a gentle "bear".
      const after = headingAt(path, Math.min(path.length, s + d + 40)) ?? h;
      const total = Math.abs(angleDiff(after, h0)) > Math.abs(diff) ? angleDiff(after, h0) : diff;
      return { kind: Math.abs(total) > 1.05 ? 'turn' : 'bear', dir: total > 0 ? 'right' : 'left', distance: d };
    }
  }
  return { kind: 'continue', distance: remaining };
}

// Distance along the path of the vertex closest to a [lon, lat] point.
export function distanceOfPoint(path, [lon, lat]) {
  let best = 0;
  let bestD = Infinity;
  path.geometry.forEach(([x, y], i) => {
    const d = Math.hypot((x - lon) * Math.cos(lat * DEG), y - lat);
    if (d < bestD) { bestD = d; best = i; }
  });
  return path.cum[best] ?? 0;
}
