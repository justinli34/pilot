export type CssPixelToken = `--${string}`;

export function readCssPixelToken(name: CssPixelToken): number {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!raw.endsWith("px") || !Number.isFinite(value)) {
    throw new Error(`Design token ${name} must resolve to a pixel value`);
  }
  return value;
}

export function readCssFlag(name: `--${string}`): boolean {
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() === "1";
}
