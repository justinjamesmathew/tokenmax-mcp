// Smoke-test the parser against representative TS/TSX snippets.
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFile, initParser } from "../dist-probe/parser.js";

const samples = [
  ["a.ts", `
/**
 * Greets a name.
 */
export function greet(name: string): string {
  return "hi " + name;
}

export const add = (a: number, b: number): number => a + b;

export class Server {
  private port: number;
  constructor(port: number) { this.port = port; }
  /** Start the server. */
  async start(): Promise<void> {}
  static create(port: number): Server { return new Server(port); }
  get info(): string { return ""; }
}

export interface Options<T> { value: T; }
export type Pair<A, B> = { a: A; b: B };
export enum Color { Red, Green }

export const VERSION = "1.0.0";

export { foo, bar as baz } from "./other";
export * from "./more";

export default function() {}
`],
  ["b.tsx", `
import React from "react";

export function Greeting(props: { name: string }) {
  return <div>Hello, {props.name}!</div>;
}

export const Bye = (p: { n: string }) => <span>Bye {p.n}</span>;
`],
  ["c.ts", `
abstract class Base {
  abstract foo(): void;
}
`],
];

const dir = await mkdtemp(join(tmpdir(), "rcmcp-"));
await initParser();
for (const [name, src] of samples) {
  const p = join(dir, name);
  await writeFile(p, src);
  const idx = await parseFile(p, name, name.endsWith("tsx") ? "tsx" : "typescript", Date.now());
  console.log(`=== ${name} ===`);
  console.log(`importBlockEndLine: ${idx.importBlockEndLine}`);
  if (idx.parseError) console.log(`PARSE ERROR: ${idx.parseError}`);
  for (const s of idx.symbols) {
    const parent = s.parent ? `[${s.parent}]` : "";
    const mods = s.modifiers ? Object.keys(s.modifiers).join(",") : "";
    console.log(`  ${s.kind.padEnd(9)} ${s.qualifiedName.padEnd(22)} L${s.startLine}-${s.endLine}  ${mods.padEnd(20)} ${s.signature}`);
    if (s.docComment) console.log(`    doc: ${s.docComment}`);
  }
}
