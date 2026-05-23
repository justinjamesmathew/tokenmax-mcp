# Decision log

Architectural and dependency choices for `repo-context-mcp`, with the reasoning so future-me can re-evaluate them.

---

## 1. WASM tree-sitter, not native bindings

**Chosen:** `web-tree-sitter` (the WASM runtime) + prebuilt grammars from `tree-sitter-wasms`.
**Rejected:** native Node bindings (`tree-sitter` + `tree-sitter-typescript` npm packages).

**Why.** The package is meant to run via `npx -y repo-context-mcp` and be friction-free to add to Claude Code. The native binding requires `node-gyp` and a C++ toolchain at install time, and the published `tree-sitter-typescript` package ships only `.c` sources — every install would mean a compile step. WASM grammars are platform-independent and load in tens of milliseconds.

**Tradeoff.** WASM is a touch slower than native at parse time. On the 1000-file target this still finishes well under 10 s, so it doesn't matter for the MVP. If perf becomes an issue, prebuilt platform-specific binaries via `@napi-rs` or `node-pre-gyp` would be the next step.

---

## 2. `web-tree-sitter@0.22.6` pinned (not latest)

**Chosen:** `web-tree-sitter@0.22.6` + `tree-sitter-wasms@0.1.13`.
**Rejected:** `web-tree-sitter@0.26.x` (latest).

**Why.** The latest `web-tree-sitter` expects WASM grammars built against ABI 15 (tree-sitter-cli 0.25+). The most widely-distributed prebuilt-WASM packages (`tree-sitter-wasms`, `@sourcegraph/tree-sitter-wasms`) are built against ABI 13–14, and `Language.load` rejects them with an opaque dylink error. Building our own grammars at package-build time would mean shipping a tree-sitter CLI + emscripten toolchain.

`web-tree-sitter@0.22.6` is the most recent version that exposes the `language.query()` and `query.matches()` API we use *and* accepts the ABI-13/14 grammars. The API is functionally equivalent for our purposes.

**Tradeoff.** We're on an older runtime. Grammar bug fixes from upstream `tree-sitter-typescript` past 0.20.5 are unavailable. If we hit a parser bug in modern TS syntax (e.g. some new decorator form), the path forward is either to wait for `tree-sitter-wasms` to publish ABI-15 builds or build our own.

---

## 3. Scan-on-read freshness, no background watcher

**Chosen:** stat the file on every `read_section` / `find_symbol` call; re-parse if mtime advanced.
**Rejected:** `chokidar`-style file watcher feeding incremental re-index.

**Why.** The MVP scope is one-shot tool calls from a chat session, not a long-running editor integration. Watchers add startup latency, a per-platform compat surface (fs events on macOS vs. inotify on Linux), and don't help for the common case where the user edits files outside the watched tree.

Scan-on-read costs one `stat` per tool call (~µs) and re-parses only when needed. For `find_symbol` we batch-stat the matched files in one pass rather than per-symbol.

**Tradeoff.** `repo_map` does *not* refresh files until you query them. If the user edits 20 files then calls `repo_map`, the map shows stale data. The fix would be to either stat-walk on every `repo_map` call (cheap) or stat-walk once at the start of the call. Worth adding if it shows up as confusion in real use.

---

## 4. Two compiled queries, one query source

**Chosen:** Single S-expression query string compiled twice — once against the `typescript` grammar, once against the `tsx` grammar.
**Rejected:** Two separate query files; or a single grammar.

**Why.** The two grammars share node names for everything we capture (`function_declaration`, `class_declaration`, `method_definition`, `lexical_declaration`, etc.). JSX only matters at usage sites (`jsx_element`), which we don't capture. Maintaining one query source means a fix in one place applies to both languages.

We don't use a single grammar because the JSX grammar can't parse some non-JSX TypeScript constructs (in particular, the `as Cast` syntax conflicts with JSX tags), and forcing all files through the `tsx` grammar produces parse errors on plain `.ts`. The choice is per-file by extension: `.tsx`/`.jsx` → tsx, everything else → typescript.

**Tradeoff.** We compile the query twice. The cost is negligible (~ms at startup) and only paid once.

---

## 5. Post-process AST in TS, don't push everything into queries

