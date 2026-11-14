// Plain JavaScript so imports work both locally and on Vercel (see errors.js).
import { readFile } from "node:fs/promises";
import { ApiError } from "./errors.js";

/**
 * Read a JSON file from data/ or data/map-layers/ (no arbitrary paths).
 * @param {string} filename
 * @returns {Promise<unknown>}
 */
export async function loadJsonData(filename) {
  if (!/^(?:map-layers\/)?[a-z0-9][a-z0-9_-]*\.(json|geojson)$/i.test(filename)) {
    throw new ApiError(400, "INVALID_DATA_FILE", "Use a JSON filename inside data/ or data/map-layers/.");
  }
  let text;
  try {
    // Path is relative to this file (server/ -> ../data/), not the working
    // directory, so Vercel's file tracer bundles data/ with every function.
    text = await readFile(new URL(`../data/${filename}`, import.meta.url), "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      throw new ApiError(503, "DATA_NOT_READY", `The data team has not supplied ${filename} yet.`);
    }
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ApiError(503, "INVALID_DATA", `${filename} is not valid JSON.`);
  }
}
