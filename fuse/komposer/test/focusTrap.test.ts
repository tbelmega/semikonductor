// SPDX-License-Identifier: Apache-2.0
// Tab and Shift+Tab stay inside a modal dialog.

import { describe, expect, test } from "bun:test";
import { tabTarget } from "../src/focusTrap.ts";

const controls = ["close", "text", "done"];

describe("tabTarget", () => {
  test("Tab from the last control wraps to the first, Shift+Tab from the first to the last", () => {
    expect(tabTarget(controls, "done", false)).toBe("close");
    expect(tabTarget(controls, "close", true)).toBe("done");
  });

  test("between controls the browser moves focus itself", () => {
    expect(tabTarget(controls, "close", false)).toBeNull();
    expect(tabTarget(controls, "text", false)).toBeNull();
    expect(tabTarget(controls, "text", true)).toBeNull();
    expect(tabTarget(controls, "done", true)).toBeNull();
  });

  test("from outside the controls, Tab enters at the first and Shift+Tab at the last", () => {
    expect(tabTarget(controls, null, false)).toBe("close");
    expect(tabTarget(controls, "body", false)).toBe("close");
    expect(tabTarget(controls, "body", true)).toBe("done");
  });

  test("a single control keeps focus, and no controls leave Tab to the browser", () => {
    expect(tabTarget(["done"], "done", false)).toBe("done");
    expect(tabTarget(["done"], "done", true)).toBe("done");
    expect(tabTarget([], "body", false)).toBeNull();
  });
});
