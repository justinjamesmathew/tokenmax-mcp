import fs from "node:fs/promises";

import type {
  PersistedSymbol,
  PersistedSymbolIndex,
  RepoIndex,
  SourceSymbol,
  SymbolKind,
} from "./types.js";
import { symbolIndexPathFor } from "./registry.js";

/**
 * Persist a flat, JSON-serialisable per-repo symbol index. Used by the CLI's
 * cross-repo `find` so each invocation can load N small JSONs in parallel
 * instead of re-parsing N repos from source.
 */
export async function writeSymbolIndex(
  slug: string,
  index: RepoIndex,
): Promise<string> {
  const symbols: PersistedSymbol[] = [];
  for (const fi of index.files.values()) {
    for (const sym of fi.symbols) {
      // Skip re-exports from the persisted index — they're file-scoped
      // navigation hints, not searchable definitions.
      if (sym.kind === "reexport") continue;
      symbols.push(toPersisted(sym));
    }
  }
  const payload: PersistedSymbolIndex = {
    slug,
    generatedAtMs: Date.now(),
    symbols,
  };
  const out = symbolIndexPathFor(slug);
  await fs.mkdir(out.replace(/\/[^/]+$/, ""), { recursive: true });
  await fs.writeFile(out, JSON.stringify(payload) + "\n");
  return out;
}

export async function readSymbolIndex(
  slug: string,
): Promise<PersistedSymbolIndex | undefined> {
  try {
    const raw = await fs.readFile(symbolIndexPathFor(slug), "utf8");
    return JSON.parse(raw) as PersistedSymbolIndex;
  } catch {
    return undefined;
  }
}

function toPersisted(s: SourceSymbol): PersistedSymbol {
  const out: PersistedSymbol = {
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    file: s.file,
    startLine: s.startLine,
    endLine: s.endLine,
    signature: s.signature,
    exported: s.exported,
  };
  if (s.parent !== undefined) out.parent = s.parent;
  return out;
}

export interface CrossRepoMatch {
  slug: string;
  symbol: PersistedSymbol;
}

/**
 * Substring match across loaded indexes, optionally filtered by kind.
 */
export function searchPersisted(
  indexes: PersistedSymbolIndex[],
  needle: string,
  kind?: SymbolKind | "method",
): CrossRepoMatch[] {
  const lower = needle.toLowerCase();
  const matches: CrossRepoMatch[] = [];
  for (const idx of indexes) {
    for (const s of idx.symbols) {
      if (!s.name.toLowerCase().includes(lower)) continue;
      if (kind && !kindMatches(s.kind, kind)) continue;
      matches.push({ slug: idx.slug, symbol: s });
    }
  }
  matches.sort(
    (a, b) =>
      a.slug.localeCompare(b.slug) ||
      a.symbol.file.localeCompare(b.symbol.file) ||
      a.symbol.startLine - b.symbol.startLine,
  );
  return matches;
}

function kindMatches(symKind: SymbolKind, filter: string): boolean {
  if (filter === "method")
    return symKind === "method" || symKind === "getter" || symKind === "setter";
  return symKind === filter;
}
