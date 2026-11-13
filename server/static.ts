import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4"
};

export async function serveStatic(request: Request, directory: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  try {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.includes("\\") || path.includes("\0")) return new Response("Not found", { status: 404 });
    const root = await realpath(directory);
    const requested = resolve(root, path === "/" ? "index.html" : "." + path);
    if (!requested.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    const actual = await realpath(requested);
    if (!actual.startsWith(root + sep) || !(await stat(actual)).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const type = MIME[extname(actual).toLowerCase()];
    if (!type) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : await readFile(actual), {
      headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
