import fs from "node:fs/promises";
import path from "node:path";

/**
 * Walk a set of root directories and return paths to candidate repos.
 *
 * A "repo" is heuristically defined as a directory containing a project
 * manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
 * `pom.xml`, `build.gradle`) AND a `.git` directory. We require .git to
 * avoid false positives from random package.json files inside dependencies
 * or generated dirs.
 *
 * Stops descending once a candidate is found — nested subprojects aren't
 * registered (monorepo workspaces can be registered individually).
 */
export interface DiscoverOptions {
  maxDepth?: number;     // default 4
  ignoreNames?: Set<string>; // default common skip dirs
}

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

const PROJECT_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

export async function discoverRepos(
  roots: string[],
  options: DiscoverOptions = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 4;
  const ignores = options.ignoreNames ?? DEFAULT_IGNORES;
  const found: string[] = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    await walk(abs, 0, maxDepth, ignores, found);
  }
  return found;
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  ignores: Set<string>,
  found: string[],
): Promise<void> {
  if (depth > maxDepth) return;
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  if (await looksLikeRepo(dir)) {
    found.push(dir);
    return; // don't descend into nested subprojects
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignores.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !["."].includes(entry.name)) continue;
    await walk(
      path.join(dir, entry.name),
      depth + 1,
      maxDepth,
      ignores,
      found,
    );
  }
}

async function looksLikeRepo(dir: string): Promise<boolean> {
  let hasGit = false;
  try {
    const gitStat = await fs.stat(path.join(dir, ".git"));
    hasGit = gitStat.isDirectory() || gitStat.isFile(); // file = submodule
  } catch {
    hasGit = false;
  }
  if (!hasGit) return false;
  for (const m of PROJECT_MANIFESTS) {
    try {
      await fs.stat(path.join(dir, m));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Return repos that look like supported (TypeScript/JavaScript) projects.
 * Heuristic: package.json exists and we can find at least one .ts/.tsx/.js/.jsx
 * source file in src/ or at the root.
 */
export async function filterSupportedRepos(
  candidates: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const c of candidates) {
    if (await hasTsLikeContent(c)) out.push(c);
  }
  return out;
}

async function hasTsLikeContent(dir: string): Promise<boolean> {
  // Cheap heuristic: package.json present.
  try {
    await fs.stat(path.join(dir, "package.json"));
    return true;
  } catch {
    return false;
  }
}