**Chosen:** Captures identify candidate nodes; the parser then walks ancestors to determine `exported`, `isDefaultExport`, parent class, modifiers, and signature/doc-comment slicing.
**Rejected:** Express every condition as a query predicate.

**Why.** Tree-sitter queries are great at "match this shape" and awkward at "walk up until you hit an export, also strip leading whitespace, also look at sibling comment nodes." Pushing those into queries would mean a sprawling query file with predicates like `#match?` and `#has-ancestor?` that are slow and hard to debug. JS-side post-processing keeps the query small and the rules debuggable with normal stack traces.

**Tradeoff.** The rules live in `parser.ts` rather than declaratively in the query. When you add a new symbol kind you have to touch two places. Acceptable for ~10 symbol kinds.

---

## 6. Re-exports indexed as `kind: "reexport"`, not followed

**Chosen:** `export { X } from './y'` and `export * from './y'` produce a `reexport` symbol that records the source module but doesn't resolve to the underlying definition.
**Rejected:** Resolve the import and surface the original definition.

**Why.** Import resolution is explicitly out of scope ("No cross-file dependency graph"). It's also non-trivial — TS path mapping, package.json exports, `index.ts` barrel resolution, monorepo workspace resolution all interact. The user can chain `find_symbol` to locate the underlying definition.

**Tradeoff.** `read_section` on a re-export returns the re-export line itself with a note about where the definition lives. If the user wanted the underlying source, they have to make a second call. Acceptable; the MCP transcript still saves tokens vs. reading the whole file.

---

## 7. `.d.ts` skipped

**Chosen:** Skip `.d.ts`, `.d.mts`, `.d.cts` at file-walk time.
**Rejected:** Index them.

**Why.** Declaration files describe types of values declared elsewhere — their symbols are duplicates of (and downstream of) the value-bearing source. Indexing them would double-count interfaces and types and bloat `find_symbol` output without adding navigation value. If a user really wants the declaration source, they can read it directly.

**Tradeoff.** Libraries distributed as `.d.ts`-only (e.g. `@types/*` packages) won't be findable via the index. In practice these live under `node_modules/` which we already skip, so this doesn't bite.

---

## 8. Only top-level exported consts indexed (for value consts)

**Chosen:** For non-function consts, require both top-level scope and `export`. For arrow-fn / function-expression consts, require only top-level (export not required).
**Rejected:** Index every named const.

**Why.** Top-level consts can be configuration, lookup tables, simple values — useful to surface. Nested consts (inside functions, blocks) aren't navigation targets; they're implementation detail. Requiring `export` for value consts filters out hundreds of file-private constants per typical repo without losing anything Claude would actually want to navigate to.

For function-like consts, we don't require export — internal helpers are common navigation targets ("show me the body of `parseHeader` even though it's not exported").

**Tradeoff.** A non-exported value const that the user really wants to look up won't appear in `find_symbol`. Mitigation: the user can still `read_section` by file + name, since `read_section`'s symbol lookup is file-scoped.

---

## 9. Anonymous default exports not captured

**Chosen:** `export default function foo() {}` is captured (name `foo`). `export default function() {}` (anonymous) is not.
**Rejected:** Synthesize a name like `default` for anonymous defaults.

**Why.** The tree-sitter pattern for capturing function declarations requires a `name: (identifier)` field. Anonymous default exports don't have one. Adding a separate query pattern for `(export_statement "default" value: (function_expression))` and synthesizing `name: "default"` is doable, but anonymous defaults are uncommon in well-organized code, and the user can always name the export.

**Tradeoff.** A small recognition gap. Documented in README.

---

## 10. Tool descriptions are explicit and prescriptive

**Chosen:** Tool descriptions for `repo_map`, `read_section`, `find_symbol` explicitly tell Claude *when* to call each one and how they compose (`repo_map` first, then `read_section`).
**Rejected:** Terse one-liners that just describe arguments.

**Why.** Claude Code reads tool descriptions to decide which tool to use, especially with tool search enabled where descriptions are the only signal until Claude actually invokes the tool. A description that says "use this when X" gets picked up; "returns a map" doesn't.

