import { describe, expect, it } from "vitest";

import { detectSidebarSwipe } from "../src/client/use-sidebar-swipe.js";

describe("mobile sidebar swipe", () => {
  it("recognizes horizontal swipes in either direction", () => {
    expect(detectSidebarSwipe(80, 10)).toBe("right");
    expect(detectSidebarSwipe(-80, -10)).toBe("left");
  });

  it("ignores short or mostly vertical movement", () => {
    expect(detectSidebarSwipe(40, 0)).toBeUndefined();
    expect(detectSidebarSwipe(60, 55)).toBeUndefined();
    expect(detectSidebarSwipe(0, 80)).toBeUndefined();
  });
});
