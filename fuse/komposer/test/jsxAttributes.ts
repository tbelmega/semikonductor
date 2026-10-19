// SPDX-License-Identifier: Apache-2.0
// The attributes written on JSX elements in TSX source, read from the syntax
// tree that rolldown's parser (Oxc) builds; TypeScript 7 ships no compiler
// API to parse with. A spread of an object written in place counts its keys
// as attributes, through a condition or a logical operator too, as in
// {...(on ? { title: a } : {})}.

import { parseAst } from "rolldown/parseAst";

export type JsxAttribute = { tag: string; name: string; offset: number; line: number };

type Node = { type: string; start: number; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function tagName(name: Node): string {
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXMemberExpression") return `${tagName(name.object as Node)}.${(name.property as Node).name as string}`;
  if (name.type === "JSXNamespacedName") return `${(name.namespace as Node).name as string}:${(name.name as Node).name as string}`;
  return "";
}

// The keys of the objects a spread can produce, with where each is written.
function spreadKeys(node: Node): { name: string; start: number }[] {
  if (node.type === "ObjectExpression")
    return (node.properties as Node[]).flatMap((p) => {
      if (p.type === "SpreadElement") return spreadKeys(p.argument as Node);
      const key = p.key as Node | undefined;
      if (!key || p.computed) return [];
      const name = key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String(key.value) : "";
      return name ? [{ name, start: key.start }] : [];
    });
  if (node.type === "ConditionalExpression") return [...spreadKeys(node.consequent as Node), ...spreadKeys(node.alternate as Node)];
  if (node.type === "LogicalExpression") return [...spreadKeys(node.left as Node), ...spreadKeys(node.right as Node)];
  if (node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
    return spreadKeys(node.expression as Node);
  return [];
}

export function jsxAttributes(source: string, file = "source.tsx"): JsxAttribute[] {
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const found: JsxAttribute[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isNode(node)) return;
    if (node.type === "JSXOpeningElement") {
      const tag = tagName(node.name as Node);
      for (const attr of node.attributes as Node[]) {
        if (attr.type === "JSXAttribute") {
          const name = attr.name as Node;
          const text = name.type === "JSXNamespacedName" ? tagName(name) : (name.name as string);
          found.push({ tag, name: text, offset: attr.start, line: lineAt(attr.start) });
        } else if (attr.type === "JSXSpreadAttribute") {
          for (const key of spreadKeys(attr.argument as Node)) found.push({ tag, name: key.name, offset: key.start, line: lineAt(key.start) });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== "type" && typeof value === "object") walk(value);
  };
  walk(parseAst(source, { lang: "tsx" }, file));
  return found;
}

// An intrinsic element, such as span or button, as opposed to a component.
export const isIntrinsic = (tag: string) => /^[a-z]/.test(tag);
