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

// ---------------------------------------------------------------------------
// Milestone 2: evaluating a whole route (outbound + return).
// ---------------------------------------------------------------------------

// Score weights from the brief's section 6 formula C = 0.70 S + 0.30 U.
// They are part of the agreed scoring formula (not a tunable vehicle default),
// so they live here with a name rather than as bare numbers in the maths.
const SAFETY_WEIGHT = 0.7;
const TIME_WEIGHT = 0.3;

// Tiny tolerance for "is A more than B?" comparisons on decimals.
// WHY: computers store decimals in binary, so a value like 106.4 may be held
// as 106.39999999999999 or 106.40000000000001. Without a tolerance, a route
// that EXACTLY meets the reserve (which the brief allows) could be wrongly
// blocked by a rounding error a trillion times smaller than anything that
// matters. 1e-9 = 0.000000001 minutes or kWh.
const EPSILON = 1e-9;

// isNonNegativeNumber: true only for real numbers that are 0 or more.
// Rejects null, undefined, NaN, Infinity, text and negative numbers.
function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

// evaluateLeg: runs evaluateSegment on every segment of one direction
// (outbound or return) and adds up the results.
//
// Returns totals for that direction:
//   distanceKm   - sum of segment lengths d_i
//   driveMinutes - sum of t_i
//   energyKWh    - sum of e_i (driving only)
//   sumDQ        - sum of d_i × q_i (needed for the terrain score S)
//   anyBlocked   - true if any segment is steeper than the limit
//   anyUnverified- true if any segment had missing/invalid data
// A total is null if ANY segment's value is unknown: adding an unknown
// number to known ones gives an unknown answer, never a smaller one.
// Reasons are pushed into the shared `reasons` list, labelled with the
// direction and segment number (counting from 1, like people do).
function evaluateLeg(segments, directionLabel, reasons, config) {
  const totals = {
    distanceKm: 0,
    driveMinutes: 0,
    energyKWh: 0,
    sumDQ: 0,
    anyBlocked: false,
    anyUnverified: false,
  };

  segments.forEach((segment, index) => {
    // segment?.distanceKm: if the segment itself is missing (null), this gives
    // undefined instead of crashing, and evaluateSegment marks it unverified.
    const result = evaluateSegment(segment?.distanceKm, segment?.slopeDeg, config);

    for (const reason of result.reasons) {
      reasons.push(`${directionLabel} segment ${index + 1}: ${reason}`);
    }

    if (result.feasibility === FEASIBILITY.BLOCKED) totals.anyBlocked = true;
    if (result.feasibility === FEASIBILITY.UNVERIFIED) totals.anyUnverified = true;

    // The length may be known even if the slope is not, so distance is
    // checked separately from the other values.
    totals.distanceKm = isNonNegativeNumber(segment?.distanceKm) && totals.distanceKm !== null
      ? totals.distanceKm + segment.distanceKm
      : null;

    if (result.feasibility === FEASIBILITY.UNVERIFIED) {
      totals.driveMinutes = null;
      totals.energyKWh = null;
      totals.sumDQ = null;
    } else if (totals.driveMinutes !== null) {
      totals.driveMinutes += result.driveMinutes;
      totals.energyKWh += result.energyKWh;
      totals.sumDQ += segment.distanceKm * result.q;
    }
  });

  return totals;
}

