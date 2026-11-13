// NEBULA - Mission configuration (brief section 6 "DEFAULTS").
//
// This is the ONE place where the mission numbers live. Every other file
// imports from here instead of typing numbers directly, so the team can tune
// a value once and the whole app picks it up.
//
// IMPORTANT: these are tunable prototype assumptions, NOT rover engineering
// limits or NASA standards. The UI must disclose them. They need scientific
// validation before any real-world use.

export const MISSION_CONFIG = Object.freeze({
  // Spherical Mars radius in metres (brief section 5). A declared
  // approximation, good enough for short prototype distances.
  marsRadiusM: 3389500,

  // v0: assumed rover speed on flat ground, km/h.
  flatSpeedKmh: 5,

  // L: steepest terrain slope we allow, degrees. Steeper segments are blocked.
  maxSlopeDeg: 15,

  // Total mission length, minutes.
  missionDurationMinutes: 120,

  // Minutes we must always keep unused as a safety reserve.
  minTimeReserveMinutes: 15,

  // Battery size, kWh.
  batteryCapacityKWh: 10,

  // Battery charge at the start, as a fraction (1.0 = 100%).
  startChargeFraction: 1.0,

  // Battery we must never use, as a fraction of capacity (0.20 = 20% = 2 kWh).
  batteryReserveFraction: 0.2,

  // e0: driving energy on flat ground, kWh per km.
  baseDriveKWhPerKm: 0.5,

  // Constant power for life support / electronics etc., kW.
  // Applied at the route level (per minute of the trip), not per segment.
  auxiliaryKW: 0.2,

  // Default time spent at a science stop, minutes.
  defaultStopMinutes: 5,
});
// Object.freeze (above) makes the object read-only, so no code can change a
// value by accident while the app is running.
