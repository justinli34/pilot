import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const root = fileURLToPath(new URL("../dist/client/", import.meta.url));
const supported = new Set([".css", ".html", ".js", ".json", ".svg"]);

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

for (const path of await files(root)) {
  if (!supported.has(extname(path))) continue;
  const source = await readFile(path);
  if (source.byteLength < 1_024) continue;
  const [brotli, gzipped] = await Promise.all([
    compressBrotli(source, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    compressGzip(source, { level: 9 }),
  ]);
  await Promise.all([
    ...(brotli.byteLength < source.byteLength ? [writeFile(`${path}.br`, brotli)] : []),
    ...(gzipped.byteLength < source.byteLength ? [writeFile(`${path}.gz`, gzipped)] : []),
  ]);
}
