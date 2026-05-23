import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { discoverRepos } from "../src/discover.js";

async function makeTree(
  spec: Record<string, "git+pkg" | "pkg" | "git" | "empty">,
): Promise<string> {
  const root = path.join(os.tmpdir(), `disc-${Date.now()}-${Math.random()}`);
  await fs.mkdir(root, { recursive: true });
  for (const [rel, kind] of Object.entries(spec)) {
    const d = path.join(root, rel);
    await fs.mkdir(d, { recursive: true });
    if (kind === "git+pkg" || kind === "pkg") {
      await fs.writeFile(
        path.join(d, "package.json"),
        JSON.stringify({ name: path.basename(rel) }),
      );
    }
    if (kind === "git+pkg" || kind === "git") {
      await fs.mkdir(path.join(d, ".git"), { recursive: true });
    }
  }
  return root;
}

describe("discoverRepos", () => {
  it("finds dirs with package.json + .git, skips empties and bare packages", async () => {
    const root = await makeTree({
      a: "git+pkg",       // ✓
      b: "pkg",           // ✗ (no .git)
      c: "git",           // ✗ (no manifest)
      d: "empty",         // ✗
      "nested/e": "git+pkg",
    });
    const found = await discoverRepos([root]);
    const rels = found.map((p) => path.relative(root, p)).sort();
    expect(rels).toEqual(["a", "nested/e"]);
  });

  it("does not descend into matched repos (nested workspaces stay hidden)", async () => {
    const root = await makeTree({
      monorepo: "git+pkg",
      "monorepo/packages/x": "pkg",
      "monorepo/packages/y": "pkg",
    });
    const found = await discoverRepos([root]);
    const rels = found.map((p) => path.relative(root, p)).sort();
    expect(rels).toEqual(["monorepo"]);
  });

  it("respects ignore list", async () => {
    const root = await makeTree({
      good: "git+pkg",
      "node_modules/bad": "git+pkg",
    });
    const found = await discoverRepos([root]);
    const rels = found.map((p) => path.relative(root, p)).sort();
    expect(rels).toEqual(["good"]);
  });
});
