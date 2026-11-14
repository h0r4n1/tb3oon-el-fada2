// Canvas artwork for the Rover OS screens: the orbit backdrop, the
// ILLUSTRATIVE procedural terrain behind the rover, the projected route ribbon,
// the rover and the fictional lander, and the radar.
//
// Recovered from Naser's Rover OS (frontend af3c7da) and changed so that the
// ribbon, chevrons, stop beacons, lander and radar are drawn from the REAL
// route geometry returned by the engine (converted to local metres), instead
// of the old sine-wave road. The hills themselves are illustrative only: there
// is no elevation grid, and the screen says "Illustrative terrain".

import { pointAt, headingAt } from './local-path.js';

// 1 local metre = VISUAL_SCALE drawing units. Only changes how the picture
// looks (how far ahead you can see), never a route number.
export const VISUAL_SCALE = 0.35;

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

// view = {
//   cam: {x, z} rover position in local metres, yaw: heading (rad, cw from north),
//   descent: 0..1 (1 = on the ground), path: active leg path, s: distance along it,
//   showRoute: draw the ribbon/chevrons, stops: [{x, z, label, done}],
//   lander: {x, z} | null, moving: bool, t: seconds
// }
export function drawSurface(ctx, w, h, view) {
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
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = ['#695047', '#755447', '#846047'][layer];
    ctx.beginPath();
    ctx.moveTo(0, horizon + layer * 15);
    const shift = view.yaw * 180;
    for (let x = 0; x <= w + 20; x += 20) {
      ctx.lineTo(x, horizon - 25 - Math.sin((x + shift * (layer + 1)) * 0.009 + layer * 3) * 22 - Math.cos((x + shift) * 0.023 + layer) * 12 + layer * 16);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
  }

  const S = VISUAL_SCALE;
  const camX = view.cam.x * S;
  const camZ = view.cam.z * S;
  const alt = 45 + Math.pow(1 - view.descent, 3) * 650;
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const unit = Math.min(w, h) * 0.95;

  // World (drawing units) -> screen. depth is measured along the heading.
  function project(x, z, y = 0) {
    const dx = x - camX;
    const dz = z - camZ;
    const depth = dx * sy + dz * cy + 50;
    const scale = unit / Math.max(8, depth);
    return [w / 2 + (dx * cy - dz * sy) * scale, horizon + (alt - y) * scale, scale, depth];
  }
  function groundPoint(x, z) {
    const wx = camX + x * cy + z * sy;
    const wz = camZ - x * sy + z * cy;
    return project(wx, wz, terrainY(wx, wz));
  }

  // Illustrative ground mesh.
  for (let z = 1800; z > 30; z -= 35) {
    for (let x = -900; x < 950; x += 55) {
      const p = [groundPoint(x, z), groundPoint(x + 55, z), groundPoint(x + 55, z + 35), groundPoint(x, z + 35)];
      const shade = Math.round(55 + noise(camX + x * cy + z * sy, camZ - x * sy + z * cy) * 0.28 + (z / 1800) * 25);
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

  const worldAt = (s) => {
    const p = pointAt(view.path, s);
    return { x: p.x * S, z: p.z * S };
  };

  // Projected route ribbon: ONLY the upcoming part of the active leg, from the
  // rover to the leg endpoint (completed path is not drawn).
  if (view.showRoute && view.path && view.path.length > 0) {
    const end = view.path.length;
    const reach = Math.min(end, view.s + 3600);
    const stepM = 6;
    for (let s1 = view.s; s1 < reach; s1 += stepM) {
      const s2 = Math.min(end, s1 + stepM);
      const a = worldAt(s1);
      const b = worldAt(s2);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const nx = ((b.z - a.z) / len) * 4;
      const nz = (-(b.x - a.x) / len) * 4;
      const pa = project(a.x, a.z, terrainY(a.x, a.z) + 1);
      if (pa[3] < 12) continue;
      const quad = [
        project(a.x - nx, a.z - nz, terrainY(a.x, a.z) + 1),
        project(a.x + nx, a.z + nz, terrainY(a.x, a.z) + 1),
        project(b.x + nx, b.z + nz, terrainY(b.x, b.z) + 1),
        project(b.x - nx, b.z - nz, terrainY(b.x, b.z) + 1),
      ];
      const fade = Math.max(0, 1 - (s1 - view.s) / 3600);
      ctx.fillStyle = `rgba(171,246,204,${0.25 + fade * 0.5})`;
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
    }
    // Forward chevrons, every 40 m along the real path, ending at the endpoint.
    const spacing = 40;
    const first = Math.ceil((view.s + 10) / spacing) * spacing;
    for (let s = first; s < Math.min(end - 5, view.s + 900); s += spacing) {
      const p = worldAt(s);
      const pp = project(p.x, p.z, terrainY(p.x, p.z) + 2);
      if (pp[3] < 70) continue; // skip chevrons right under the camera
      const heading = headingAt(view.path, s, 8);
      const rel = heading === null ? 0 : heading - view.yaw;
      const size = pp[2] * 7;
      ctx.save();
      ctx.translate(pp[0], pp[1]);
      ctx.rotate(rel);
      ctx.strokeStyle = '#d6ffe5cc';
      ctx.lineWidth = Math.max(1, pp[2]);
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
    const p = project(stop.x * S, stop.z * S, terrainY(stop.x * S, stop.z * S));
    if (p[3] < 20 || p[3] > 2600) continue;
    const height = Math.max(18, 70 * p[2]);
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

  // Fictional lander next to the real landing coordinates (base).
  if (view.lander) {
    const lx = view.lander.x * S + 12;
    const lz = view.lander.z * S;
    const base = project(lx, lz, 0);
    // Only draw it when it is clearly ahead of the rover (not right behind
    // the camera), and keep it a sensible size.
    if (base[3] > 110 && base[3] < 2400) {
      const [bx, by] = base;
      const scale = base[2] * 0.4;
      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.35 + 300 / base[3]);
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

  // Rover silhouette (illustrative vehicle, not a NASA model).
  const rw = Math.min(w * 0.21, 220);
  const rh = rw * 0.48;
  ctx.save();
  ctx.translate(w / 2, h * 0.79);
  ctx.rotate(view.moving ? Math.sin(view.t * 3) * 0.008 : 0);
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
