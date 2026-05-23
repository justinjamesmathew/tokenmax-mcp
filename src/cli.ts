import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  derivePurposeFromPackageJson,
  generateCodemap,
  readConventionsFile,
} from "./codemap.js";
import { buildIndex, refreshFileIfStale } from "./indexer.js";
import {
  codemapPathFor,
  codemapsHome,
  findEntryByPath,
  loadRegistry,
  removeEntry,
  repoStoreDir,
  saveRegistry,
  slugFromDirName,
  upsertEntry,
} from "./registry.js";
import { installGitHook, runInit } from "./setup.js";
import {
  readSymbolIndex,
  searchPersisted,
  writeSymbolIndex,
} from "./symbolIndex.js";
import {
  discoverRepos,
  filterSupportedRepos,
} from "./discover.js";
import type { Registry, RegistryEntry, SymbolKind } from "./types.js";
import {
  isSupportedSourceFile,
  languageForFile,
  safeResolveWithin,
} from "./paths.js";
import { parseFile } from "./parser.js";
import { startServer } from "./server.js";

/**
 * Entry point for the `codemap` CLI. Parses argv, dispatches to a
 * subcommand handler, prints results, sets exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return cmd ? 0 : 1;
  }

  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "register":
        return await cmdRegister(parseFlags(rest));
      case "unregister":
        return await cmdUnregister(rest[0]);
      case "list":
        return await cmdList();
      case "discover":
        return await cmdDiscover(parseFlags(rest));
      case "regen":
        return await cmdRegen(parseFlags(rest));
      case "find":
        return await cmdFind(rest);
      case "read":
        return await cmdRead(rest);
      case "install-git-hook":
        return await cmdInstallGitHook();
      case "mcp":
        await startServer();
        return 0;
      case "where":
        return await cmdWhere();
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        printHelp();
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    if (process.env["CODEMAP_DEBUG"]) {
      process.stderr.write(
        (err instanceof Error && err.stack) || String(err),
      );
      process.stderr.write("\n");
    }
    return 1;
  }
}

// ---------- argv helpers ----------

interface Flags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseFlags(args: string[]): Flags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagString(flags: Flags, name: string): string | undefined {
  const v = flags.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagBool(flags: Flags, name: string): boolean {
  return flags.flags[name] === true || flags.flags[name] === "true";
}

// ---------- commands ----------

async function cmdInit(): Promise<number> {
  const actions = await runInit();
  for (const a of actions) process.stdout.write(a + "\n");
  process.stdout.write("\nNext: run `codemap discover ~/projects` (or wherever your repos live), then `codemap regen --all`.\n");
  return 0;
}

async function cmdRegister(flags: Flags): Promise<number> {
  const target = flags.positional[0]
    ? path.resolve(flags.positional[0])
    : process.cwd();
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    process.stderr.write(`Not a directory: ${target}\n`);
    return 1;
  }
  const slug = flagString(flags, "slug") ?? slugFromDirName(target);
  const derived = await derivePurposeFromPackageJson(target);
  const entry: RegistryEntry = {
    slug,
    path: target,
    purpose: flagString(flags, "purpose") ?? derived.purpose,
    tech: flagString(flags, "tech") ?? derived.tech,
  };
  await upsertEntry(entry);
  process.stdout.write(`Registered ${slug} → ${target}\n`);
  if (!flagBool(flags, "no-regen")) {
    await regenOne(slug);
  }
  return 0;
}

async function cmdUnregister(slug: string | undefined): Promise<number> {
  if (!slug) {
    process.stderr.write("Usage: codemap unregister <slug>\n");
    return 1;
  }
  const reg = await loadRegistry();
  if (!reg.entries[slug]) {
    process.stderr.write(`No such slug: ${slug}\n`);
    return 1;
  }
  await removeEntry(slug);
  process.stdout.write(`Unregistered ${slug}\n`);
  return 0;
}

async function cmdList(): Promise<number> {
  const reg = await loadRegistry();
  const slugs = Object.keys(reg.entries).sort();
  if (slugs.length === 0) {
    process.stdout.write(
      "(no repos registered. Run `codemap register` in a repo's root.)\n",
    );
    return 0;
  }
  for (const slug of slugs) {
    const e = reg.entries[slug]!;
    const tech = e.tech ? ` [${e.tech}]` : "";
    const fresh = formatFreshness(e);
    process.stdout.write(`${slug}${tech} — ${e.path}${fresh}\n`);
    if (e.purpose) process.stdout.write(`    ${e.purpose}\n`);
  }
  return 0;
}

async function cmdDiscover(flags: Flags): Promise<number> {
  const roots = flags.positional.length
    ? flags.positional
    : [process.cwd()];
  process.stdout.write(
    `Scanning ${roots.map((r) => path.resolve(r)).join(", ")}…\n`,
  );
  const candidates = await discoverRepos(roots);
  const supported = await filterSupportedRepos(candidates);
  process.stdout.write(
    `Found ${candidates.length} candidate repo(s); ${supported.length} supported (have package.json).\n`,
  );
  const reg = await loadRegistry();
  const existing = new Set(
    Object.values(reg.entries).map((e) => path.resolve(e.path)),
  );
  const newOnes = supported.filter((p) => !existing.has(path.resolve(p)));
  if (newOnes.length === 0) {
    process.stdout.write("All discovered repos are already registered.\n");
    return 0;
  }
  for (const p of newOnes) {
    const slug = slugFromDirName(p);
    const derived = await derivePurposeFromPackageJson(p);
    await upsertEntry({
      slug,
      path: p,
      purpose: derived.purpose,
      tech: derived.tech,
    });
    process.stdout.write(`+ ${slug} — ${p}\n`);
  }
  process.stdout.write(
    `\nRegistered ${newOnes.length} new repo(s). Next: \`codemap regen --all\`.\n`,
  );
  return 0;
}

async function cmdRegen(flags: Flags): Promise<number> {
  const repoFlag = flagString(flags, "repo");
  const pathFlag = flagString(flags, "path");
  const all = flagBool(flags, "all");
  const reg = await loadRegistry();

  let targets: string[];
  if (all) {
    targets = Object.keys(reg.entries);
  } else if (repoFlag) {
    if (!reg.entries[repoFlag]) {
      process.stderr.write(`No such slug: ${repoFlag}\n`);
      return 1;
    }
    targets = [repoFlag];
  } else if (pathFlag) {
    const entry = await findEntryByPath(path.resolve(pathFlag));
    if (!entry) {
      process.stderr.write(
        `No registered repo contains: ${pathFlag}\nRun \`codemap register\` first.\n`,
      );
      return 1;
    }
    targets = [entry.slug];
  } else {
    // Implicit: try to find a registered repo containing cwd.
    const entry = await findEntryByPath(process.cwd());
    if (!entry) {
      process.stderr.write(
        "No registered repo at this path. Run `codemap register` first, or pass --repo/--path/--all.\n",
      );
      return 1;
    }
    targets = [entry.slug];
  }

  for (const slug of targets) {
    await regenOne(slug);
  }
  return 0;
}

async function regenOne(slug: string): Promise<void> {
  const reg = await loadRegistry();
  const entry = reg.entries[slug];
  if (!entry) throw new Error(`No such slug: ${slug}`);
  const t0 = Date.now();
  process.stdout.write(`→ ${slug}: indexing ${entry.path}…\n`);
  const index = await buildIndex(entry.path);
  const generatedAtMs = Date.now();
  const conventions = await readConventionsFile(entry.path);
  const md = await generateCodemap({
    slug,
    repoRoot: entry.path,
    index,
    purpose: entry.purpose,
    tech: entry.tech,
    consumes: entry.consumes,
    consumedBy: entry.consumedBy,
    conventions,
    generatedAtMs,
  });
  const outPath = codemapPathFor(slug);
  await fs.mkdir(repoStoreDir(slug), { recursive: true });
  await fs.writeFile(outPath, md);
  await writeSymbolIndex(slug, index);
  const lastCommitMs = await readLastCommitMs(entry.path);
  let symbolCount = 0;
  for (const fi of index.files.values()) symbolCount += fi.symbols.length;
  const next: RegistryEntry = {
    ...entry,
    lastIndexedMs: generatedAtMs,
    fileCount: index.files.size,
    symbolCount,
  };
  if (lastCommitMs !== undefined) next.lastCommitMs = lastCommitMs;
  await upsertEntry(next);
  const elapsed = Date.now() - t0;
  process.stdout.write(
    `   wrote ${outPath} (${index.files.size} files, ${symbolCount} symbols, ${elapsed}ms)\n`,
  );
}

async function readLastCommitMs(repoPath: string): Promise<number | undefined> {
  try {
    const out = execSync("git log -1 --format=%ct", {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const sec = Number.parseInt(out, 10);
    if (!Number.isFinite(sec)) return undefined;
    return sec * 1000;
  } catch {
    return undefined;
  }
}

async function cmdFind(rest: string[]): Promise<number> {
  const flags = parseFlags(rest);
  const needle = flags.positional[0];
  if (!needle) {
    process.stderr.write("Usage: codemap find <name> [--repo <slug>] [--kind <kind>]\n");
    return 1;
  }
  const kindFlag = flagString(flags, "kind") as SymbolKind | undefined;
  const repoFlag = flagString(flags, "repo");
  const reg = await loadRegistry();
  const slugs = repoFlag ? [repoFlag] : Object.keys(reg.entries);
  if (repoFlag && !reg.entries[repoFlag]) {
    process.stderr.write(`No such slug: ${repoFlag}\n`);
    return 1;
  }
  if (slugs.length === 0) {
    process.stdout.write("(no repos registered)\n");
    return 0;
  }
  const indexes = (
    await Promise.all(slugs.map((s) => readSymbolIndex(s)))
  ).filter((x): x is NonNullable<typeof x> => x !== undefined);
  if (indexes.length === 0) {
    process.stderr.write(
      "No persisted symbol indexes found. Run `codemap regen --all` first.\n",
    );
    return 1;
  }
  const matches = searchPersisted(indexes, needle, kindFlag);
  if (matches.length === 0) {
    process.stdout.write(
      `No symbols matched "${needle}"${kindFlag ? ` (kind=${kindFlag})` : ""}.\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${matches.length} match${matches.length === 1 ? "" : "es"} for "${needle}"${kindFlag ? ` (kind=${kindFlag})` : ""}:\n`,
  );
  for (const m of matches) {
    process.stdout.write(
      `  [${m.slug}] ${m.symbol.file}:${m.symbol.startLine}  ${m.symbol.kind.padEnd(9)} ${m.symbol.signature}\n`,
    );
  }
  return 0;
}

async function cmdRead(rest: string[]): Promise<number> {
  const flags = parseFlags(rest);
  const file = flags.positional[0];
  const symbol = flags.positional[1];
  if (!file || !symbol) {
    process.stderr.write(
      "Usage: codemap read <file> <symbol> [--repo <slug>]\n",
    );
    return 1;
  }
  const repoFlag = flagString(flags, "repo");
  const reg = await loadRegistry();
  let entry: RegistryEntry | undefined;
  if (repoFlag) {
    entry = reg.entries[repoFlag];
    if (!entry) {
      process.stderr.write(`No such slug: ${repoFlag}\n`);
      return 1;
    }
  } else {
    entry = await findEntryByPath(process.cwd());
    if (!entry) {
      process.stderr.write(
        "Not inside a registered repo. Pass --repo <slug>.\n",
      );
      return 1;
    }
  }
  const repoRoot = entry.path;
  const abs = safeResolveWithin(repoRoot, file);
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  if (!isSupportedSourceFile(rel)) {
    process.stderr.write(`Not a supported source file: ${rel}\n`);
    return 1;
  }
  const stat = await fs.stat(abs);
  const fi = await parseFile(abs, rel, languageForFile(rel), stat.mtimeMs);
  const match = findSymbol(fi.symbols, symbol);
  if (!match) {
    process.stderr.write(`Symbol "${symbol}" not found in ${rel}.\n`);
    return 1;
  }
  if (match === "ambiguous") {
    process.stderr.write(
      `Symbol "${symbol}" is ambiguous in ${rel}. Use dotted form (e.g. Class.${symbol}).\n`,
    );
    return 1;
  }
  const source = await fs.readFile(abs, "utf8");
  const lines = source.split(/\r?\n/);
  process.stdout.write(`// ${entry.slug}/${rel}  (${match.qualifiedName})\n`);
  if (fi.importBlockEndLine > 0) {
    for (let i = 0; i < fi.importBlockEndLine; i++) {
      process.stdout.write(formatLine(i + 1, lines[i] ?? "") + "\n");
    }
    process.stdout.write("\n");
  }
  for (let i = match.startLine; i <= match.endLine; i++) {
    process.stdout.write(formatLine(i, lines[i - 1] ?? "") + "\n");
  }
  // Touch refresh check so a future MCP call sees the same mtime (for future
  // extension where read may share an in-process index — no-op here).
  void refreshFileIfStale;
  return 0;
}

function findSymbol(
  symbols: Array<{ qualifiedName: string; name: string; startLine: number; endLine: number; kind: string }>,
  query: string,
): typeof symbols[number] | "ambiguous" | undefined {
  const dotted = symbols.filter((s) => s.qualifiedName === query);
  if (dotted.length === 1) return dotted[0];
  if (dotted.length > 1) return "ambiguous";
  const byName = symbols.filter((s) => s.name === query);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return "ambiguous";
  const lower = query.toLowerCase();
  const ci = symbols.filter(
    (s) =>
      s.name.toLowerCase() === lower ||
      s.qualifiedName.toLowerCase() === lower,
  );
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) return "ambiguous";
  return undefined;
}

function formatLine(n: number, content: string): string {
  return `${String(n).padStart(5)}: ${content}`;
}

async function cmdInstallGitHook(): Promise<number> {
  const actions = await installGitHook();
  for (const a of actions) process.stdout.write(a + "\n");
  return 0;
}

async function cmdWhere(): Promise<number> {
  const entry = await findEntryByPath(process.cwd());
  if (!entry) {
    process.stdout.write("(not inside a registered repo)\n");
    return 1;
  }
  process.stdout.write(`${entry.slug} → ${entry.path}\n`);
  process.stdout.write(`codemap: ${codemapPathFor(entry.slug)}\n`);
  return 0;
}

function formatFreshness(e: RegistryEntry): string {
  if (!e.lastIndexedMs) return "  (never indexed)";
  if (e.lastCommitMs && e.lastCommitMs > e.lastIndexedMs) {
    return "  ⚠ stale";
  }
  return "  ✓ fresh";
}

function printHelp(): void {
  process.stdout.write(`
codemap — symbol-level navigation for your repos

Usage:
  codemap init                        Scaffold ~/.codemaps and wire ~/.claude/CLAUDE.md
  codemap register [path]             Register a repo (defaults to cwd)
                                        --slug <slug>  override default slug
                                        --purpose "..."  override purpose
                                        --tech "..."     override tech stack
                                        --no-regen       skip codemap regen
  codemap unregister <slug>           Remove a repo from the registry
  codemap list                        List registered repos
  codemap discover [root...]          Walk dirs, bulk-register any repos found
  codemap regen [--repo <slug>] [--path <p>] [--all]
                                      Regenerate codemap(s)
  codemap find <name> [--repo <slug>] [--kind <kind>]
                                      Cross-repo symbol search
  codemap read <file> <symbol> [--repo <slug>]
                                      Read one symbol's source
  codemap where                       Show which registered repo (if any) you're in
  codemap install-git-hook            Install post-commit hook for auto-regen
  codemap mcp                         Start the MCP server (cross-repo aware)
  codemap help                        Show this help

Storage:
  ~/.codemaps/registry.json    machine-readable registry
  ~/.codemaps/REGISTRY.md      human/Claude-readable registry (loaded into context)
  ~/.codemaps/<slug>/CODEMAP.md  per-repo codemap
  ~/.codemaps/<slug>/symbols.json  per-repo flat symbol index (for fast find)
`);
}
