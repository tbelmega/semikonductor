// SPDX-License-Identifier: Apache-2.0
// Mechanical checks of Komposer's UI rules, as AGENTS.md states them: one
// tooltip, icons from lucide-react rather than emoji, and colours from the
// theme's tokens. Each reads the app's source files.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isIntrinsic, jsxAttributes } from "./jsxAttributes.ts";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string, ext: RegExp): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path, ext);
    return ext.test(entry.name) ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

const where = (path: string, text: string, offset: number) =>
  `${relative(SRC, path)}:${text.slice(0, offset).split("\n").length}`;

const titleAttributes = (text: string, file?: string) =>
  jsxAttributes(text, file).filter((a) => a.name === "title" && isIntrinsic(a.tag));

describe("the tooltip rule", () => {
  test("no element uses the browser's title tooltip; tips are data-tip, drawn by Tooltip.tsx", () => {
    const found = sources(SRC, /\.tsx$/).flatMap(({ path, text }) =>
      titleAttributes(text, path).map((a) => `${where(path, text, a.offset)} <${a.tag} title>`),
    );
    expect(found).toEqual([]);
  });

  test("the check finds a title on an element, also in a spread, and not a component's prop or a comment", () => {
    const text = [
      `const a = <span className="x" title="tip">a</span>;`,
      `const b = <input onChange={(e) => e.target.value.replace(/}/g, "")}`,
      `  title={x} />;`,
      `const c = <span {...(on ? { title: x, role: "img" } : { "aria-hidden": true })} />;`,
      `const d = <Section title="Basics" />;`,
      `// <button title="in a comment">`,
      `const e = "<button title='in a string'>";`,
    ].join("\n");
    expect(titleAttributes(text).map((a) => [a.tag, a.line])).toEqual([
      ["span", 1],
      ["input", 3],
      ["span", 4],
    ]);
  });
});

describe("the icon rule", () => {
  // Characters drawn as emoji by default, and the selector that turns a
  // text symbol into an emoji. Text symbols such as ← and ✓ are fine.
  const EMOJI = /\p{Emoji_Presentation}|\uFE0F/gu;

  test("no source file uses an emoji; icons come from lucide-react", () => {
    const found = sources(SRC, /\.tsx?$/).flatMap(({ path, text }) =>
      [...text.matchAll(EMOJI)].map((m) => `${where(path, text, m.index)} ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  test("the check finds an emoji and passes a text arrow", () => {
    expect("👤 ⏩ ⚙\uFE0F".match(EMOJI)).toHaveLength(3);
    expect("← ↩ ✓ ~".match(EMOJI)).toBeNull();
  });
});

describe("the colour rule", () => {
  // A hex colour or a colour function, written in a script instead of a
  // theme token in the CSS.
  const COLOUR = /(?<![\w&$])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/g;

  test("no script hard-codes a colour; colours are theme tokens", () => {
    const found = sources(SRC, /\.tsx?$/).flatMap(({ path, text }) =>
      [...text.matchAll(COLOUR)].map((m) => `${where(path, text, m.index)} ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  test("the check finds hex and function colours and passes tokens and anchors", () => {
    expect(`color: "#fff"; bg: "#1a2b3c"; c: rgb(1,2,3); d: oklch(0.5 0.1 80)`.match(COLOUR)).toHaveLength(4);
    expect(`color: "var(--accent)"; href: "#token=abc"; id: "#step-3"`.match(COLOUR)).toBeNull();
  });
});