// evaluateRoute: works out the time, energy, scores and verdict for one
// candidate route, INCLUDING the trip home (brief Signature 1, Return Reserve).
//
// Input:
//   {
//     outboundSegments: [{distanceKm, slopeDeg}, ...]  route to the destination
//     returnSegments:   [{distanceKm, slopeDeg}, ...]  route back to base,
//                       or null if there is NO return path
//     stopMinutes:      total science-stop minutes on the outbound itinerary
//     remainingMinutes: mission minutes left right now
//     currentBatteryKWh: battery left right now
//   }
//
// Implements brief section 6:
//   S = 100 [1 − Σ(d·q) / Σd]        terrain score, OUTBOUND segments only
//   T = outbound drive + stop minutes
//   H = remainingMinutes − minTimeReserveMinutes
//   U = 100 · clamp(1 − T/H, 0, 1)    time score
//   C = 0.70 S + 0.30 U               overall score (full precision)
//   E = outbound energy + return energy
//       + auxiliaryKW × (outbound drive + return drive + stop minutes) / 60
//
// Verdict (brief section 6 "A candidate is blocked if..."):
//   BLOCKED    - any known rule is broken: a segment over the slope limit
//                (either direction), no return path, H <= 0, not enough time,
//                or not enough battery. Wins over UNVERIFIED, because one
//                known violation makes the route certainly unusable.
//   UNVERIFIED - nothing is known to be broken, but some data is missing or
//                invalid, so we cannot say it passes.
//   PASS       - everything is known and every check passes.
// Equality at a reserve is allowed. Every failure adds a plain-English reason.
//
// Scores are null if ANY input is unknown (unknown terrain must not improve a
// score), and safetyScore/overallScore are null for a zero-distance route.
export function evaluateRoute(input, config = MISSION_CONFIG) {
  const reasons = [];
  let blocked = false;
  let unverified = false;

  // `input ?? {}` means "use input, or an empty object if input is missing",
  // so reading fields below never crashes.
  const {
    outboundSegments,
    returnSegments,
    stopMinutes,
    remainingMinutes,
    currentBatteryKWh,
  } = input ?? {};

  // --- 1. Check the simple number inputs. No defaults are invented. ---
  if (!isNonNegativeNumber(stopMinutes)) {
    unverified = true;
    reasons.push("Stop minutes are missing or invalid.");
  }
  if (!isNonNegativeNumber(remainingMinutes)) {
    unverified = true;
    reasons.push("Remaining mission minutes are missing or invalid.");
  }
  if (!isNonNegativeNumber(currentBatteryKWh)) {
    unverified = true;
    reasons.push("Current battery level is missing or invalid.");
  }

  // --- 2. Outbound leg. ---
  let outbound;
  if (Array.isArray(outboundSegments)) {
    outbound = evaluateLeg(outboundSegments, "Outbound", reasons, config);
    if (outbound.anyBlocked) blocked = true;
    if (outbound.anyUnverified) unverified = true;
  } else {
    unverified = true;
    reasons.push("Outbound route segments are missing.");
    outbound = { distanceKm: null, driveMinutes: null, energyKWh: null, sumDQ: null };
  }

  // --- 3. Return leg. Three different situations: ---
  let ret; // "return" is a reserved word in JavaScript, so we call it ret
  if (returnSegments === null) {
    // null = the data says there is NO way back. That is a definite blocker.
    blocked = true;
    reasons.push("No return path to base is available.");
    ret = { distanceKm: null, driveMinutes: null, energyKWh: null };
  } else if (Array.isArray(returnSegments) && returnSegments.length === 0) {
    // [] = "no return driving". That only makes sense if the rover never
    // left base (outbound distance exactly 0). Otherwise data is missing.
    if (outbound.distanceKm === 0) {
      ret = { distanceKm: 0, driveMinutes: 0, energyKWh: 0 };
    } else {
      unverified = true;
      reasons.push("Return route is empty but the outbound route leaves base; return data is missing.");
      ret = { distanceKm: null, driveMinutes: null, energyKWh: null };
    }
  } else if (Array.isArray(returnSegments)) {
    ret = evaluateLeg(returnSegments, "Return", reasons, config);
    if (ret.anyBlocked) blocked = true;
    if (ret.anyUnverified) unverified = true;
  } else {
    // undefined or something else that isn't a list: we were not told.
    unverified = true;
    reasons.push("Return route segments are missing.");
    ret = { distanceKm: null, driveMinutes: null, energyKWh: null };
  }

  // Helper flags: is every value needed for a calculation known?
  const knownStop = isNonNegativeNumber(stopMinutes);
  const knownOutbound = outbound.driveMinutes !== null;
  const knownReturn = ret.driveMinutes !== null;

  // --- 4. Time totals. ---
  // T = outbound drive + stops (the brief's "Travel/stop time").
  const T = knownOutbound && knownStop ? outbound.driveMinutes + stopMinutes : null;

  // H = time we may spend, after setting the minimum reserve aside.
  let H = null;
  if (isNonNegativeNumber(remainingMinutes)) {
    H = remainingMinutes - config.minTimeReserveMinutes;
    if (H <= 0) {
      blocked = true;
      reasons.push(
        `No usable mission time: ${remainingMinutes} min remaining is not more than the ${config.minTimeReserveMinutes} min reserve.`
      );
    }
  }

  // Time feasibility: outbound + stops + return + reserve must fit.
  // Skipped when H <= 0, because that case is already blocked above.
  if (T !== null && knownReturn && H !== null && H > 0) {
    const neededMinutes = T + ret.driveMinutes + config.minTimeReserveMinutes;
    // "more than, by a meaningful amount": see EPSILON above.
    if (neededMinutes - remainingMinutes > EPSILON) {
      blocked = true;
      reasons.push(
        `Not enough time: needs ${neededMinutes.toFixed(2)} min including the return trip and ${config.minTimeReserveMinutes} min reserve, ` +
          `but only ${remainingMinutes.toFixed(2)} min remain (short by ${(neededMinutes - remainingMinutes).toFixed(2)} min).`
      );
    }
  }

  // --- 5. Energy. ---
  // E = driving energy both ways + auxiliary power for all drive and stop time.
  // auxiliaryKW × minutes / 60 = kWh (divide by 60 because kW × HOURS = kWh).
  let totalEnergyKWh = null;
  if (knownOutbound && knownReturn && knownStop) {
    const allMinutes = outbound.driveMinutes + ret.driveMinutes + stopMinutes;
    totalEnergyKWh =
      outbound.energyKWh + ret.energyKWh + (config.auxiliaryKW * allMinutes) / 60;
  }

  // Battery feasibility: energy used + reserve must not exceed battery now.
  const batteryReserveKWh = config.batteryReserveFraction * config.batteryCapacityKWh; // 0.2 × 10 = 2 kWh
  if (totalEnergyKWh !== null && isNonNegativeNumber(currentBatteryKWh)) {
    const neededKWh = totalEnergyKWh + batteryReserveKWh;
    if (neededKWh - currentBatteryKWh > EPSILON) {
      blocked = true;
      reasons.push(
        `Not enough battery: needs ${neededKWh.toFixed(4)} kWh including the return trip and ${batteryReserveKWh} kWh reserve, ` +
          `but only ${currentBatteryKWh.toFixed(4)} kWh available (short by ${(neededKWh - currentBatteryKWh).toFixed(4)} kWh).`
      );
    }
  }

  // --- 6. Scores. ---
  let safetyScore = null;
  let timeScore = null;
  let overallScore = null;

  if (!unverified) {
    // S: only defined if the rover actually drives somewhere (avoid ÷ 0).
    if (outbound.distanceKm > 0) {
      safetyScore = 100 * (1 - outbound.sumDQ / outbound.distanceKm);
    } else {
      reasons.push("Zero-distance route: terrain score is not applicable; only stop and auxiliary costs apply.");
    }

    // U: only defined if there is usable time (H > 0), so we never ÷ 0.
    if (H > 0) {
      timeScore = 100 * clamp(1 - T / H, 0, 1);
    }

    // C needs both. If either is N/A we do not invent a number.
    if (safetyScore !== null && timeScore !== null) {
      overallScore = SAFETY_WEIGHT * safetyScore + TIME_WEIGHT * timeScore;
    }
  }

  // --- 7. Verdict. BLOCKED beats UNVERIFIED beats PASS. ---
  let feasibility = FEASIBILITY.PASS;
  if (blocked) feasibility = FEASIBILITY.BLOCKED;
  else if (unverified) feasibility = FEASIBILITY.UNVERIFIED;

  // Field names match the brief's Candidate contract (section 7) exactly.
  return {
    distanceKm: outbound.distanceKm, // outbound distance
    driveMinutes: outbound.driveMinutes, // outbound driving only
    stopMinutes: knownStop ? stopMinutes : null,
    returnMinutes: ret.driveMinutes,
    outboundEnergyKWh: outbound.energyKWh,
    returnEnergyKWh: ret.energyKWh,
    totalEnergyKWh,
    safetyScore,
    timeScore,
    overallScore,
    feasibility,
    reasons,
    coveragePercent: null, // needs Zaid's terrain coverage data
  };
}
