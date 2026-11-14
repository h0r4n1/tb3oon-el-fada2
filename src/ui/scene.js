// Canvas artwork for the Rover OS screens: the orbit backdrop, the
// ILLUSTRATIVE procedural terrain behind the rover, the projected route ribbon,
// the rover and the fictional lander, and the radar.
//
// Recovered from Naser's Rover OS (frontend af3c7da) and changed so that the
// ribbon, chevrons, stop beacons, lander and radar are drawn from the REAL
// route geometry returned by the engine (converted to local metres), instead
// of the old sine-wave road. The hills themselves are illustrative only: there
// is no elevation grid, and the screen says "Illustrative terrain".
// v1.2: the drive view uses a FIXED camera, so the terrain stays still and
// only the rover moves (see makeDriveFrame).

import { pointAt } from './local-path.js';


const noise = (x, z) =>
  Math.sin(x * 0.035 + z * 0.013) * 12 + Math.cos(x * 0.016 - z * 0.028) * 17 + Math.sin(x * 0.009 + z * 0.005) * 28;
const terrainY = (x, z) => noise(x, z) * 0.55;

// Orbit backdrop (procedural stars and planet glow behind the NASA globe image).
export function drawOrbit(ctx, w, h, t) {
  ctx.fillStyle = '#07090b';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 170; i++) {
    const x = ((Math.sin(i * 231.7) + 1) * w) / 2;
    const y = ((Math.cos(i * 17.43) + 1) * h) / 2;
    ctx.fillStyle = `rgba(230,231,215,${0.15 + (i % 5) * 0.12})`;
    ctx.fillRect(x, y, i % 9 === 0 ? 2 : 1, 1);
  }
  const r = Math.min(w, h) * 0.51;
  const cx = w * 0.76;
  const cy = h * 0.58;
  ctx.strokeStyle = '#daa47d25';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 1.25, r * 0.23, -0.3 + Math.sin(t * 0.05) * 0.01, 0, 7);
  ctx.stroke();
}

// FIXED CAMERA for the drive view (v1.2). The camera is chosen once per
// mission so that the base, the curated targets and the route all fit in the
// frame. The terrain and background are drawn from that fixed camera and
// never move; only the rover (and the route ahead of it) changes.
//
// points: local metres [{x, z}] to fit (base, targets, route).
// headingHint: fallback viewing direction (radians, clockwise from north).
export function makeDriveFrame(points, headingHint, w, h) {
  const unit = Math.min(w, h) * 0.95;
  const horizon = h * 0.41;
  const cxm = points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length);
  const czm = points.reduce((sum, p) => sum + p.z, 0) / Math.max(1, points.length);
  // Look from the base toward the middle of the mission area.
  const yaw = Math.hypot(cxm, czm) > 1 ? Math.atan2(cxm, czm) : headingHint ?? 0;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const uv = points.map((p) => ({ u: p.x * cy - p.z * sy, v: p.x * sy + p.z * cy }));
  const umin = Math.min(...uv.map((p) => p.u));
  const umax = Math.max(...uv.map((p) => p.u));
  const vmin = Math.min(...uv.map((p) => p.v));
  const vmax = Math.max(...uv.map((p) => p.v));
  const uc = (umin + umax) / 2;
  const D0 = 160; // depth of the nearest point (drawing units)
  const alt = ((0.76 * h - horizon) * D0) / unit; // nearest point sits at 76% of the height
  const farDepth = (alt * unit) / (0.08 * h); // farthest point stays above the horizon
  let k = (farDepth - D0) / Math.max(1, vmax - vmin); // drawing units per metre
  // Shrink until every point fits in the middle of the screen (clear of the rails).
  for (let i = 0; i < 80; i++) {
    const fits = uv.every((p) => Math.abs((p.u - uc) * k) * unit / ((p.v - vmin) * k + D0) <= 0.32 * w);
    if (fits) break;
    k *= 0.92;
  }
  return { yaw, cy, sy, uc, vmin, k, D0, alt, w, h };
}

// view = {
//   frame: from makeDriveFrame (fixed for the whole mission),
//   descent: 0..1 (1 = on the ground), path: active leg path, s: distance along it,
//   showRoute: draw the ribbon/chevrons, stops: [{x, z, label, done}],
//   lander: {x, z} | null, rover: {x, z}, roverYaw: rover heading,
//   moving: bool, t: seconds, dpr: device pixel ratio
// }
let terrainCache = null; // {canvas, key}

