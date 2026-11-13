import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.ts";
import { regionSchema, type Region } from "./contracts.ts";

// Root datasets plus the dedicated public map-layer folder; no arbitrary paths.
export async function loadJsonData(filename: string): Promise<unknown> {
  if (!/^(?:map-layers\/)?[a-z0-9][a-z0-9_-]*\.(json|geojson)$/i.test(filename)) {
    throw new ApiError(400, "INVALID_DATA_FILE", "Use a JSON filename inside data/ or data/map-layers/.");
  }
  let text: string;
  try {
    text = await readFile(join(process.cwd(), "data", filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ApiError(503, "DATA_NOT_READY", `The data team has not supplied ${filename} yet.`);
    }
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ApiError(503, "INVALID_DATA", `${filename} is not valid JSON.`);
  }
}

export async function loadRegion(): Promise<Region> {
  const result = regionSchema.safeParse(await loadJsonData("region.json"));
  if (!result.success) {
    throw new ApiError(503, "INVALID_DATA", "region.json does not match the region contract.");
  }
  return result.data;
}
