import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildIndex, refreshFileIfStale } from "./indexer.js";
import {
  isSupportedSourceFile,
  languageForFile,
  resolveWorkspaceRoot,
  safeResolveWithin,
  toRelativePosix,
} from "./paths.js";
import type { RepoIndex, SourceSymbol, SymbolKind } from "./types.js";
import { loadRegistry, codemapPathFor } from "./registry.js";
import { readSymbolIndex, searchPersisted } from "./symbolIndex.js";
import { parseFile } from "./parser.js";

const KIND_FILTER_VALUES = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "const",
] as const;

const REPO_MAP_DESC = `Return a compact symbol-level outline of a TypeScript/JavaScript codebase: files, then classes/functions/methods/interfaces/type aliases/enums/exported consts with one-line signatures, line numbers, and (when present) the first line of the symbol's JSDoc.

USE THIS FIRST when:
- exploring an unfamiliar codebase
- the task spans multiple files whose locations you don't yet know
- you'd otherwise read several files to figure out what exists

This is 5-10x cheaper than reading whole files. After repo_map shows you the relevant symbol, call read_section to fetch only that symbol's source — don't read the file.

Args:
  path: optional subdirectory (relative to workspace root). Default: whole workspace.
  depth: 1 = files + top-level symbols only. 2 (default) = also include methods inside classes.`;

const READ_SECTION_DESC = `Return the source code for ONE symbol, prefixed with the file's import block (top of file through the last import statement).

USE THIS instead of reading the whole file when you already know which symbol you need — typically right after repo_map or find_symbol has identified it. Returns roughly 5-10x fewer tokens than reading the full file.

Args:
  file: source file path, relative to workspace root.
  symbol: name of the symbol. Use dotted notation for methods (e.g. "ClassName.methodName"). A bare name is accepted if unambiguous within the file.`;

const FIND_SYMBOL_DESC = `Fuzzy search for a symbol by name across the indexed codebase. Case-insensitive substring match on the symbol's own name (not its qualified name). Faster and more precise than grep for symbol-level lookups.

USE THIS when:
- you know (or can guess) the symbol's name but not the file
- you want all definitions of a name across the repo

Returns a list of matches with file, line number, kind, and signature. Follow up with read_section to fetch the body.

Args:
  name: substring to search for, case-insensitive.
  kind: optional filter — one of "function", "class", "method", "interface", "type", "const".`;