**Tradeoff.** The descriptions are longer (~200 words each). They eat context once when surfaced in a tool search match; that cost is amortized over a session's worth of tool calls.

---

## 11. Build with `tsup`, ship one bundled `dist/index.js`

**Chosen:** `tsup` (esbuild-based) with `format: ["esm"]`, dependencies kept external by default, shebang banner for the bin entry.
**Rejected:** `tsc` emitting `dist/**/*.js`.

**Why.** The package has 4 source files but pulls a moderate set of runtime deps (MCP SDK, fast-glob, ignore, web-tree-sitter, tree-sitter-wasms, zod). Bundling our own code keeps the dist tree to one file, which makes `bin` resolution simple and reduces filesystem churn at install time. Keeping deps external preserves the WASM/native binary boundaries — bundling `web-tree-sitter` would lose the package path lookup for `tree-sitter.wasm`.

**Tradeoff.** Two build tools in the project (`tsc` for typechecking, `tsup` for emit). Acceptable; both are fast and the configs are minimal.

---

## 12. Default-skip dirs in addition to `.gitignore`

**Chosen:** Skip `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `.vercel`, `.cache` even if `.gitignore` is missing or doesn't list them.
**Rejected:** Trust `.gitignore` alone.

**Why.** Many repos have implicit conventions — `dist/` and `.next/` are gitignored at the monorepo root but not in every sub-package's local `.gitignore`. Indexing them produces noise (compiled JS, duplicates of source, generated chunks). The default-skip list mirrors what every code search tool excludes by default.

**Tradeoff.** A user who *wants* their `dist/` indexed would have to fork the package. Unlikely to come up; if it does we can make the list configurable later.

---

# Heavy-user / multi-repo additions

Decisions made when scaling the product from "single-repo MCP" to "N-repo registry + CLI + MCP" for the vibecoder persona.

---

## 13. Three-tier orientation (registry → per-repo codemap → JIT tool)

**Chosen:** Split codebase context into three layers loaded at three different times:
1. **Registry** (always loaded via `~/.claude/CLAUDE.md` @-reference): 5-10 KB list of every registered repo, one paragraph each.
2. **Per-repo CODEMAP** (loaded on demand by Claude via the Read tool): 10-20 KB architectural map of one repo.
3. **JIT tool** (`codemap find` / `read` CLI + MCP equivalents): real-time symbol-level lookups.
**Rejected:** Single inlined map of everything; or pure JIT (no preloading).

**Why.** Single-inlined fails at N>3 repos — fitting 15 repos' codemaps into context costs 150+ KB and crowds the working budget. Pure JIT fails because Claude can't decide which tool to call without knowing what universe exists; it ends up exploratory-reading exactly the way we're trying to avoid. The three-tier model gives Claude orientation at the right resolution for each decision: "what exists" (registry) → "what's in this repo" (codemap) → "what's at this line right now" (tool).

**Tradeoff.** Three concepts to grok instead of one. The CLI hides most of it behind `codemap init` + `regen`, but it's still more setup than dropping a single MCP into one repo. Single-repo users can still use just the MCP without the registry, so the tax is opt-in.

---

## 14. Codemaps stored per-user (~/.codemaps), not in-repo

**Chosen:** Codemaps live under `~/.codemaps/<slug>/`, outside the repo tree, per-user not per-team.
**Rejected:** Committing `CODEMAP.md` to each repo so it's team-shared.

**Why.** Four problems with in-repo:
1. **Git noise.** Every regenerate produces a diff. Pre-commit hooks that regenerate codemaps make commit history unreadable.
2. **Per-machine drift conflicts.** Alice's machine regenerates Tuesday, Bob's Wednesday — merge conflicts on the codemap file that nobody cares to resolve.
3. **Leakage risk.** Sam adds a private side-project to their personal registry; if codemaps were in-repo and that codemap got auto-committed to a work repo, it'd leak.
4. **Lifecycle.** Codemaps regenerate on a different cadence than code commits.

Per-user storage avoids all four. Team-shared codemaps are still possible (copy/symlink into the repo manually), just opt-in.

**Tradeoff.** Onboarding a new team member means they re-run `codemap init` + `discover` + `regen --all` themselves, rather than having codemaps just appear after `git clone`. This is fine for the heavy-user persona (developers happy to run a one-time setup); poor for non-dev contributors. We're optimizing for the former.

---

## 15. JSON is the source of truth; Markdown is generated

**Chosen:** `~/.codemaps/registry.json` is canonical. `REGISTRY.md` is regenerated from it whenever the registry changes. CLI mutations write JSON; the markdown is a view.
**Rejected:** Parsing markdown as the data source (single file, more human-edit-friendly).

**Why.** Two-way markdown↔code is error-prone: comments, whitespace, ordering all become semantically significant. Keeping the markdown one-way (generated from JSON) means we never have to parse it, and the markdown is free to evolve format/layout without breaking the data model. JSON is also the right format for atomic writes and concurrent CLI invocations.

**Tradeoff.** Users can't hand-edit REGISTRY.md and expect changes to stick — they have to edit registry.json (or use CLI flags). This is documented; in practice users edit conventions via the per-repo `.codemap-conventions.md` (which IS preserved verbatim).

---

## 16. Persisted per-repo symbol index (symbols.json) for fast cross-repo find

**Chosen:** When `codemap regen` runs for a repo, also write `~/.codemaps/<slug>/symbols.json` — a flat list of every symbol with its file, line, kind, signature. `codemap find` loads all symbol JSONs in parallel and searches them.
**Rejected:** Re-parse all repos on every `codemap find` invocation.

**Why.** Cold parse of one 1000-file repo is ~2 seconds. Multiply by 15 repos and `codemap find` takes 30+ seconds — unusable. Persisted indexes load in ~10 ms per repo (small JSON files), and the cross-repo search is a one-pass scan. Total cost for 15 repos: well under 100 ms.

The persisted index goes stale between regens. We accept that: the user's mental model is "I commit, hook regenerates index, then find is accurate." For mid-session edits, the MCP's mtime-aware tools (`find_symbol`, `read_section`) provide the precision layer.

**Tradeoff.** Extra disk usage (~200 bytes/symbol × 2000 symbols × 15 repos ≈ 6 MB). Negligible. Slightly stale find results if you `codemap find` without running `regen` after edits. Mitigation: `codemap install-git-hook` auto-regens on commit.

---

## 17. CLI is the primary surface; MCP is a wrapper

**Chosen:** All functionality is implemented as CLI subcommands. The MCP server exposes the same core via stdio tools, but isn't required for the orientation workflow.
**Rejected:** MCP-first design, where CLI is a thin secondary.

**Why.** At N>5 repos, MCP-per-repo means N stdio servers per Claude Code session (process churn, namespaced tool names like `mcp__repo15__find_symbol`). A single global MCP that knows about all repos solves this — but its tools take a `repo` argument, which makes it functionally equivalent to a CLI with a `--repo` flag anyway. The CLI is composable with bash, doesn't need a server lifecycle, works from anywhere, and degrades gracefully — Claude can invoke it via Bash even if the MCP isn't registered.

The MCP wrapper still earns its keep: tool descriptions guide Claude on *when* to use each capability (vs. discovering the CLI exists), and the MCP can hold an in-memory index for sub-100ms repeated lookups within a session.

**Tradeoff.** Two surfaces to maintain. Mitigated by sharing the same core (`indexer.ts`, `codemap.ts`, `registry.ts`, `symbolIndex.ts`) — the CLI and MCP are each ~200 LOC wrappers.

---

## 18. Codemap content: architectural over structural

**Chosen:** CODEMAP.md contains file paths, file-purpose lines (from JSDoc), top-level symbol names + kinds, and public methods of classes (capped at 8). NO line numbers, NO full signatures, NO helper methods, NO imports.
**Rejected:** Verbose codemap with full signatures and line ranges (what `repo_map` MCP tool emits).

**Why.** Two reasons:

1. **Drift speed.** Line numbers change on every edit. Full signatures change on refactor. Helper methods come and go. If the codemap encodes these, it goes stale fast — and a stale codemap that Claude trusts causes bad edits. By contrast, file paths and top-level symbol names drift slowly (rarely change without a deliberate refactor).
2. **Decision value.** Knowing "the auth subsystem has `createSession`, `validateSession`, `refreshSession`, and a `SESSION_TTL_HOURS` constant" is enough for Claude to know *where to look*. Knowing the exact signature is the tool's job — it's a separate concern with a separate freshness guarantee.

The principle: **the codemap is a directory. The tool is the building.**

**Tradeoff.** Claude has to make one extra tool call to get precise signatures. That cost is bounded by task complexity, not codebase size — for a typical task touching 2-3 symbols, that's 2-3 tool calls, vs the savings of not having to read 5-10 files exploratorily.

---

## 19. Per-user CLAUDE.md marker block (idempotent)

**Chosen:** `codemap init` writes a marked block to `~/.claude/CLAUDE.md`:
```
<!-- codemap-registry-start -->
... registry @-reference + usage instructions ...
<!-- codemap-registry-end -->
```
Re-running `codemap init` replaces the block in place, preserving the user's other CLAUDE.md content.
**Rejected:** Overwriting `~/.claude/CLAUDE.md` entirely, or appending duplicate blocks.

**Why.** Many users have existing CLAUDE.md content (personal preferences, conventions, other tool instructions). We must not clobber it. Markers make our block detectable for in-place replacement. Idempotent re-init is important for the auto-regen story — running it as part of a setup script should not corrupt state.

**Tradeoff.** If the user deletes the markers but keeps the block content, re-init will append a second copy. Documented and minor.

---

## 20. Git hook setup is opt-in, not automatic

**Chosen:** `codemap install-git-hook` writes the hook script but doesn't run `git config --global core.hooksPath`. The CLI prints the command for the user to run.
**Rejected:** Auto-configuring git's global hooks path during `codemap init`.

**Why.** Mutating global git config without explicit consent is rude. Some users already have a custom global hooksPath set up and would lose it. The hook itself is harmless to install (just a script in a directory); enabling it is the consent step.

**Tradeoff.** One extra command for the user. Acceptable, especially since `codemap init`'s output points at the next-step command directly.

---

## 21. Slug = directory basename by default (overridable)

**Chosen:** `codemap register` defaults the slug to a slug-ified version of the repo directory's basename. The user can override with `--slug`.
**Rejected:** Asking the user for a slug interactively; or requiring an explicit slug always.

**Why.** Most repo directories already have memorable names (`user-service`, `web-app`). Slug-ifying them produces a sensible default. Forcing the user to choose every time slows down bulk `discover` flows. Override is there for monorepos where one root contains multiple distinct "packages" the user wants registered as separate slugs.

**Tradeoff.** Two repos with the same basename in different roots collide. The CLI lets the latest `register` win; user has to use `--slug` to disambiguate. Surfaces via the CLI's "already registered" prompt (could be added).

---

## 22. Sub-map generation is a future feature, not v1

**Chosen:** v1 produces one CODEMAP.md per registered repo, regardless of size. If your codemap exceeds ~40 KB, the docs suggest registering the subdirectory as its own slug as a workaround.
**Rejected:** Auto-partitioning into per-subsystem sub-maps in v1.

**Why.** The auto-partition design needs more thought — how does the registry track sub-maps? How does Claude know which to load? Where do they live on disk? The current architecture works fine for repos up to ~50 KB of codemap content. Larger repos are rare enough that v1 can ship without it, and the registering-subdirectories workaround handles the worst cases.

**Tradeoff.** Very large monorepos may produce uncomfortable codemaps. Acceptable for v1; revisit if it becomes a real problem.

---

## 23. Defer session-edits hook to user-configured `.claude/settings.json`

**Chosen:** Document the pattern for a session-edits log hook (PostToolUse Write/Edit → append; UserPromptSubmit → inject), but don't ship a default `settings.json`. The user opts in by editing their own settings.
**Rejected:** Auto-installing the hook as part of `codemap init`.

**Why.** Hooks run arbitrary commands on every tool call. Users with security-sensitive setups, custom hook configurations, or just preferences against opaque global behavior should not have this installed silently. Documenting the pattern is enough — users who want it can copy/paste; the rest don't get surprised.

**Tradeoff.** Out-of-box experience is a notch worse — session-mid edits to a file don't get flagged automatically. The MCP tools' mtime-fresh behavior partially compensates.