function drawBackdrop(ctx, w, h, frame, project) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#342b29');
  sky.addColorStop(0.43, '#b78059');
  sky.addColorStop(0.58, '#d29a68');
  sky.addColorStop(1, '#412d23');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const horizon = h * 0.41;
  ctx.fillStyle = '#e7bb8220';
  ctx.beginPath();
  ctx.arc(w * 0.76, h * 0.23, 25, 0, 7);
  ctx.fill();
  const shift = frame.yaw * 180; // fixed for the mission
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = ['#695047', '#755447', '#846047'][layer];
    ctx.beginPath();
    ctx.moveTo(0, horizon + layer * 15);
    for (let x = 0; x <= w + 20; x += 20) {
      ctx.lineTo(x, horizon - 25 - Math.sin((x + shift * (layer + 1)) * 0.009 + layer * 3) * 22 - Math.cos((x + shift) * 0.023 + layer) * 12 + layer * 16);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
  }
  // Illustrative ground mesh, in the fixed camera's coordinates.
  const ground = (x, z) => project(x, z, terrainY(x, z));
  for (let z = 1800; z > 30; z -= 35) {
    for (let x = -900; x < 950; x += 55) {
      const p = [ground(x, z), ground(x + 55, z), ground(x + 55, z + 35), ground(x, z + 35)];
      const shade = Math.round(55 + noise(x, z) * 0.28 + (z / 1800) * 25);
      ctx.fillStyle = `rgb(${shade + 38},${shade + 9},${shade - 8})`;
      ctx.beginPath();
      p.forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#c98e5720';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }
}

export function drawSurface(ctx, w, h, view) {
  const f = view.frame;
  const horizon = h * 0.41;
  const unit = Math.min(w, h) * 0.95;
  const alt = f.alt + Math.pow(1 - view.descent, 3) * 650;

  // Fixed camera: (lateral, depth, height) in drawing units -> screen.
  function project(lat, depth, y = 0) {
    const scale = unit / Math.max(8, depth);
    return [w / 2 + lat * scale, horizon + (alt - y) * scale, scale, depth];
  }
  // Local metres -> fixed-camera drawing units.
  const toFrame = ({ x, z }) => ({
    lat: (x * f.cy - z * f.sy - f.uc) * f.k,
    depth: (x * f.sy + z * f.cy - f.vmin) * f.k + f.D0,
  });
  const onGround = (p, lift = 1) => {
    const q = toFrame(p);
    return project(q.lat, q.depth, terrainY(q.lat, q.depth) + lift);
  };

  // Terrain and background: drawn once and reused (they never move).
  if (view.descent >= 1) {
    const dpr = view.dpr ?? 1;
    const key = `${w}x${h}@${dpr}`;
    if (!terrainCache || terrainCache.frame !== f || terrainCache.key !== key) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const c = canvas.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackdrop(c, w, h, f, project);
      terrainCache = { canvas, frame: f, key };
    }
    ctx.drawImage(terrainCache.canvas, 0, 0, w, h);
  } else {
    drawBackdrop(ctx, w, h, f, project); // descent: the camera is still coming down
  }

  // Projected route ribbon: ONLY the upcoming part of the active leg, from the
  // rover to the leg endpoint (completed path is not drawn).
  if (view.showRoute && view.path && view.path.length > 0) {
    const end = view.path.length;
    const stepM = 6;
    ctx.fillStyle = 'rgba(171,246,204,0.6)';
    for (let s1 = view.s; s1 < end; s1 += stepM) {
      const s2 = Math.min(end, s1 + stepM);
      const a = toFrame(pointAt(view.path, s1));
      const b = toFrame(pointAt(view.path, s2));
      const len = Math.hypot(b.lat - a.lat, b.depth - a.depth);
      if (len < 1e-6) continue;
      const nx = ((b.depth - a.depth) / len) * 3;
      const nz = (-(b.lat - a.lat) / len) * 3;
      const ya = terrainY(a.lat, a.depth) + 1;
      const yb = terrainY(b.lat, b.depth) + 1;
      const quad = [
        project(a.lat - nx, a.depth - nz, ya),
        project(a.lat + nx, a.depth + nz, ya),
        project(b.lat + nx, b.depth + nz, yb),
        project(b.lat - nx, b.depth - nz, yb),
      ];
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
    }
    // Forward chevrons along the real path, pointing the way, ending at the endpoint.
    const spacing = Math.max(40, end / 45);
    const first = Math.ceil((view.s + 10) / spacing) * spacing;
    for (let s = first; s < end - 5; s += spacing) {
      const pp = onGround(pointAt(view.path, s), 2);
      const ahead = onGround(pointAt(view.path, Math.min(end, s + 6)), 2);
      const angle = Math.atan2(ahead[0] - pp[0], -(ahead[1] - pp[1]));
      const size = Math.max(3, Math.min(14, pp[2] * 4));
      ctx.save();
      ctx.translate(pp[0], pp[1]);
      ctx.rotate(angle);
      ctx.strokeStyle = '#d6ffe5cc';
      ctx.lineWidth = Math.max(1, Math.min(3, pp[2] * 0.6));
      ctx.beginPath();
      ctx.moveTo(-size, size * 0.5);
      ctx.lineTo(0, 0);
      ctx.lineTo(size, size * 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Stop beacons (science stops and the destination) on the real coordinates.
  for (const stop of view.stops ?? []) {
    const p = onGround(stop, 0);
    if (p[3] < 20) continue;
    const height = Math.max(24, Math.min(90, 40 * p[2]));
    ctx.strokeStyle = stop.done ? '#9aa39b88' : '#ffd38a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0], p[1] - height);
    ctx.stroke();
    ctx.fillStyle = stop.done ? '#9aa39b' : '#ffd38a';
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] - height - 9);
    ctx.lineTo(p[0] + 7, p[1] - height);
    ctx.lineTo(p[0], p[1] - height + 9);
    ctx.lineTo(p[0] - 7, p[1] - height);
    ctx.closePath();
    ctx.fill();
    ctx.font = '11px "Space Grotesk", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff6e4';
    ctx.fillText(stop.label, p[0], p[1] - height - 16);
    ctx.textAlign = 'left';
  }

  // Fictional lander next to the real landing coordinates (base). Fixed in the scene.
  if (view.lander) {
    const q = toFrame(view.lander);
    const base = project(q.lat + 14, q.depth, 0);
    if (base[3] > 15) {
      const [bx, by] = base;
      const scale = Math.min(2.6, base[2] * 0.4);
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#0005';
      ctx.beginPath();
      ctx.ellipse(0, 3, 24, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#aab4ad';
      ctx.lineWidth = 2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 8, -12);
        ctx.lineTo(side * 20, 0);
        ctx.lineTo(side * 26, 0);
        ctx.stroke();
      }
      ctx.fillStyle = '#d1d3c6';
      ctx.beginPath();
      ctx.moveTo(-11, -12);
      ctx.lineTo(-9, -42);
      ctx.lineTo(0, -54);
      ctx.lineTo(9, -42);
      ctx.lineTo(11, -12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#233d45';
      ctx.fillRect(-6, -36, 12, 8);
      ctx.fillStyle = '#777e78';
      ctx.fillRect(-11, -19, 22, 7);
      ctx.fillStyle = '#83f4dc';
      ctx.fillRect(-3, -45, 6, 2);
      ctx.restore();
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#d5fff1';
      ctx.fillText('NEBULA BASE · SIMULATED LANDER', bx, by - 60 * scale - 12);
      ctx.textAlign = 'left';
    }
  }

  // Rover silhouette (illustrative vehicle, not a NASA model): the ONLY thing
  // that moves. It sits at its real position along the route and turns to
  // face its direction of travel (it turns around for the drive home).
  const rp = onGround(view.rover, 0);
  const tip = onGround({ x: view.rover.x + Math.sin(view.roverYaw) * 8, z: view.rover.z + Math.cos(view.roverYaw) * 8 }, 0);
  const facing = Math.atan2(tip[0] - rp[0], -(tip[1] - rp[1]));
  const rw = Math.max(26, Math.min(Math.min(w * 0.12, 130), rp[2] * 36));
  const rh = rw * 0.48;
  ctx.save();
  ctx.translate(rp[0], rp[1]);
  ctx.rotate(facing + (view.moving ? Math.sin(view.t * 3) * 0.008 : 0));
  ctx.translate(0, -rh * 0.3);
  ctx.fillStyle = '#0006';
  ctx.beginPath();
  ctx.ellipse(0, rh * 0.65, rw * 0.7, rh * 0.3, 0, 0, 7);
  ctx.fill();
  for (const side of [-1, 1]) {
    for (const yy of [-0.2, 0.35]) {
      ctx.fillStyle = '#141817';
      ctx.fillRect(side * rw * 0.46 - rw * 0.09, yy * rh, rw * 0.18, rh * 0.45);
      ctx.strokeStyle = '#6f7361';
      const roll = view.moving ? (view.t * 6) % 1 : 0;
      for (let n = 0; n < 5; n++) {
        const y = yy * rh + ((n + roll) % 5) * rh * 0.09;
        ctx.beginPath();
        ctx.moveTo(side * rw * 0.46 - rw * 0.08, y);
        ctx.lineTo(side * rw * 0.46 + rw * 0.08, y);
        ctx.stroke();
      }
    }
  }
  ctx.fillStyle = '#b0b09b';
  ctx.beginPath();
  ctx.moveTo(-rw * 0.35, rh * 0.45);
  ctx.lineTo(-rw * 0.27, -rh * 0.45);
  ctx.lineTo(rw * 0.27, -rh * 0.45);
  ctx.lineTo(rw * 0.35, rh * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#354844';
  ctx.fillRect(-rw * 0.22, -rh * 0.35, rw * 0.44, rh * 0.4);
  ctx.strokeStyle = '#dce3c2';
  ctx.strokeRect(-rw * 0.22, -rh * 0.35, rw * 0.44, rh * 0.4);
  ctx.fillStyle = '#5d695c';
  ctx.fillRect(-rw * 0.28, rh * 0.12, rw * 0.56, rh * 0.23);
  ctx.fillStyle = '#edb681';
  ctx.fillRect(-rw * 0.3, rh * 0.36, rw * 0.09, 5);
  ctx.fillRect(rw * 0.21, rh * 0.36, rw * 0.09, 5);
  ctx.strokeStyle = '#a8b4a2';
  ctx.beginPath();
  ctx.moveTo(rw * 0.23, -rh * 0.45);
  ctx.lineTo(rw * 0.23, -rh);
  ctx.stroke();
  ctx.restore();
}

// Radar: heading-up local map, radius `rangeM` metres around the rover.
// radar = {cam, yaw, paths: [{path, color, fromS}], marks: [{x, z, kind}], rangeM}
export function drawRadar(mc, size, radar) {
  const c = size / 2;
  mc.clearRect(0, 0, size, size);
  mc.save();
  mc.beginPath();
  mc.arc(c, c, c - 1, 0, 7);
  mc.clip();
  mc.fillStyle = '#0d1d1a';
  mc.fillRect(0, 0, size, size);
  mc.strokeStyle = '#b4dac333';
  mc.lineWidth = 1;
  for (const r of [0.33, 0.66, 1]) {
    mc.beginPath();
    mc.arc(c, c, (c - 2) * r, 0, 7);
    mc.stroke();
  }
  const k = (c - 4) / radar.rangeM;
  const cy = Math.cos(radar.yaw);
  const sy = Math.sin(radar.yaw);
  // Local metres -> radar pixels, rotated so the rover heading points up.
  const toRadar = (x, z) => {
    const dx = x - radar.cam.x;
    const dz = z - radar.cam.z;
    const lateral = dx * cy - dz * sy;
    const forward = dx * sy + dz * cy;
    return [c + lateral * k, c - forward * k];
  };
  for (const { path, color, fromS = 0, width = 2 } of radar.paths) {
    if (!path || path.pts.length < 2) continue;
    mc.strokeStyle = color;
    mc.lineWidth = width;
    mc.beginPath();
    let started = false;
    for (let i = 0; i < path.pts.length; i++) {
      if (path.cum[i] < fromS) continue;
      const [x, y] = toRadar(path.pts[i].x, path.pts[i].z);
      if (!started) { mc.moveTo(x, y); started = true; } else mc.lineTo(x, y);
    }
    mc.stroke();
  }
  for (const mark of radar.marks) {
    let [x, y] = toRadar(mark.x, mark.z);
    const d = Math.hypot(x - c, y - c);
    const edge = c - 8;
    if (d > edge) { x = c + ((x - c) / d) * edge; y = c + ((y - c) / d) * edge; } // pin to rim
    mc.fillStyle = mark.kind === 'base' ? '#c3f4df' : mark.done ? '#9aa39b' : '#ffd38a';
    mc.beginPath();
    if (mark.kind === 'base') mc.rect(x - 4, y - 4, 8, 8);
    else { mc.moveTo(x, y - 5); mc.lineTo(x + 5, y); mc.lineTo(x, y + 5); mc.lineTo(x - 5, y); }
    mc.fill();
  }
  // Rover heading marker at the centre.
  mc.fillStyle = '#efffd6';
  mc.beginPath();
  mc.moveTo(c, c - 8);
  mc.lineTo(c + 6, c + 6);
  mc.lineTo(c, c + 3);
  mc.lineTo(c - 6, c + 6);
  mc.closePath();
  mc.fill();
  mc.restore();
}