export async function startServer(): Promise<void> {
  const root = resolveWorkspaceRoot();
  const startedAt = Date.now();
  const index = await buildIndex(root);
  const elapsed = Date.now() - startedAt;
  process.stderr.write(
    `[tokenmax-mcp] indexed ${index.files.size} files in ${elapsed}ms (root=${root})\n`,
  );

  const mcp = new McpServer(
    { name: "tokenmax-mcp", version: "0.1.1" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  mcp.registerTool(
    "repo_map",
    {
      title: "Repo map",
      description: REPO_MAP_DESC,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Optional subdirectory to scope to, relative to workspace root.",
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(2)
          .optional()
          .describe("1 = top-level only; 2 = include class members. Default 2."),
      },
    },
    async (args) => {
      const subPath = args.path;
      const depth = args.depth ?? 2;
      const scopeAbs = subPath ? safeResolveWithin(root, subPath) : root;
      const scopeRel = toRelativePosix(root, scopeAbs);
      const text = renderRepoMap(index, scopeRel, depth);
      return { content: [{ type: "text", text }] };
    },
  );

  mcp.registerTool(
    "read_section",
    {
      title: "Read symbol source",
      description: READ_SECTION_DESC,
      inputSchema: {
        file: z
          .string()
          .describe("Source file path relative to the workspace root."),
        symbol: z
          .string()
          .describe(
            'Symbol name. Dotted form like "Class.method" for methods.',
          ),
      },
    },
    async (args) => {
      const abs = safeResolveWithin(root, args.file);
      const rel = toRelativePosix(root, abs);
      if (!isSupportedSourceFile(rel)) {
        return errorResult(`Not a supported source file: ${rel}`);
      }
      await refreshFileIfStale(index, rel);
      const fi = index.files.get(rel);
      if (!fi) return errorResult(`File not indexed: ${rel}`);
      const match = findSymbolForRead(fi.symbols, args.symbol);
      if (!match) {
        if (match === null) {
          return errorResult(
            `Symbol "${args.symbol}" is ambiguous in ${rel}. Use a dotted form (e.g. ClassName.${args.symbol}) to disambiguate.`,
          );
        }
        return errorResult(`Symbol "${args.symbol}" not found in ${rel}.`);
      }
      const source = await fs.readFile(abs, "utf8");
      const text = renderReadSection(source, fi.importBlockEndLine, match, rel);
      return { content: [{ type: "text", text }] };
    },
  );

  mcp.registerTool(
    "find_symbol",
    {
      title: "Find symbol by name",
      description: FIND_SYMBOL_DESC,
      inputSchema: {
        name: z.string().min(1).describe("Substring to match (case-insensitive)."),
        kind: z
          .enum(KIND_FILTER_VALUES)
          .optional()
          .describe("Optional kind filter."),
      },
    },
    async (args) => {
      const needle = args.name.toLowerCase();
      const kind = args.kind;
      const out: SourceSymbol[] = [];
      // First pass: refresh any file the matches might come from. We do this
      // by walking the entire byLowerName map keys whose key contains the
      // needle. For unscanned-on-read freshness, we then re-check stat for
      // matched files and re-parse if stale.
      for (const [key, list] of index.byLowerName) {
        if (!key.includes(needle)) continue;
        for (const sym of list) {
          if (kind && sym.kind !== kind && !kindMatches(sym.kind, kind)) {
            continue;
          }
          out.push(sym);
        }
      }
      // Refresh files for the matched symbols' files (dedup file list).
      const fileSet = new Set(out.map((s) => s.file));
      const refreshed = new Map<string, SourceSymbol[]>();
      for (const file of fileSet) {
        await refreshFileIfStale(index, file);
        const fi = index.files.get(file);
        if (fi) refreshed.set(file, fi.symbols);
      }
      // Re-do the match against refreshed symbols, replacing any stale ones.
      const final: SourceSymbol[] = [];
      for (const sym of out) {
        const fresh = refreshed.get(sym.file);
        if (!fresh) {
          final.push(sym);
          continue;
        }
        // Find the corresponding symbol in fresh by qualifiedName
        const match = fresh.find(
          (s) => s.qualifiedName === sym.qualifiedName && s.kind === sym.kind,
        );
        if (match && match.name.toLowerCase().includes(needle)) {
          if (!kind || kindMatches(match.kind, kind)) final.push(match);
        }
      }
      // Sort by file, then line
      final.sort(
        (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine,
      );
      const text = renderFindResults(final, args.name, kind);
      return { content: [{ type: "text", text }] };
    },
  );

  // ----- Cross-repo tools (only registered if the user has set up a registry) -----

  await registerCrossRepoTools(mcp);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // `mcp.connect()` resolves once stdio handlers are wired up; it does NOT
  // block. The CLI entry calls process.exit(code) as soon as runCli resolves,
  // so without this wait the server would die before serving a single
  // JSON-RPC message. Hold the event loop until the client disconnects.
  await new Promise<void>((resolve) => {
    const prev = transport.onclose;
    transport.onclose = () => {
      prev?.();
      resolve();
    };
  });
}

const LIST_REPOS_DESC = `Return the cross-repo registry: every repo the user has registered with \`codemap\`, with its slug, path, purpose, tech, and codemap location.

USE THIS when:
- the user's task might involve a repo other than the current one
- you need to know what other repos exist before deciding where to look
- you want to load another repo's CODEMAP via the Read tool

Cheap (a few KB). Always safe to call.`;

const FIND_SYMBOL_GLOBAL_DESC = `Cross-repo symbol search. Case-insensitive substring match across every registered repo's persisted symbol index. Returns matches grouped by repo, with file path, line number, and signature.

USE THIS when:
- you're looking for a symbol and don't know which repo it lives in
- you want to compare definitions of the same name across repos (e.g. shared types, similarly-named services)

Pass \`repo: <slug>\` to scope to one repo. Pass \`kind: <kind>\` to filter by symbol kind. Faster than running grep across multiple repos.`;

const READ_SECTION_GLOBAL_DESC = `Read one symbol's source from a specific repo, by slug. Prefixed with the repo's file's import block.

USE THIS after \`find_symbol_global\` has identified a match in a repo other than the current one. Avoids needing to switch projects to inspect code.`;

async function registerCrossRepoTools(mcp: McpServer): Promise<void> {
  const reg = await loadRegistry();
  const slugs = Object.keys(reg.entries);
  if (slugs.length === 0) {
    // No registry → don't expose cross-repo tools at all. Keeps the tool
    // list small for users who haven't opted into the heavy-user setup.
    return;
  }
  process.stderr.write(
    `[tokenmax-mcp] registry has ${slugs.length} repo(s); cross-repo tools enabled\n`,
  );

  mcp.registerTool(
    "list_repos",
    {
      title: "List registered repos",
      description: LIST_REPOS_DESC,
      inputSchema: {},
    },
    async () => {
      const r = await loadRegistry();
      const lines: string[] = [];
      const ss = Object.keys(r.entries).sort();
      if (ss.length === 0) {
        return {
          content: [
            { type: "text", text: "(no repos registered with codemap)" },
          ],
        };
      }
      lines.push(`${ss.length} registered repo(s):`);
      for (const slug of ss) {
        const e = r.entries[slug]!;
        lines.push("");
        lines.push(`### ${slug}`);
        lines.push(`- path: ${e.path}`);
        lines.push(`- codemap: ${codemapPathFor(slug)}`);
        if (e.tech) lines.push(`- tech: ${e.tech}`);
        if (e.purpose) lines.push(`- purpose: ${e.purpose}`);
        if (e.consumes?.length)
          lines.push(`- consumes: ${e.consumes.join(", ")}`);
        if (e.consumedBy?.length)
          lines.push(`- consumed by: ${e.consumedBy.join(", ")}`);
        if (e.lastIndexedMs) {
          const stale =
            e.lastCommitMs && e.lastCommitMs > e.lastIndexedMs
              ? " ⚠ stale"
              : " ✓ fresh";
          lines.push(
            `- indexed: ${new Date(e.lastIndexedMs).toISOString().slice(0, 10)}${stale}`,
          );
        }
        if (e.fileCount !== undefined && e.symbolCount !== undefined) {
          lines.push(`- stats: ${e.fileCount} files, ${e.symbolCount} symbols`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  mcp.registerTool(
    "find_symbol_global",
    {
      title: "Find symbol across all repos",
      description: FIND_SYMBOL_GLOBAL_DESC,
      inputSchema: {
        name: z.string().min(1).describe("Substring to match (case-insensitive)."),
        repo: z.string().optional().describe("Optional slug to scope to one repo."),
        kind: z
          .enum(KIND_FILTER_VALUES)
          .optional()
          .describe("Optional kind filter."),
      },
    },
    async (args) => {
      const r = await loadRegistry();
      const targetSlugs = args.repo
        ? r.entries[args.repo]
          ? [args.repo]
          : []
        : Object.keys(r.entries);
      if (targetSlugs.length === 0) {
        return errorResult(
          args.repo
            ? `No such slug: ${args.repo}`
            : "No repos registered.",
        );
      }
      const indexes = (
        await Promise.all(targetSlugs.map((s) => readSymbolIndex(s)))
      ).filter((x): x is NonNullable<typeof x> => x !== undefined);
      if (indexes.length === 0) {
        return errorResult(
          "No persisted symbol indexes found. Run `codemap regen --all` first.",
        );
      }
      const matches = searchPersisted(indexes, args.name, args.kind);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols matched "${args.name}"${args.kind ? ` (kind=${args.kind})` : ""}.`,
            },
          ],
        };
      }
      const lines: string[] = [];
      lines.push(
        `${matches.length} match${matches.length === 1 ? "" : "es"} for "${args.name}":`,
      );
      for (const m of matches) {
        lines.push(
          `  [${m.slug}] ${m.symbol.file}:${m.symbol.startLine}  ${m.symbol.kind.padEnd(9)} ${m.symbol.signature}`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  mcp.registerTool(
    "read_section_global",
    {
      title: "Read symbol source from a specific repo",
      description: READ_SECTION_GLOBAL_DESC,
      inputSchema: {
        repo: z.string().describe("Slug of the repo (from list_repos)."),
        file: z.string().describe("File path relative to that repo's root."),
        symbol: z.string().describe("Symbol name. Dotted form like Class.method for methods."),
      },
    },
    async (args) => {
      const r = await loadRegistry();
      const entry = r.entries[args.repo];
      if (!entry) return errorResult(`No such slug: ${args.repo}`);
      const repoRoot = entry.path;
      const abs = safeResolveWithin(repoRoot, args.file);
      const rel = path
        .relative(repoRoot, abs)
        .split(path.sep)
        .join("/");
      if (!isSupportedSourceFile(rel)) {
        return errorResult(`Not a supported source file: ${rel}`);
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return errorResult(`File not found: ${rel}`);
      }
      const fi = await parseFile(abs, rel, languageForFile(rel), stat.mtimeMs);
      const match = findSymbolForRead(fi.symbols, args.symbol);
      if (!match) {
        if (match === null) {
          return errorResult(
            `Symbol "${args.symbol}" is ambiguous in ${rel}. Use a dotted form (e.g. ClassName.${args.symbol}) to disambiguate.`,
          );
        }
        return errorResult(`Symbol "${args.symbol}" not found in ${rel}.`);
      }
      const source = await fs.readFile(abs, "utf8");
      const text = renderReadSection(
        source,
        fi.importBlockEndLine,
        match,
        `${args.repo}/${rel}`,
      );
      return { content: [{ type: "text", text }] };
    },
  );
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function kindMatches(symKind: SymbolKind, filter: string): boolean {
  if (filter === "method") return symKind === "method" || symKind === "getter" || symKind === "setter";
  return symKind === filter;
}

// ---------- repo_map rendering ----------

function renderRepoMap(
  index: RepoIndex,
  scopeRel: string,
  depth: number,
): string {
  const isScoped = scopeRel !== "" && scopeRel !== ".";
  const prefix = isScoped ? scopeRel + "/" : "";
  const filesInScope = [...index.files.keys()]
    .filter((p) => (isScoped ? p === scopeRel || p.startsWith(prefix) : true))
    .sort();

  if (filesInScope.length === 0) {
    return isScoped
      ? `(no source files under ${scopeRel})`
      : "(no source files indexed)";
  }

  const lines: string[] = [];
  for (const p of filesInScope) {
    const fi = index.files.get(p)!;
    lines.push(p + (fi.parseError ? "  [parse-error]" : ""));
    // Group methods/getters/setters under their parent class.
    const topLevel = fi.symbols.filter(
      (s) => !s.parent && s.kind !== "method" && s.kind !== "getter" && s.kind !== "setter",
    );
    for (const sym of topLevel) {
      lines.push(renderSymbolLine(sym, 2));
      if (depth >= 2 && sym.kind === "class") {
        const members = fi.symbols.filter((s) => s.parent === sym.name);
        for (const m of members) {
          lines.push(renderSymbolLine(m, 4));
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

function renderSymbolLine(sym: SourceSymbol, indent: number): string {
  const pad = " ".repeat(indent);
  const range =
    sym.startLine === sym.endLine
      ? `[${sym.startLine}]`
      : `[${sym.startLine}-${sym.endLine}]`;
  const doc = sym.docComment ? ` — ${sym.docComment}` : "";
  return `${pad}${sym.signature} ${range}${doc}`;
}

// ---------- read_section rendering ----------

function findSymbolForRead(
  symbols: SourceSymbol[],
  query: string,
): SourceSymbol | undefined | null {
  // Dotted form first
  const dotted = symbols.filter((s) => s.qualifiedName === query);
  if (dotted.length === 1) return dotted[0];
  if (dotted.length > 1) return null;

  // Bare name lookup — must be unique by `name` within the file.
  const byName = symbols.filter((s) => s.name === query);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;

  // Case-insensitive fallback
  const lower = query.toLowerCase();
  const ci = symbols.filter(
    (s) => s.name.toLowerCase() === lower || s.qualifiedName.toLowerCase() === lower,
  );
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) return null;
  return undefined;
}

function renderReadSection(
  source: string,
  importBlockEndLine: number,
  sym: SourceSymbol,
  file: string,
): string {
  const allLines = source.split(/\r?\n/);
  const out: string[] = [];

  out.push(`// File: ${file}`);
  out.push(`// Symbol: ${sym.qualifiedName} (${sym.kind})`);
  if (sym.parent) out.push(`// Parent: ${sym.parent}`);
  out.push("");

  if (importBlockEndLine > 0) {
    out.push("// --- imports ---");
    for (let i = 0; i < importBlockEndLine; i++) {
      out.push(formatLine(i + 1, allLines[i] ?? ""));
    }
    out.push("");
  }

  if (sym.kind === "reexport") {
    out.push("// --- re-export reference ---");
    out.push(formatLine(sym.startLine, allLines[sym.startLine - 1] ?? ""));
    out.push("");
    out.push(
      `// Note: this is a re-export. The definition lives in: ${sym.reexport?.from ?? "(unknown)"}`,
    );
    return out.join("\n");
  }

  out.push(`// --- ${sym.qualifiedName} ---`);
  for (let i = sym.startLine; i <= sym.endLine; i++) {
    out.push(formatLine(i, allLines[i - 1] ?? ""));
  }
  return out.join("\n");
}

function formatLine(n: number, content: string): string {
  return `${String(n).padStart(5)}: ${content}`;
}

// ---------- find_symbol rendering ----------

function renderFindResults(
  results: SourceSymbol[],
  query: string,
  kind?: string,
): string {
  if (results.length === 0) {
    const k = kind ? ` (kind=${kind})` : "";
    return `No symbols matched "${query}"${k}.`;
  }
  const lines: string[] = [];
  lines.push(
    `${results.length} match${results.length === 1 ? "" : "es"} for "${query}"${kind ? ` (kind=${kind})` : ""}:`,
  );
  for (const s of results) {
    lines.push(
      `  ${s.file}:${s.startLine}  ${s.kind.padEnd(9)} ${s.signature}`,
    );
    if (s.docComment) lines.push(`    — ${s.docComment}`);
  }
  return lines.join("\n");
}
