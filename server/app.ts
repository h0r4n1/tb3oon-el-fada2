import { MISSION_CONFIG } from "./config.ts";
import { routeRequestSchema, routeResultSchema, type Region, type RoutePlanner } from "./contracts.ts";
import { loadRegion } from "./data.ts";
import { ApiError } from "./errors.ts";
import { planRoutes } from "./route-engine.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send Content-Type: application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new ApiError(413, "BODY_TOO_LARGE", "JSON requests must be no larger than 64 KiB.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ApiError(413, "BODY_TOO_LARGE", "JSON requests must be no larger than 64 KiB.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must contain valid JSON.");
  }
}

function inside(point: { lat: number; lon: number }, region: Region): boolean {
  const { south, west, north, east } = region.bounds;
  return point.lat >= south && point.lat <= north && point.lon >= west && point.lon <= east;
}

export function createApp(dependencies: {
  planner?: RoutePlanner;
  regionLoader?: () => Promise<Region>;
} = {}) {
  const planner = dependencies.planner ?? planRoutes;
  const regionLoader = dependencies.regionLoader ?? loadRegion;

  return async function handleRequest(request: Request): Promise<Response> {
    let requestId: string | undefined;
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, "");
      const methods: Record<string, string> = {
        "/api/health": "GET", "/api/config": "GET", "/api/region": "GET", "/api/routes": "POST"
      };
      if (!methods[path]) return json({ error: { code: "NOT_FOUND", message: "API endpoint not found." } }, 404);
      if (request.method !== methods[path]) {
        return json({ error: { code: "METHOD_NOT_ALLOWED", message: `Use ${methods[path]}.` } },
          405, { Allow: methods[path] });
      }
      if (path === "/api/health") {
        return json({ status: "ok", service: "nebula-api", simulation: true });
      }
      if (path === "/api/config") {
        return json({ simulation: true, notice: "Prototype assumptions; not validated rover limits.", config: MISSION_CONFIG });
      }
      if (path === "/api/region") return json(await regionLoader());

      const parsed = routeRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new ApiError(400, "INVALID_REQUEST", "Check the route request fields.",
          parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })));
      }
      const input = parsed.data;
      requestId = input.requestId;
      const region = await regionLoader();
      if (region.id !== input.regionId || region.dataVersion !== input.dataVersion) {
        throw new ApiError(409, "DATA_VERSION_MISMATCH", "Reload the region before planning this route.");
      }
      if (region.status !== "demo") {
        throw new ApiError(409, "REGION_PREVIEW_ONLY", "This region is a preview and cannot start a mission.");
      }
      if (![input.origin, input.destination, input.base].every((point) => inside(point, region))) {
        throw new ApiError(422, "OUTSIDE_COVERAGE", "Origin, destination and base must be inside the region coverage.");
      }
      if (input.base.lat !== region.base.lat || input.base.lon !== region.base.lon) {
        throw new ApiError(422, "BASE_MISMATCH", "Use the base coordinates supplied by the region dataset.");
      }
      const output = await planner({ ...input, config: MISSION_CONFIG });
      const result = routeResultSchema.safeParse(output);
      if (!result.success || result.data.requestId !== requestId || result.data.dataVersion !== input.dataVersion) {
        throw new ApiError(502, "INVALID_ENGINE_RESULT", "The route engine returned an invalid or stale result.");
      }
      return json(result.data);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ requestId, error: { code: error.code, message: error.message, details: error.details } }, error.status);
      }
      console.error("Unexpected API failure:", error);
      return json({ requestId, error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, 500);
    }
  };
}

export const handleRequest = createApp();
