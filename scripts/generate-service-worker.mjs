import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = fileURLToPath(new URL("../dist/client/", import.meta.url));
const serviceWorkerPath = join(clientRoot, "sw.js");
const cacheableExtensions = new Set([".css", ".html", ".js", ".png", ".svg", ".webmanifest"]);

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

const cacheableFiles = (await files(clientRoot))
  .filter(
    (path) =>
      path !== serviceWorkerPath &&
      !path.endsWith(".br") &&
      !path.endsWith(".gz") &&
      cacheableExtensions.has(extname(path)),
  )
  .sort();
const precacheUrls = cacheableFiles.map((path) => {
  const outputPath = relative(clientRoot, path).split(sep).join("/");
  return outputPath === "index.html" ? "/" : `/${outputPath}`;
});
const versionHash = createHash("sha256");
for (const path of cacheableFiles) {
  versionHash.update(relative(clientRoot, path));
  versionHash.update(await readFile(path));
}

const template = await readFile(serviceWorkerPath, "utf8");
const source = template
  .replace('"__PILOT_CACHE_VERSION__"', JSON.stringify(versionHash.digest("hex").slice(0, 16)))
  .replace('["__PILOT_PRECACHE_MANIFEST__"]', JSON.stringify(precacheUrls, undefined, 2));

if (source === template) throw new Error("Service worker template placeholders are missing");
await writeFile(serviceWorkerPath, source);
