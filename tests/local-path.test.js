// Tests for the drive-view path helpers (display geometry only).
// The paths below are SYNTHETIC test shapes, not NASA data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePath, pointAt, headingAt, nextManeuver, distanceOfPoint } from '../src/ui/local-path.js';

const origin = { lat: 18.4, lon: 77.4 };
const metresToDegLat = 1 / ((3389500 * Math.PI) / 180);
// A straight 300 m drive north, then 300 m east (a right turn).
const north = Array.from({ length: 31 }, (_, i) => [77.4, 18.4 + i * 10 * metresToDegLat]);
const lonPerMetre = metresToDegLat / Math.cos((north.at(-1)[1] * Math.PI) / 180);
const east = Array.from({ length: 30 }, (_, i) => [77.4 + (i + 1) * 10 * lonPerMetre, north.at(-1)[1]]);

test('makePath measures local metres from real coordinates', () => {
  const path = makePath([...north, ...east], origin);
  assert.ok(Math.abs(path.length - 600) < 1, `length ${path.length}`);
  const mid = pointAt(path, 150);
  assert.ok(Math.abs(mid.z - 150) < 1 && Math.abs(mid.x) < 1);
});

test('heading is north on the first leg and east on the second', () => {
  const path = makePath([...north, ...east], origin);
  assert.ok(Math.abs(headingAt(path, 100)) < 0.05);
  assert.ok(Math.abs(headingAt(path, 450) - Math.PI / 2) < 0.05);
});

test('nextManeuver finds the right turn ahead, then Continue after it', () => {
  const path = makePath([...north, ...east], origin);
  const before = nextManeuver(path, 150);
  assert.equal(before.kind, 'turn');
  assert.equal(before.dir, 'right');
  assert.ok(before.distance > 100 && before.distance < 160);
  assert.equal(nextManeuver(path, 400).kind, 'continue');
  assert.equal(nextManeuver(path, 590).kind, 'arrive');
});

test('repeated vertices do not create false turns or a null heading mid-path', () => {
  const doubled = north.flatMap((p) => [p, p, p]);
  const path = makePath(doubled, origin);
  assert.equal(nextManeuver(path, 50).kind, 'continue');
  assert.ok(headingAt(path, 100) !== null);
});

test('a zero-length path has no heading and arrives immediately', () => {
  const path = makePath([north[0], north[0]], origin);
  assert.equal(headingAt(path, 0), null);
  assert.equal(nextManeuver(path, 0).kind, 'arrive');
});

test('distanceOfPoint returns the distance of the closest vertex', () => {
  const path = makePath([...north, ...east], origin);
  assert.ok(Math.abs(distanceOfPoint(path, east[9]) - 400) < 1);
});
