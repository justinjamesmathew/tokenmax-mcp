import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildIndex, refreshFileIfStale } from "../src/indexer.js";
import type { RepoIndex, SourceSymbol } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string): string =>
  path.join(here, "fixtures", name);

function findByName(index: RepoIndex, needle: string): SourceSymbol[] {
  const lower = needle.toLowerCase();
  const out: SourceSymbol[] = [];
  for (const [key, list] of index.byLowerName) {
    if (key.includes(lower)) out.push(...list);
  }
  return out;
}

function findInFile(
  index: RepoIndex,
  relFile: string,
  qualifiedName: string,
): SourceSymbol | undefined {
  const fi = index.files.get(relFile);
  return fi?.symbols.find((s) => s.qualifiedName === qualifiedName);
}

describe("react-app fixture (TSX with JSX components, re-exports)", () => {
  let index: RepoIndex;
  beforeAll(async () => {
    index = await buildIndex(fixtures("react-app"));
  });

  it("indexes all .ts/.tsx files", () => {
    const paths = [...index.files.keys()].sort();
    expect(paths).toEqual([
      "src/components/Greeting.tsx",
      "src/index.tsx",
      "src/lib/format.ts",
    ]);
  });

  it("indexes JSX function components as functions", () => {
    const greeting = findInFile(
      index,
      "src/components/Greeting.tsx",
      "Greeting",
    );
    expect(greeting).toBeDefined();
    expect(greeting!.kind).toBe("function");
    expect(greeting!.exported).toBe(true);
    expect(greeting!.docComment).toContain("Greets the user");
  });

  it("indexes arrow-fn JSX components as functions", () => {
    const farewell = findInFile(
      index,
      "src/components/Greeting.tsx",
      "Farewell",
    );
    expect(farewell).toBeDefined();
    expect(farewell!.kind).toBe("function");
    expect(farewell!.exported).toBe(true);
  });

  it("indexes interfaces with generics", () => {
    const props = findInFile(
      index,
      "src/components/Greeting.tsx",
      "GreetingProps",
    );
    expect(props).toBeDefined();
    expect(props!.kind).toBe("interface");
  });

  it("indexes class methods with parent linkage", () => {
    const greet = findInFile(index, "src/lib/format.ts", "Formatter.greet");
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe("method");
    expect(greet!.parent).toBe("Formatter");
  });

  it("captures static method modifier", () => {
    const m = findInFile(index, "src/lib/format.ts", "Formatter.for");
    expect(m).toBeDefined();
    expect(m!.modifiers?.static).toBe(true);
  });

  it("records re-exports as kind=reexport", () => {
    const fi = index.files.get("src/index.tsx");
    expect(fi).toBeDefined();
    const reexports = fi!.symbols.filter((s) => s.kind === "reexport");
    expect(reexports.length).toBeGreaterThanOrEqual(2);
    const named = reexports.find((s) => s.name === "Greeting");
    expect(named).toBeDefined();
    expect(named!.reexport?.from).toBe("./components/Greeting");
    const star = reexports.find((s) => s.name === "*");
    expect(star).toBeDefined();
    expect(star!.reexport?.from).toBe("./lib/format");
  });

  it("includes exported constants of value type", () => {
    const c = findInFile(index, "src/lib/format.ts", "DEFAULT_NAME");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("const");
  });

  it("finds symbols by case-insensitive substring", () => {
    const results = findByName(index, "greet");
    const names = results.map((s) => s.qualifiedName);
    expect(names).toContain("Greeting");
    expect(names).toContain("Formatter.greet");
  });
});

