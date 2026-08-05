import { describe, expect, it } from "vitest";

import { shouldCloseMenuOnBlur } from "../src/client/menu-keyboard.js";

const inside = {} as Node;
const outside = {} as Node;
const container: Pick<Node, "contains"> = {
  contains: (target) => target === inside,
};

describe("menu blur handling", () => {
  it("does not close when a touch browser omits the next focus target", () => {
    expect(shouldCloseMenuOnBlur(container, null)).toBe(false);
  });

  it("only closes when focus moves outside the menu actions", () => {
    expect(shouldCloseMenuOnBlur(container, inside)).toBe(false);
    expect(shouldCloseMenuOnBlur(container, outside)).toBe(true);
  });
});
