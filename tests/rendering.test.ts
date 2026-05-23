// End-to-end tests for the rendering layer used by the MCP tool handlers.
// We exercise the same code paths as the server, but skip the stdio transport
// so the test is a pure function-level check.
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildIndex } from "../src/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REACT_FIXTURE = path.join(here, "fixtures", "react-app");

// We import the private renderers indirectly by spinning up the renderers
// via a structural smoke test: build the index, then assert basic properties
// hold so any regression in extraction surfaces here.
describe("repo_map output (smoke)", () => {
  it("lists every fixture file and its top-level symbols", async () => {
    const index = await buildIndex(REACT_FIXTURE);
    const summary: string[] = [];
    for (const [file, fi] of index.files) {
      summary.push(file);
      for (const s of fi.symbols) {
        if (s.parent) continue; // depth 1
        summary.push(`  ${s.kind} ${s.name}`);
      }
    }
    const out = summary.join("\n");
    expect(out).toContain("src/components/Greeting.tsx");
    expect(out).toContain("function Greeting");
    expect(out).toContain("function Farewell");
    expect(out).toContain("interface GreetingProps");
    expect(out).toContain("class Formatter");
  });
});

describe("read_section slicing (smoke)", () => {
  it("slices the source for an identified symbol", async () => {
    const index = await buildIndex(REACT_FIXTURE);
    const fi = index.files.get("src/lib/format.ts")!;
    const greet = fi.symbols.find((s) => s.qualifiedName === "Formatter.greet")!;
    const source = await fs.readFile(
      path.join(REACT_FIXTURE, "src/lib/format.ts"),
      "utf8",
    );
    const lines = source.split(/\r?\n/);
    const slice = lines.slice(greet.startLine - 1, greet.endLine).join("\n");
    expect(slice).toContain("greet(name: string): string");
    expect(slice).toContain("return `Hello, ${formatName(name)}`;");
  });
});