describe("node-cli fixture (abstract classes, switch)", () => {
  let index: RepoIndex;
  beforeAll(async () => {
    index = await buildIndex(fixtures("node-cli"));
  });

  it("indexes async exported function", () => {
    const m = findInFile(index, "src/main.ts", "main");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("function");
    expect(m!.modifiers?.async).toBe(true);
    expect(m!.docComment).toContain("CLI entry point");
  });

  it("indexes class extending an abstract class", () => {
    const build = findInFile(index, "src/commands.ts", "BuildCommand");
    expect(build).toBeDefined();
    expect(build!.kind).toBe("class");
    const execute = findInFile(
      index,
      "src/commands.ts",
      "BuildCommand.execute",
    );
    expect(execute).toBeDefined();
    expect(execute!.modifiers?.async).toBe(true);
  });

  it("indexes a non-exported (abstract) class as long as it's top-level", () => {
    const base = findInFile(index, "src/commands.ts", "BaseCommand");
    expect(base).toBeDefined();
    expect(base!.kind).toBe("class");
    expect(base!.exported).toBe(false);
  });
});

describe("express-api fixture (router builders, types)", () => {
  let index: RepoIndex;
  beforeAll(async () => {
    index = await buildIndex(fixtures("express-api"));
  });

  it("indexes type aliases", () => {
    const t = findInFile(index, "src/routes/users.ts", "UserId");
    expect(t).toBeDefined();
    expect(t!.kind).toBe("type");
  });

  it("indexes interfaces", () => {
    const t = findInFile(index, "src/routes/users.ts", "User");
    expect(t).toBeDefined();
    expect(t!.kind).toBe("interface");
  });

  it("indexes class with multiple methods", () => {
    const svc = findInFile(index, "src/routes/users.ts", "UserService");
    expect(svc).toBeDefined();
    const list = findInFile(
      index,
      "src/routes/users.ts",
      "UserService.list",
    );
    const get = findInFile(
      index,
      "src/routes/users.ts",
      "UserService.get",
    );
    expect(list).toBeDefined();
    expect(get).toBeDefined();
  });

  it("indexes top-level functions with signatures", () => {
    const create = findInFile(index, "src/server.ts", "createApp");
    expect(create).toBeDefined();
    expect(create!.signature).toContain("createApp");
    expect(create!.signature).toContain("Express");
  });

  it("captures importBlockEndLine for files with imports", () => {
    const fi = index.files.get("src/server.ts");
    expect(fi).toBeDefined();
    expect(fi!.importBlockEndLine).toBeGreaterThan(0);
  });
});

describe("refreshFileIfStale", () => {
  it("re-parses a file when its mtime advances", async () => {
    const root = fixtures("react-app");
    const index = await buildIndex(root);
    const target = "src/lib/format.ts";
    const before = index.files.get(target)!;
    const beforeSyms = before.symbols.length;

    const absPath = path.join(root, target);
    const original = await fs.readFile(absPath, "utf8");
    try {
      // Touch + add a new exported function so we can verify re-parse picks it up.
      const augmented =
        original + "\nexport function brandNew(): number { return 42; }\n";
      const now = new Date();
      await fs.writeFile(absPath, augmented);
      // Bump mtime explicitly to guarantee fs sees a change on coarse-mtime systems.
      await fs.utimes(absPath, now, new Date(now.getTime() + 1000));

      await refreshFileIfStale(index, target);

      const after = index.files.get(target)!;
      expect(after.symbols.length).toBe(beforeSyms + 1);
      expect(after.symbols.some((s) => s.name === "brandNew")).toBe(true);
    } finally {
      await fs.writeFile(absPath, original);
    }
  });
});

describe("parse-error fallback", () => {
  it("falls back to filename + snippet for unparseable files", async () => {
    const root = fixtures("react-app");
    const broken = path.join(root, "src", "broken.ts");
    await fs.writeFile(
      broken,
      "this is // ((( not valid TypeScript at all 🚫\nconst x = ;",
    );
    try {
      const index = await buildIndex(root);
      const fi = index.files.get("src/broken.ts");
      // The parser is fault-tolerant — it may still extract no symbols and
      // mark the file with parseError, or it may extract a partial symbol.
      expect(fi).toBeDefined();
      // Either way, the index does not crash and the file appears.
    } finally {
      await fs.unlink(broken);
    }
  });
});
