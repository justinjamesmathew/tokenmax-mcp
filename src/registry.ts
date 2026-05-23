import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { Registry, RegistryEntry } from "./types.js";

export function codemapsHome(): string {
  // Allow override via env var for tests / non-standard setups.
  const override = process.env["CODEMAPS_HOME"];
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".codemaps");
}

export function registryJsonPath(): string {
  return path.join(codemapsHome(), "registry.json");
}

export function registryMarkdownPath(): string {
  return path.join(codemapsHome(), "REGISTRY.md");
}

export function repoStoreDir(slug: string): string {
  return path.join(codemapsHome(), slug);
}

export function codemapPathFor(slug: string): string {
  return path.join(repoStoreDir(slug), "CODEMAP.md");
}

export function symbolIndexPathFor(slug: string): string {
  return path.join(repoStoreDir(slug), "symbols.json");
}

export async function ensureHome(): Promise<void> {
  await fs.mkdir(codemapsHome(), { recursive: true });
}

export async function loadRegistry(): Promise<Registry> {
  await ensureHome();
  try {
    const raw = await fs.readFile(registryJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (parsed.version !== 1 || !parsed.entries) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, entries: {} };
    }
    throw err;
  }
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await ensureHome();
  await fs.writeFile(
    registryJsonPath(),
    JSON.stringify(reg, null, 2) + "\n",
  );
  await writeRegistryMarkdown(reg);
}

/**
 * Add or update an entry by slug. If the slug already exists with a different
 * path, the existing entry is replaced (latest registration wins).
 */
export async function upsertEntry(entry: RegistryEntry): Promise<Registry> {
  const reg = await loadRegistry();
  reg.entries[entry.slug] = {
    ...reg.entries[entry.slug],
    ...entry,
  };
  await saveRegistry(reg);
  return reg;
}

export async function removeEntry(slug: string): Promise<Registry> {
  const reg = await loadRegistry();
  delete reg.entries[slug];
  await saveRegistry(reg);
  return reg;
}

/**
 * Look up a registry entry by absolute path. Walks ancestors so that calling
 * this from a subdirectory of a registered repo still resolves to its entry.
 */
export async function findEntryByPath(
  absPath: string,
): Promise<RegistryEntry | undefined> {
  const reg = await loadRegistry();
  const target = path.resolve(absPath);
  let best: RegistryEntry | undefined;
  let bestLen = -1;
  for (const e of Object.values(reg.entries)) {
    const root = path.resolve(e.path);
    if (target === root || target.startsWith(root + path.sep)) {
      if (root.length > bestLen) {
        best = e;
        bestLen = root.length;
      }
    }
  }
  return best;
}

export function slugFromDirName(dir: string): string {
  const base = path.basename(path.resolve(dir));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Render the human-readable REGISTRY.md from the JSON registry. This is the
 * file Claude reads (via @-reference from ~/.claude/CLAUDE.md).
 */
async function writeRegistryMarkdown(reg: Registry): Promise<void> {
  const lines: string[] = [];
  lines.push("# Codemap Registry");
  lines.push("");
  lines.push(
    "Index of all repos registered with codemap. Auto-loaded into every Claude Code session via `~/.claude/CLAUDE.md`.",
  );
  lines.push("");
  lines.push(
    "When working with code from a specific repo, load its CODEMAP via the Read tool. For cross-repo symbol lookups, run:",
  );
  lines.push("");
  lines.push("```bash");
  lines.push("codemap find <name>              # search every repo");
  lines.push("codemap find <name> --repo <slug>  # scope to one repo");
  lines.push("codemap read <file> <symbol> --repo <slug>");
  lines.push("```");
  lines.push("");
  lines.push("## Repos");
  lines.push("");

  const slugs = Object.keys(reg.entries).sort();
  if (slugs.length === 0) {
    lines.push(
      "_(no repos registered. Run `codemap register` in a repo's root.)_",
    );
  } else {
    for (const slug of slugs) {
      const e = reg.entries[slug]!;
      lines.push(`### ${slug}`);
      lines.push(`- Path: \`${e.path}\``);
      lines.push(`- Codemap: \`${codemapPathFor(slug)}\``);
      if (e.tech) lines.push(`- Tech: ${e.tech}`);
      if (e.purpose) {
        const oneLine = e.purpose.replace(/\s+/g, " ").trim();
        lines.push(`- Purpose: ${oneLine}`);
      }
      if (e.consumes && e.consumes.length) {
        lines.push(`- Consumes: ${e.consumes.join(", ")}`);
      }
      if (e.consumedBy && e.consumedBy.length) {
        lines.push(`- Consumed by: ${e.consumedBy.join(", ")}`);
      }
      const staleness = formatStaleness(e);
      if (staleness) lines.push(`- Index: ${staleness}`);
      if (e.fileCount !== undefined && e.symbolCount !== undefined) {
        lines.push(
          `- Stats: ${e.fileCount} files, ${e.symbolCount} symbols`,
        );
      }
      lines.push("");
    }
  }

  await fs.writeFile(registryMarkdownPath(), lines.join("\n"));
}

function formatStaleness(e: RegistryEntry): string | undefined {
  if (!e.lastIndexedMs) return undefined;
  const indexed = new Date(e.lastIndexedMs).toISOString().slice(0, 10);
  if (e.lastCommitMs && e.lastCommitMs > e.lastIndexedMs) {
    const drift = Math.round(
      (e.lastCommitMs - e.lastIndexedMs) / (1000 * 60 * 60),
    );
    return `last indexed ${indexed} ⚠ stale (${drift}h behind last commit)`;
  }
  return `last indexed ${indexed} ✓ fresh`;
}
