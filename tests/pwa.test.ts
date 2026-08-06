import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function pngDimensions(source: Buffer): { width: number; height: number } {
  expect(source.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}

describe("progressive web app", () => {
  it("publishes an installable manifest with complete icon sizes", async () => {
    const manifest = JSON.parse(
      await readFile(join(root, "public", "manifest.webmanifest"), "utf8"),
    ) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    expect(manifest).toMatchObject({ name: "Pilot", start_url: "/", display: "standalone" });
    for (const icon of manifest.icons) {
      const size = Number(icon.sizes.split("x")[0]);
      const source = await readFile(join(root, "public", icon.src));
      expect(pngDimensions(source)).toEqual({ width: size, height: size });
    }
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
  });

  it("keeps API requests out of the offline cache", async () => {
    const source = await readFile(join(root, "public", "sw.js"), "utf8");
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain("PRECACHE_PATHS.has(url.pathname)");
  });

  it("works around the iOS standalone viewport without adding bottom clearance", async () => {
    const [page, base, responsive] = await Promise.all([
      readFile(join(root, "index.html"), "utf8"),
      readFile(join(root, "src", "client", "styles", "base.css"), "utf8"),
      readFile(join(root, "src", "client", "styles", "responsive.css"), "utf8"),
    ]);
    expect(page).toContain('apple-mobile-web-app-status-bar-style" content="black"');
    expect(page).not.toContain("black-translucent");
    expect(base).toContain("- env(safe-area-inset-top) - var(--space-4)");
    expect(base).toMatch(
      /@supports \(height: 100dvh\)[\s\S]*body,[\s\S]*#root[\s\S]*height: 100dvh;/,
    );
    expect(base).toMatch(
      /@media \(display-mode: standalone\)[\s\S]*html,[\s\S]*#root[\s\S]*height: 100vh;/,
    );
    expect(responsive)
      .toContain(`padding: 0 max(var(--space-2-5), env(safe-area-inset-right)) var(--space-2-5)
      max(var(--space-2-5), env(safe-area-inset-left))`);
    expect(responsive).toMatch(/\.project-tree \{\s+padding-bottom: 0;/);
    expect(responsive).toMatch(/\.archive-section \{\s+padding-bottom: var\(--space-2\);/);
    const standaloneMobile = responsive.slice(
      responsive.indexOf("@media (display-mode: standalone)"),
      responsive.indexOf("@media (max-width: 420px)"),
    );
    expect(standaloneMobile).toContain("height: 100vh");
    expect(standaloneMobile).not.toContain("safe-area-inset-bottom");
  });
});
