import { z } from "zod";
import { MISSION_CONFIG } from "./config.ts";

const number = z.number().finite();
const nonnegative = number.nonnegative();
const id = z.string().trim().min(1).max(100);
const latitude = number.min(-90).max(90);
const longitude = number.min(-180).lt(180);
export const coordinateSchema = z.object({ lat: latitude, lon: longitude });

export const regionSchema = z.object({
  id,
  name: id,
  status: z.enum(["demo", "preview"]),
  bounds: z.object({ south: latitude, west: longitude, north: latitude, east: longitude })
    .refine((bounds) => bounds.south < bounds.north && bounds.west < bounds.east,
      "Bounds must be ordered south < north and west < east."),
  base: coordinateSchema.extend({ label: id, isFictional: z.boolean() }),
  sourceIds: z.array(id),
  dataVersion: id
});
export type Region = z.infer<typeof regionSchema>;

export const routeRequestSchema = z.object({
  requestId: id,
  regionId: id,
  dataVersion: id,
  origin: coordinateSchema,
  stopIds: z.array(id).max(50).refine((ids) => new Set(ids).size === ids.length,
    "Stop IDs must be unique."),
  destination: coordinateSchema,
  base: coordinateSchema,
  remainingMinutes: nonnegative.max(MISSION_CONFIG.missionDurationMinutes),
  currentBatteryKWh: nonnegative.max(MISSION_CONFIG.batteryCapacityKWh),
  // Accepted for compatibility; the API always supplies its own mission config.
  config: z.record(z.string(), z.unknown()).optional()
});
export type RouteRequest = Omit<z.infer<typeof routeRequestSchema>, "config"> & {
  config: typeof MISSION_CONFIG;
};

const geometry = z.array(z.tuple([longitude, latitude]));
const score = number.min(0).max(100).nullable();
export const candidateSchema = z.object({
  id,
  geometry,
  returnGeometry: geometry,
  distanceKm: nonnegative.nullable(),
  driveMinutes: nonnegative.nullable(),
  stopMinutes: nonnegative.nullable(),
  returnMinutes: nonnegative.nullable(),
  outboundEnergyKWh: nonnegative.nullable(),
  returnEnergyKWh: nonnegative.nullable(),
  totalEnergyKWh: nonnegative.nullable(),
  safetyScore: score,
  timeScore: score,
  overallScore: score,
  scienceValue: nonnegative,
  feasibility: z.enum(["pass", "blocked", "unverified"]),
  reasons: z.array(z.string()),
  coveragePercent: number.min(0).max(100).nullable(),
  sourceIds: z.array(id)
});
export const routeResultSchema = z.object({
  requestId: id,
  dataVersion: id,
  candidates: z.array(candidateSchema),
  errors: z.array(z.string())
});
export type RouteResult = z.infer<typeof routeResultSchema>;
export type RoutePlanner = (request: RouteRequest) => unknown | Promise<unknown>;
