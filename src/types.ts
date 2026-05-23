export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "getter"
  | "setter"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "reexport";

export type Language = "typescript" | "tsx";

export interface SymbolModifiers {
  async?: boolean;
  static?: boolean;
  abstract?: boolean;
  readonly?: boolean;
  visibility?: "public" | "private" | "protected";
  generator?: boolean;
}

export interface ReexportInfo {
  from: string;
  originalName?: string;
  localName?: string;
}

export interface SourceSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  signature: string;
  docComment?: string;
  exported: boolean;
  isDefaultExport: boolean;
  parent?: string;
  modifiers?: SymbolModifiers;
  reexport?: ReexportInfo;
}

export interface FileIndex {
  path: string;
  absPath: string;
  mtimeMs: number;
  language: Language;
  symbols: SourceSymbol[];
  importBlockEndLine: number;
  parseError?: string;
}

export interface RepoIndex {
  root: string;
  files: Map<string, FileIndex>;
  byLowerName: Map<string, SourceSymbol[]>;
}

export const KIND_FILTERS = new Set<string>([
  "function",
  "class",
  "method",
  "interface",
  "type",
  "const",
]);

// ---------- Registry / heavy-user types ----------

/**
 * A repo registered with codemap. Stored in ~/.codemaps/registry.json.
 * Keyed by slug (human-friendly id, defaults to dir basename).
 */
export interface RegistryEntry {
  slug: string;
  path: string;              // absolute path to repo root
  purpose?: string;          // 1-3 line description; auto-derived from package.json if absent
  tech?: string;             // e.g., "Node 20 / Express / Postgres"
  consumes?: string[];       // slugs of other repos this one depends on
  consumedBy?: string[];     // slugs of other repos that depend on this one
  lastIndexedMs?: number;    // when codemap was last regenerated
  lastCommitMs?: number;     // when repo was last committed to (from git)
  symbolCount?: number;
  fileCount?: number;
}

export interface Registry {
  version: 1;
  entries: Record<string, RegistryEntry>; // slug → entry
}

/**
 * A persisted, flat symbol index per repo. Used for fast cross-repo lookups
 * by the CLI without having to re-parse the whole repo on every invocation.
 * Lives at ~/.codemaps/<slug>/symbols.json.
 */
export interface PersistedSymbolIndex {
  slug: string;
  generatedAtMs: number;
  symbols: PersistedSymbol[];
}

export interface PersistedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  file: string;        // relative to repo root, posix
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  parent?: string;
}
