import { z } from "zod";
import { loadJsonData } from "./data.ts";
import { ApiError } from "./errors.ts";

export const MAP_DATA_FILES = {
  waypoints: "waypoints_slims.geojson",
  "rover-path": "rover_path.geojson"
} as const;
export type MapDataLayer = keyof typeof MAP_DATA_FILES;

// Check the structures used by these two layers; preserve source properties,
// optional altitude coordinates, CRS metadata and other foreign members.
// This does not verify the dataset's planetary reference frame or provenance.
const position = z.array(z.number().finite()).min(2);
const properties = z.record(z.string(), z.unknown()).nullable();
const waypointsSchema = z.looseObject({
  type: z.literal("FeatureCollection"),
  features: z.array(z.looseObject({
    type: z.literal("Feature"),
    properties,
    geometry: z.looseObject({ type: z.literal("Point"), coordinates: position })
  }))
});
const roverPathSchema = z.looseObject({
  type: z.literal("FeatureCollection"),
  features: z.array(z.looseObject({
    type: z.literal("Feature"),
    properties,
    geometry: z.looseObject({ type: z.literal("LineString"), coordinates: z.array(position).min(2) })
  }))
});

export async function loadMapData(
  layer: MapDataLayer,
  loader: (filename: string) => Promise<unknown> = loadJsonData
) {
  const filename = MAP_DATA_FILES[layer];
  if (!filename) throw new ApiError(404, "NOT_FOUND", "Map layer not found.");
  const data = await loader(filename);
  const result = (layer === "waypoints" ? waypointsSchema : roverPathSchema).safeParse(data);
  if (!result.success) {
    throw new ApiError(503, "INVALID_DATA", `${filename} does not match the ${layer} GeoJSON structure.`);
  }
  return result.data;
}
