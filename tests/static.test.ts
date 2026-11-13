import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { serveStatic } from "../server/static.ts";

test("static server serves only public build files and rejects traversal", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nebula-static-test-"));
  const directory = join(temporaryRoot, "dist");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "index.html"), "<h1>Synthetic test</h1>");
    await writeFile(join(temporaryRoot, "private.json"), '{"private":true}');
    const response = await serveStatic(new Request("http://localhost/"), directory);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Synthetic test/);
    assert.equal((await serveStatic(new Request("http://localhost/%2e%2e%2fprivate.json"), directory)).status, 404);
    assert.equal((await serveStatic(new Request("http://localhost/%ZZ"), directory)).status, 404);
    assert.equal((await serveStatic(new Request("http://localhost/server/app.ts"), directory)).status, 404);
    const head = await serveStatic(new Request("http://localhost/", { method: "HEAD" }), directory);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    const resolvedTarget = resolve(temporaryRoot);
    if (!resolvedTarget.startsWith(resolve(tmpdir())) || !resolvedTarget.includes("nebula-static-test-")) {
      throw new Error("Invalid test cleanup path.");
    }
    await rm(resolvedTarget, { recursive: true, force: true });
  }
});
