// NEBULA - Route engine (owned by Abood, Route Engineer).
//
// Milestone 1: evaluate a single route segment (brief section 6).
// Later milestones will add whole-route scores, feasibility and the return trip.
//
// The UI must never recompute these numbers; it only formats what we return.

import { MISSION_CONFIG } from "./config.js";
import { clamp } from "./geo.js";

// Feasibility labels, using the exact words from the brief (section 7,
// Candidate.feasibility: pass | blocked | unverified).
export const FEASIBILITY = Object.freeze({
  PASS: "pass",
  BLOCKED: "blocked",
  UNVERIFIED: "unverified",
});

// evaluateSegment: works out what it "costs" to drive one piece of a route.
//
// Inputs:
//   distanceKm - segment length d_i, in kilometres (must be 0 or more)
//   slopeDeg   - terrain slope s_i, in degrees (must be 0 or more; it is the
//                steepness of the ground, so a negative value means bad data)
//   config     - mission settings (defaults to src/config.js)
//
// Implements the brief's section 6 per-segment formulas:
//   q_i = clamp(s_i / L, 0, 1)     "how steep", 0 = flat, 1 = at/over the limit
//   v_i = v0 / (1 + 2·q_i)          steeper ground -> slower (down to v0/3)
//   t_i = 60 · d_i / v_i            driving minutes (60 turns hours into minutes)
//   e_i = e0 · d_i · (1 + 2·q_i)    driving energy in kWh; steeper -> more energy
//
// Returns: { q, speedKmh, driveMinutes, energyKWh, feasibility, reasons }
//   feasibility "pass"       - inputs valid and slope within the limit
//   feasibility "blocked"    - slope is above the limit (numbers still shown,
//                              so the UI can explain why it was blocked)
//   feasibility "unverified" - input missing or invalid; all numbers are null
//                              (never 0, so bad data can't look like flat ground)
//
// Note: energyKWh is DRIVING energy only. The auxiliary draw (0.2 kW) is added
// later for the whole route, because the brief's total-energy formula E
// applies it to total drive + stop minutes.
export function evaluateSegment(distanceKm, slopeDeg, config = MISSION_CONFIG) {
  const reasons = [];

  // Check the inputs first. Number.isFinite rejects null, undefined, NaN,
  // Infinity and text, so missing data can never sneak through as a number.
  if (!Number.isFinite(distanceKm)) {
    reasons.push("Segment length is missing or not a number.");
  } else if (distanceKm < 0) {
    reasons.push("Segment length cannot be negative.");
  }
  if (!Number.isFinite(slopeDeg)) {
    reasons.push("Terrain slope is missing or unknown.");
  } else if (slopeDeg < 0) {
    reasons.push("Terrain slope cannot be negative (slope is steepness, not up/down).");
  }

  if (reasons.length > 0) {
    // Unknown terrain must not improve a score (brief section 6), so we
    // return null everywhere instead of guessing.
    return {
      q: null,
      speedKmh: null,
      driveMinutes: null,
      energyKWh: null,
      feasibility: FEASIBILITY.UNVERIFIED,
      reasons,
    };
  }

  const L = config.maxSlopeDeg;
  const v0 = config.flatSpeedKmh;
  const e0 = config.baseDriveKWhPerKm;

  const q = clamp(slopeDeg / L, 0, 1);
  const speedKmh = v0 / (1 + 2 * q);

  // Division by zero is impossible here: speedKmh is always at least v0/3
  // (because q is at most 1), so it is never 0. A zero-length segment simply
  // gives 60 * 0 / speed = 0 minutes.
  const driveMinutes = (60 * distanceKm) / speedKmh;
  const energyKWh = e0 * distanceKm * (1 + 2 * q);

  // "Exceeds" the limit means strictly greater: exactly 15 degrees is allowed.
  let feasibility = FEASIBILITY.PASS;
  if (slopeDeg > L) {
    feasibility = FEASIBILITY.BLOCKED;
    reasons.push(`Slope ${slopeDeg}° exceeds the ${L}° limit.`);
  }

  return { q, speedKmh, driveMinutes, energyKWh, feasibility, reasons };
}
