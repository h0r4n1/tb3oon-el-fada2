import { ApiError } from "./errors.ts";

/**
 * Abood owns this module. Replace the placeholder with his Node-compatible engine.
 * @param {import('./contracts.ts').RouteRequest} request
 * @returns {Promise<import('./contracts.ts').RouteResult>}
 */
export async function planRoutes(request) {
  void request;
  throw new ApiError(503, "ENGINE_NOT_READY", "Abood's route engine has not been integrated yet.");
}
