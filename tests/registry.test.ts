import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  codemapsHome,
  findEntryByPath,
  loadRegistry,
  removeEntry,
  slugFromDirName,
  upsertEntry,
} from "../src/registry.js";

async function freshHome(): Promise<string> {
  const dir = path.join(os.tmpdir(), `cmreg-${Date.now()}-${Math.random()}`);
  await fs.mkdir(dir, { recursive: true });
  process.env["CODEMAPS_HOME"] = dir;
  return dir;
}

describe("registry CRUD", () => {
  beforeEach(async () => {
    await freshHome();
  });

  it("starts empty and is creatable", async () => {
    const r = await loadRegistry();
    expect(r.version).toBe(1);
    expect(Object.keys(r.entries)).toEqual([]);
  });

  it("upsert + load + remove", async () => {
    await upsertEntry({ slug: "alpha", path: "/tmp/alpha" });
    await upsertEntry({ slug: "beta", path: "/tmp/beta", tech: "Node" });
    const r1 = await loadRegistry();
    expect(Object.keys(r1.entries).sort()).toEqual(["alpha", "beta"]);
    expect(r1.entries["beta"]!.tech).toBe("Node");

    await upsertEntry({ slug: "alpha", path: "/tmp/alpha", purpose: "x" });
    const r2 = await loadRegistry();
    expect(r2.entries["alpha"]!.purpose).toBe("x");
    expect(r2.entries["alpha"]!.path).toBe("/tmp/alpha");

    await removeEntry("alpha");
    const r3 = await loadRegistry();
    expect(Object.keys(r3.entries)).toEqual(["beta"]);
  });

  it("findEntryByPath resolves an exact match and an ancestor", async () => {
    await upsertEntry({ slug: "foo", path: "/Users/sam/work/foo" });
    expect(
      (await findEntryByPath("/Users/sam/work/foo"))?.slug,
    ).toBe("foo");
    expect(
      (await findEntryByPath("/Users/sam/work/foo/src/lib"))?.slug,
    ).toBe("foo");
    expect(await findEntryByPath("/Users/sam/work/other")).toBeUndefined();
  });

  it("findEntryByPath picks the most specific (longest) match", async () => {
    await upsertEntry({ slug: "outer", path: "/Users/sam" });
    await upsertEntry({ slug: "inner", path: "/Users/sam/work/foo" });
    expect(
      (await findEntryByPath("/Users/sam/work/foo/bar"))?.slug,
    ).toBe("inner");
    expect((await findEntryByPath("/Users/sam/other"))?.slug).toBe("outer");
  });

  it("writes a human-readable REGISTRY.md", async () => {
    await upsertEntry({
      slug: "foo",
      path: "/x/foo",
      tech: "Node",
      purpose: "a",
      lastIndexedMs: Date.now(),
      fileCount: 1,
      symbolCount: 2,
    });
    const md = await fs.readFile(
      path.join(codemapsHome(), "REGISTRY.md"),
      "utf8",
    );
    expect(md).toContain("### foo");
    expect(md).toContain("Path: `/x/foo`");
    expect(md).toContain("Tech: Node");
    expect(md).toContain("✓ fresh");
  });

  it("flags stale entries when last commit is newer than last index", async () => {
    const now = Date.now();
    await upsertEntry({
      slug: "foo",
      path: "/x/foo",
      lastIndexedMs: now - 24 * 60 * 60 * 1000,
      lastCommitMs: now,
    });
    const md = await fs.readFile(
      path.join(codemapsHome(), "REGISTRY.md"),
      "utf8",
    );
    expect(md).toContain("⚠ stale");
  });
});

describe("slugFromDirName", () => {
  it("lowercases and de-special-chars", () => {
    expect(slugFromDirName("/x/My-Repo")).toBe("my-repo");
    expect(slugFromDirName("/x/My_Repo.v2")).toBe("my_repo-v2");
    expect(slugFromDirName("/x/  spaces  ")).toBe("spaces");
  });
});
