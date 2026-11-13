import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { handleRequest } from "./app.ts";
import { serveStatic } from "./static.ts";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = incoming.method ?? "GET";
    const init: RequestInit & { duplex?: "half" } = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const request = new Request(new URL(incoming.url ?? "/", `http://localhost:${port}`), init);
    const path = new URL(request.url).pathname;
    const response = path === "/api" || path.startsWith("/api/")
      ? await handleRequest(request)
      : await serveStatic(request, resolve("dist"));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Local request failed:", error);
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }));
  }
});
server.requestTimeout = 30_000;
server.on("error", (error) => {
  console.error("Could not start the local server:", error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Nebula: http://localhost:${port}`);
  console.log(`API health: http://localhost:${port}/api/health`);
});
