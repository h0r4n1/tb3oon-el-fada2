import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
// Never recursively remove a path outside this project's generated dist folder.
if (output !== join(root, "dist") || output === root) throw new Error("Invalid build output path.");
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error("Build output must not be a symlink.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const extensions = new Set([".html", ".css", ".js", ".json", ".geojson", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".mp4"]);
const exists = async (path) => lstat(path).then(() => true, () => false);
const entry = await exists(join(root, "index.html")) ? "index.html" : "idex.html";
if (!await exists(join(root, entry))) throw new Error("A frontend index.html is required.");
await cp(join(root, entry), join(output, "index.html"));
for (const file of await readdir(root, { withFileTypes: true })) {
  if (file.isFile() && extname(file.name) === ".css") await cp(join(root, file.name), join(output, file.name));
}
for (const name of ["src", "assets", "public"]) {
  if (await exists(join(root, name))) {
    await cp(join(root, name), name === "public" ? output : join(output, name), {
      recursive: true,
      filter: async (path) => {
        const metadata = await lstat(path);
        return !metadata.isSymbolicLink() && (metadata.isDirectory() || extensions.has(extname(path).toLowerCase()));
      }
    });
  }
}
// Publish the agreed science target catalog for the route picker.
const targetCatalog = join(root, "data", "targets.geojson");
if (await exists(targetCatalog) && (await lstat(targetCatalog)).isFile()) {
  await mkdir(join(output, "map-data"), { recursive: true });
  await cp(targetCatalog, join(output, "map-data", "targets.geojson"));
}
console.log(`Frontend built in dist/ (entry: ${entry}). Backend, scripts and data/ are not public static assets.`);
