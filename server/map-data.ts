import { z } from "zod";
import { loadJsonData } from "./data.ts";
import { ApiError } from "./errors.ts";

export const MAP_DATA_FILES = {
  waypoints: "map-layers/waypoints_2d.geojson",
  "rover-path": "map-layers/rover_path_2d.geojson"
} as const;
export type MapDataLayer = keyof typeof MAP_DATA_FILES;

// Serve the generated 2D map layers without dropping elevation properties,
// CRS metadata or other foreign members. Source 3D datasets are not a fallback.
// This does not verify the dataset's planetary reference frame or provenance.
const position = z.array(z.number().finite()).length(2);
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
