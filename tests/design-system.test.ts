import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "client", "styles");

async function componentStyles(): Promise<Array<{ name: string; source: string }>> {
  const names = (await readdir(stylesDirectory)).filter(
    (name) => name.endsWith(".css") && name !== "tokens.css",
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(stylesDirectory, name), "utf8"),
    })),
  );
}

describe("client design system", () => {
  it("keeps visual pixel and color values in tokens", async () => {
    const violations: string[] = [];
    for (const { name, source } of await componentStyles()) {
      for (const [index, line] of source.split("\n").entries()) {
        const trimmed = line.trim();
        const hasPixelLiteral = /(?:^|[^\w-])\d+(?:\.\d+)?px\b/.test(trimmed);
        const isMediaQuery = trimmed.startsWith("@media");
        const hasColorLiteral = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i.test(trimmed);
        if ((hasPixelLiteral && !isMediaQuery) || hasColorLiteral) {
          violations.push(`${name}:${index + 1}: ${trimmed}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("defines every referenced CSS token", async () => {
    const tokenSource = await readFile(join(stylesDirectory, "tokens.css"), "utf8");
    const styles = await componentStyles();
    const allStyles = [tokenSource, ...styles.map(({ source }) => source)].join("\n");
    const definitions = new Set(
      Array.from(allStyles.matchAll(/--([\w-]+)\s*:/g), (match) => match[1]),
    );
    const references = new Set(
      Array.from(allStyles.matchAll(/var\(--([\w-]+)/g), (match) => match[1]),
    );

    // Set at runtime by App.tsx to support sidebar resizing.
    references.delete("sidebar-width");
    expect(Array.from(references).filter((name) => !definitions.has(name))).toEqual([]);
  });
});
