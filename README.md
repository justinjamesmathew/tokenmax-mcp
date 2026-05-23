# repo-context-mcp

[![npm version](https://img.shields.io/npm/v/repo-context-mcp.svg)](https://www.npmjs.com/package/repo-context-mcp)
[![CI](https://github.com/justinjamesmathew/repo-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/justinjamesmathew/repo-context-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/repo-context-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/repo-context-mcp.svg)](https://nodejs.org)

**Stop letting Claude Code re-read your entire codebase every session.**

A `codemap` CLI + MCP server that gives Claude Code a structured, symbol-level view of one repo or many. Claude orients from the registry at session start, loads per-repo maps on demand, and uses fast JIT tools for precision lookups — instead of grepping and reading files exploratorily.

Built for heavy users with many repos. Works for single-repo setups too.

```
Before:                                  After:
─────────                                ─────────
Session 1: 60+ exploratory reads to     Session 1: registry loaded at start
           figure out where things are              → ~5KB context. Claude knows
           → ~150KB context burned                    where every symbol lives.
Session 2 (after /compact):                          → reaches code directly.
           same 60 reads, all over     Session 2 (after /compact):
           again                                    same, no re-discovery.
```

---

## Table of contents

- [Install](#install)
- [60-second setup (multi-repo, recommended)](#60-second-setup-multi-repo-recommended)
- [Minimal setup (single repo, MCP only)](#minimal-setup-single-repo-mcp-only)
- [How it works](#how-it-works)
- [Using it from Claude Code](#using-it-from-claude-code)
- [CLI reference](#cli-reference)
- [Storage layout](#storage-layout)
- [Per-repo conventions](#per-repo-conventions)
- [Freshness model](#freshness-model)
- [Sizing guidance](#sizing-guidance)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Limitations](#limitations)
- [Contributing](#contributing)

---

## Install

```bash
npm install -g repo-context-mcp
```

Node 20+ required. Exposes two bins:

- `codemap` — the CLI for managing your repo registry and codemaps
- `repo-context-mcp` — the MCP server that Claude Code connects to

Verify:

```bash
codemap help
repo-context-mcp --help 2>&1 | head -1   # MCP servers don't have help, but should not crash
```

## 60-second setup (multi-repo, recommended)

This is the full setup. Do it once.

```bash
# 1. Scaffold ~/.codemaps and wire ~/.claude/CLAUDE.md
codemap init

# 2. Find and register all your repos in one shot
codemap discover ~/projects                  # adjust to where your repos live
codemap list                                  # confirm what got picked up

# 3. Generate codemaps for everything
codemap regen --all

# 4. Auto-regen on every commit (optional but recommended)
codemap install-git-hook
git config --global core.hooksPath ~/.codemaps/githooks

# 5. Hook up the MCP so Claude can do JIT lookups in-session
claude mcp add --scope user repo-context -- codemap mcp
```

Open Claude Code in any project, run `/mcp`, and you should see `repo-context` with 6 tools. From now on:

- Every session starts with the registry in context (all your repos, what each does, where each lives)
- When Claude needs to look at a specific repo, it loads that repo's CODEMAP via the Read tool
- For symbol lookups, Claude (or you) uses `codemap find` / `codemap read` via Bash, or the MCP equivalents

That's the whole workflow.

## Minimal setup (single repo, MCP only)

If you just want the in-session MCP tools for one project — no registry, no global state:

```bash
cd /path/to/your/project
claude mcp add repo-context -- npx -y repo-context-mcp
```

Open Claude Code, run `/mcp`, you'll see 3 tools (`repo_map`, `read_section`, `find_symbol`) scoped to the current project. No `codemap init` required; no `~/.codemaps` created.

This works but you lose the orientation benefit (Claude still has to call `repo_map` itself to discover structure). The full setup above is strictly better for ongoing use.

---

## How it works

Three tiers of context, loaded at three different times:

| Tier | What | Size | Loaded when |
|---|---|---|---|
| **1. Registry** | List of all your repos, one paragraph each | ~5-10 KB | Every Claude Code session, via `~/.claude/CLAUDE.md` |
| **2. Per-repo CODEMAP** | Architecture + conventions + public APIs of one repo | 10-20 KB | On demand, when the task touches that repo |
| **3. JIT tools** | Real-time `find` / `read` for symbols | only the matches | When Claude needs a precise location or source |

The registry is the "telephone directory" — Claude knows every repo exists. The CODEMAP is the "tour brochure" for one building. The tools are the "GPS" for exactly where to go inside.

Key design choices documented in [DECISIONS.md](DECISIONS.md). Short version: line numbers and full signatures live in the tools (drift fast), file paths and architectural notes live in the codemap (drift slow), every-repo overview lives in the registry (changes only when you add/remove a repo).

## Using it from Claude Code

After setup, your interaction with Claude doesn't change. You ask in natural language. Claude figures out which repo, which file, which symbol — using the codemap and tools you've made available.

Examples that just work:

```
"The login button doesn't work on mobile."
→ Claude consults the registry, identifies the frontend repo, loads its codemap,
  finds the login component, reads it, makes the fix.

"Why is the email service dropping welcome emails?"
→ Claude finds the email-service repo in the registry, loads its codemap,
  uses `find_symbol_global` to locate the welcome-email handler, reads it,
  diagnoses the bug — without ever asking you where the code lives.

"Refactor the User type so it has an optional avatarUrl across both repos."
→ Claude uses `find_symbol_global User` to locate the type in each repo,
  reads each definition, makes the change in both places.
```

The "before" version of any of these involves you typing "the email service is in repo X, the handler is at path Y" or watching Claude run `grep -r` across multiple directories. After setup, Claude already knows.

### Where to put per-repo conventions

The codemap auto-derives `purpose` and `tech` from `package.json`. For anything else — naming conventions, error-handling patterns, the "we never use library X" rules — add a `.codemap-conventions.md` file to the repo root. The next `codemap regen` includes it verbatim in that repo's CODEMAP. See [Per-repo conventions](#per-repo-conventions).

---

## CLI reference

```
codemap init                        Scaffold ~/.codemaps and wire ~/.claude/CLAUDE.md
codemap register [path]             Register a repo (defaults to cwd)
                                      --slug <slug>    override default slug (dir basename)
                                      --purpose "..."  override purpose
                                      --tech "..."     override tech stack
                                      --no-regen       skip codemap regen
codemap unregister <slug>           Remove a repo from the registry
codemap list                        List registered repos
codemap discover [root...]          Walk dirs, bulk-register found repos
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
```

`--repo <slug>` defaults to whichever registered repo contains your current directory.

### MCP tools

When you register the MCP (`claude mcp add repo-context -- codemap mcp`), Claude Code gets these tools:

| Tool | Scope | When Claude uses it |
|---|---|---|
| `repo_map` | current repo | Exploring an unfamiliar area; survey before diving in |
| `read_section` | current repo | After identifying a symbol, get just its source |
| `find_symbol` | current repo | Symbol name search within the current project |
| `list_repos` | cross-repo | When the task might span repos and Claude needs the directory |
| `find_symbol_global` | cross-repo | Symbol search across all registered repos |
| `read_section_global` | cross-repo | Read a symbol from a specific repo by slug |

The cross-repo tools auto-register only when a registry exists (i.e., you've run `codemap init` + registered at least one repo). Single-repo users only see 3 tools.

---

## Storage layout

Everything lives in `~/.codemaps/` (override with `CODEMAPS_HOME` env var).

```
~/.codemaps/
  registry.json           # machine source of truth
  REGISTRY.md             # human/Claude-readable view (auto-generated; what gets loaded)
  githooks/post-commit    # optional auto-regen hook (installed by `codemap install-git-hook`)
  <slug>/
    CODEMAP.md            # per-repo codemap (loaded into Claude on demand)
    symbols.json          # flat symbol index for fast cross-repo find
```

Codemaps live **outside** your repos by default — per-user, not committed. This avoids git noise from regeneration, per-machine drift conflicts, and accidental leakage of private projects. If you want team-shared codemaps, copy `~/.codemaps/<slug>/CODEMAP.md` into the repo manually (or via CI).

---

## Per-repo conventions

The most valuable content in a codemap is your codebase's conventions — naming patterns, where things go, what to avoid. The generator auto-derives `purpose`/`tech` from `package.json`, but you'll get better results by hand-curating conventions.

Create `.codemap-conventions.md` at the repo root:

```markdown
- All routes use `withAuth()` middleware unless prefixed `/public`
- Errors: `throw new ApiError(code, message)` — caught by errorHandler
- Logging: import logger from `src/lib/log.ts` (no console.log)
- DB access via `src/db/repos/*.ts` — never raw queries in handlers
- Tests use Vitest and live next to source as `*.test.ts`
```

This file is preserved verbatim in the regenerated codemap's `## Conventions` section. It almost never drifts (conventions change rarely), and it actively shapes what Claude writes.

Conventions punch above their weight per token — a 500-byte conventions block can save many turns of "no, we don't do it that way."

---

## Freshness model

Different tiers go stale at different speeds. The system handles each appropriately.

| Layer | Drift speed | How it stays fresh |
|---|---|---|
| REGISTRY.md | Slow (add/rename/remove repos) | Rewritten on every `codemap register/regen/unregister` |
| Per-repo CODEMAP.md | Medium (new files, symbols moved) | `codemap regen --repo X`, or the git post-commit hook |
| symbols.json | Medium | Rewritten with CODEMAP.md |
| MCP `find_symbol` / `read_section` | Real-time | mtime-checked per call |

The git post-commit hook (installed via `codemap install-git-hook`) keeps codemaps auto-current per-repo. For mid-session edits, the MCP tools refresh from disk on every call.

For maximum safety in long edit sessions, you can add an optional Claude Code hook that tracks which files were edited mid-session and tells Claude to treat their codemap entries as suspect. See [DECISIONS.md](DECISIONS.md) #23 for the snippet.

---

## Sizing guidance

| Artifact | Target | Hard ceiling |
|---|---|---|
| REGISTRY.md (always loaded) | 5-10 KB | ~10 KB |
| Per-repo CODEMAP.md (loaded on demand) | 10-20 KB | ~40 KB |

For very large repos (200+ files), the per-repo CODEMAP may exceed 40 KB. Workarounds:

1. **Register subdirectories as separate slugs:**
   ```bash
   codemap register ~/work/big-repo/api --slug bigrepo-api
   codemap register ~/work/big-repo/web --slug bigrepo-web
   ```
   Each gets its own smaller codemap.
2. **Don't inline the codemap in project CLAUDE.md.** Let Claude read it on demand via the Read tool — costs 0 tokens per session that doesn't touch the repo.

Per-subsystem sub-map generation is planned but not yet automatic — see [DECISIONS.md](DECISIONS.md) #22.

---

## Troubleshooting

### `codemap: command not found` after `npm install -g`

Your npm global bin isn't on PATH. Find it with:

```bash
npm bin -g    # prints the directory
```

Add that directory to your PATH (in `.zshrc`, `.bashrc`, etc.). On macOS with Homebrew Node, this is usually `/opt/homebrew/bin` (already on PATH).

### `claude mcp add` says the server is "failed"

Check `/mcp` inside Claude Code — failed servers show their stderr. Common causes:

- `npx -y repo-context-mcp` fails because Node version is < 20. `node --version` should print v20+.
- The package didn't install. Try `npm install -g repo-context-mcp` first, then `claude mcp add repo-context -- repo-context-mcp` (no `npx`).
- Permission errors writing to `~/.codemaps`. Confirm the directory is writable.

### Codemap is too large (above 40 KB)

You hit the size ceiling for a large repo. See [Sizing guidance](#sizing-guidance) — split by subdirectory.

### `codemap find` returns "No persisted symbol indexes found"

The persisted indexes are written by `codemap regen`. Run:

```bash
codemap regen --all
```

### CommonJS exports aren't being recognized

`module.exports = X`, `exports.X = ...`, `module.exports = { a, b }`, and `Object.assign(module.exports, { ... })` are all recognized. If yours isn't, please open an issue with a minimal reproduction.

### My repo uses TypeScript syntax that fails to parse

The grammars are pinned to a stable version (see [DECISIONS.md](DECISIONS.md) #2). Very new TS features (some decorator stage-3 forms, new keywords) may not parse cleanly. The indexer is fault-tolerant — files that fail parsing get a fallback entry rather than crashing the index. Open an issue with the offending file if you hit one.

### I want to uninstall everything

```bash
npm uninstall -g repo-context-mcp
rm -rf ~/.codemaps
# Manually remove the <!-- codemap-registry-start --> ... <!-- codemap-registry-end -->
# block from ~/.claude/CLAUDE.md (or delete the file if it only had that)
```

---

## FAQ

**Why are codemaps stored per-user instead of in each repo?**
Avoids git diff noise per regeneration, per-machine drift conflicts, and accidental leakage of private projects. For team-shared codemaps, copy `~/.codemaps/<slug>/CODEMAP.md` into your repo manually.

**What if I move a repo?**
Re-run `codemap register <new-path> --slug <slug>` to update the entry; the slug stays the same so existing references continue to work.

**Does it edit files?**
No. Read-only.

**Does it send anything over the network?**
No. Everything runs locally. No telemetry, no analytics, no API calls.

**Does it work with non-TypeScript projects?**
Currently TypeScript/JavaScript only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). Python/Go/Rust/etc. on the roadmap.

**Performance?**
Cold scan of a 1000-file repo: ~2 seconds. Cross-repo `find` across 15 repos using persisted indexes: ~100ms.

**Other MCP clients (Cursor, Claude Desktop)?**
Built and tuned for Claude Code specifically (the MCP tool descriptions are written for Claude Code's tool-selection heuristics). The protocol is standard MCP, so it should work elsewhere, but it isn't tested.

---

## Limitations

v1 (current):

- TypeScript/JavaScript only.
- No cross-file dependency graph. Re-exports captured as references but not followed.
- No semantic search / embeddings.
- No destructured exports (`export const { a, b } = obj`).
- No `namespace` / `module` declarations.
- No automatic sub-map generation for large repos (manual workaround: register subdirectories).
- No automatic `consumes` / `consumedBy` inference between repos.
- No web/HTTP transport for the MCP — stdio only.
- Anonymous default exports (`export default function() {}`) not captured.

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, project layout, and where to make changes.

Quick start for contributors:

```bash
git clone https://github.com/justinjamesmathew/repo-context-mcp.git
cd repo-context-mcp
npm install
npm run typecheck
npm test
npm run build
```

44 tests across parser, codemap generator, registry, discover, CLI end-to-end. Run them before opening a PR.

For architectural decisions and the reasoning behind tradeoffs, read [DECISIONS.md](DECISIONS.md) — it covers everything from why we use `web-tree-sitter@0.22.6` to why codemaps live under `~/.codemaps`.

---

## License

MIT © [Justin James Mathew](https://github.com/justinjamesmathew)
