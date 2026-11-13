// Proposed prototype assumptions from the team brief, not validated rover limits.
export const MISSION_CONFIG = Object.freeze({
  marsRadiusM: 3389500,
  flatSpeedKmh: 5,
  maxSlopeDegrees: 15,
  missionDurationMinutes: 120,
  minimumTimeReserveMinutes: 15,
  batteryCapacityKWh: 10,
  startChargePercent: 100,
  batteryReservePercent: 20,
  baselineKWhPerKm: 0.5,
  auxiliaryKW: 0.2,
  defaultStopMinutes: 5,
  terrainWeight: 0.7,
  timeWeight: 0.3
});
