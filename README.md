# tokenmax-mcp

[![npm version](https://img.shields.io/npm/v/tokenmax-mcp.svg)](https://www.npmjs.com/package/tokenmax-mcp)
[![CI](https://github.com/justinjamesmathew/tokenmax-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/justinjamesmathew/tokenmax-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/tokenmax-mcp.svg)](LICENSE)

**Stop Claude Code from re-reading your entire codebase every session.**

If you've watched Claude grep around your project for 5 minutes before doing anything useful, or hit a context limit halfway through a real task, this is for you.

After setup:
- Claude knows your codebase structure the moment you open a session (no exploratory reads).
- It works across multiple repos without you telling it where things live.
- `/clear` and `/compact` don't reset that knowledge.
- It reads only the symbols it actually needs, not whole files.

Works with Claude Code (via MCP) and as a standalone CLI. TypeScript/JavaScript repos. MIT licensed.

---

## Get started — 5 steps, ~2 minutes

### Step 1: Install

```bash
npm install -g tokenmax-mcp
```

Requires Node 20+.

**✓ Verify:**

```bash
codemap help
```

You should see a list of subcommands. If `codemap: command not found`, check that your npm global bin is on your PATH (`npm bin -g` tells you the directory).

---

### Step 2: One-time setup

```bash
codemap init
```

This does two things:
1. Creates `~/.codemaps/` to store your codemaps.
2. Adds a small block to `~/.claude/CLAUDE.md` that tells Claude how to use them.

**✓ Verify:**

```bash
cat ~/.claude/CLAUDE.md | head -20
```

You should see a `<!-- codemap-registry-start -->` marker. [See exactly what got added →](#what-codemap-init-added-to-your-claudemd)

---

### Step 3: Tell codemap about your repos

If you keep all your repos in one place (e.g., `~/projects`), discover them in one shot:

```bash
codemap discover ~/projects
```

Or register repos individually from inside each one:

```bash
cd ~/projects/my-app
codemap register
```

**✓ Verify:**

```bash
codemap list
```

You should see each repo with its path and freshness state (will show `(never indexed)` until step 4).

---

### Step 4: Generate the codemaps

```bash
codemap regen --all
```

This parses every registered repo and writes a structural map to `~/.codemaps/<slug>/CODEMAP.md`. Takes ~1 second per 100 source files.

**✓ Verify:**

```bash
codemap list
```

Each repo should now show `✓ fresh` instead of `(never indexed)`.

```bash
codemap find <some-function-name>
```

Should return matches across all your repos with file paths and line numbers.

---

### Step 5: Connect it to Claude Code

```bash
claude mcp add --scope user tokenmax -- codemap mcp
```

This makes the in-session tools (`find_symbol_global`, `read_section_global`, etc.) available in every Claude Code session.

**✓ Verify:** Open Claude Code, run `/mcp`. You should see `tokenmax` with 6 tools.

---

### Optional but recommended: auto-update on every commit

So you never have to remember to run `codemap regen`:

```bash
codemap install-git-hook
git config --global core.hooksPath ~/.codemaps/githooks
```

Every `git commit` in a registered repo now updates that repo's codemap in the background.

---

## What `codemap init` added to your CLAUDE.md

This is the block that was inserted at the bottom of `~/.claude/CLAUDE.md`. It's wrapped in markers so re-running `codemap init` updates it in place without touching the rest of your CLAUDE.md.

```markdown
<!-- codemap-registry-start -->
# Cross-repo coding context

You have access to a multi-repo codebase. The registry below lists every repo registered with `codemap`.

@~/.codemaps/REGISTRY.md

## How to use this

1. **Orient first.** Use the registry to identify which repo(s) the task touches before reading any source code.

2. **Load per-repo context on demand.** Each repo has its own CODEMAP at the path shown in the registry. Read it via the Read tool when the task touches that repo.

3. **Find before reading.** For symbol-level lookups, run:
   `codemap find <name>`
   `codemap read <file> <symbol> --repo <slug>`

4. **Prefer codemap+find over Read+grep.** The registry and codemaps are designed to short-circuit exploration.

5. **Treat stale entries with caution.** Stale flags appear in the registry; verify with `codemap read` for those repos.
<!-- codemap-registry-end -->
```

### Things you might want to customize

**Edit the block contents.** Open `~/.claude/CLAUDE.md`, change anything between the markers. Your edits persist as long as you don't re-run `codemap init`.

**Remove it.** Just delete everything from `<!-- codemap-registry-start -->` to `<!-- codemap-registry-end -->`. The tools still work; Claude just won't be auto-pointed at them.

**Pin a specific repo's codemap at session start.** If you mostly work in one project, add this to that project's `CLAUDE.md` (at the repo root, not the global one):

```markdown
@~/.codemaps/<your-slug>/CODEMAP.md
```

Claude now inlines that repo's codemap at session start instead of loading it on demand. Faster orientation, but uses more tokens upfront. Worth it if the codemap is small (< 20 KB).

**Add a sister repo's codemap for cross-repo work.** If you're often jumping between, say, frontend and backend:

```markdown
@~/.codemaps/backend/CODEMAP.md
@~/.codemaps/frontend/CODEMAP.md
```

In each repo's CLAUDE.md, reference the other. Now both are in context whenever you open Claude in either project.

---

## What changes after setup

You don't change anything about how you prompt Claude. The codebase orientation is just there, in the background.

**Before:**

> *You:* "the email service is dropping welcome emails"
>
> *Claude:* "Let me explore the codebase to understand the structure..." (reads 12 files, 80 KB of context)

**After:**

> *You:* "the email service is dropping welcome emails"
>
> *Claude:* finds the relevant repo from the registry, reads its codemap, runs `codemap find welcomeEmail`, reads just the handler function — and starts fixing.

---

## Per-repo conventions (optional)

The codemap auto-derives the basic stuff (purpose, tech stack) from your `package.json`. For codebase-specific rules — naming, error handling, "we never use library X" — add a file at the repo root:

`<your-repo>/.codemap-conventions.md`

```markdown
- All routes use `withAuth()` middleware unless prefixed `/public`
- Errors: `throw new ApiError(code, message)`
- DB access via `src/db/repos/*.ts` — never raw queries in handlers
- Tests use Vitest and live next to source as `*.test.ts`
```

Next `codemap regen` includes it in that repo's CODEMAP. This is the single highest-leverage content you can add — conventions almost never drift, and they directly shape what Claude writes.

---

## Daily usage

You shouldn't need to think about it. Just open Claude Code and work normally.

If you want to use the CLI directly:

```bash
# Find a symbol across all your repos
codemap find UserService

# Read just one symbol's source
codemap read src/services/user.ts UserService.list --repo my-backend

# See what's in the registry
codemap list

# Show which registered repo you're currently in
codemap where
```

---

## Command reference

| Command | What it does |
|---|---|
| `codemap init` | One-time setup: creates `~/.codemaps/`, updates `~/.claude/CLAUDE.md` |
| `codemap discover [dirs...]` | Walk dirs, register every repo found |
| `codemap register [path]` | Register one repo (defaults to current directory) |
| `codemap unregister <slug>` | Remove a repo from the registry |
| `codemap list` | Show all registered repos + freshness |
| `codemap regen [--repo <slug>\|--all]` | Regenerate codemap(s) |
| `codemap find <name> [--repo <slug>] [--kind <kind>]` | Cross-repo symbol search |
| `codemap read <file> <symbol> [--repo <slug>]` | Read one symbol's source |
| `codemap where` | Show which registered repo (if any) you're in |
| `codemap install-git-hook` | Install post-commit auto-regen hook |
| `codemap mcp` | Start the MCP server (used by Claude Code) |

---

## Troubleshooting

**`codemap: command not found` after `npm install -g`**
Your npm global bin isn't on PATH. Run `npm bin -g` to find the dir, add it to `.zshrc` / `.bashrc`.

**`claude mcp add` says the server "failed"**
In Claude Code, run `/mcp` — failed servers show their stderr. Usually it's Node < 20 (`node --version` should be v20+) or a write-permission issue on `~/.codemaps`.

**`codemap find` says "No persisted symbol indexes found"**
Run `codemap regen --all` first. The persistent indexes are generated by regen.

**Your codemap is larger than 40 KB (big repo)**
Split it. Register subdirectories as separate slugs:
```bash
codemap register ~/work/big-repo/api --slug bigrepo-api
codemap register ~/work/big-repo/web --slug bigrepo-web
```
Each gets its own smaller, focused codemap.

**You renamed or moved a repo**
Re-register it with the same slug to update the path:
```bash
codemap register /new/path --slug existing-slug
```

**You want to remove tokenmax entirely**
```bash
npm uninstall -g tokenmax-mcp
rm -rf ~/.codemaps
# Then delete the <!-- codemap-registry-start --> ... block from ~/.claude/CLAUDE.md
```

---

## FAQ

**Does it edit my code?** No. Read-only.

**Does it call any external services?** No. Everything runs locally. No telemetry.

**Are my codemaps shared with my team?** No, they live in `~/.codemaps/` (your home). For team sharing, copy `~/.codemaps/<slug>/CODEMAP.md` into the repo manually.

**Does it work with non-TypeScript projects?** Currently TS/JS only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). Python/Go/Rust on the roadmap.

**What if my codemap goes stale during a long edit session?** The MCP tools (`find_symbol`, `read_section`) mtime-check files on every call — so they always return current source. The codemap itself stays as-is until `codemap regen` runs, but Claude can verify any entry against the live source via the tools.

**Why store codemaps outside the repo?** Avoids git diff noise from regeneration, per-machine drift conflicts, and accidental leakage when working on private projects. Opt in to team sharing by copying.

---

## How it works (briefly)

Three layers of context loaded at three different times:

| Layer | Size | Loaded |
|---|---|---|
| **Registry** (list of every repo you've registered) | ~5 KB | Every session, via `~/.claude/CLAUDE.md` |
| **Per-repo CODEMAP** (architecture, conventions, public APIs) | ~10-20 KB | On demand, when the task touches a repo |
| **JIT tools** (`codemap find`/`read` + MCP equivalents) | only what matches | When Claude needs precision |

Line numbers and full signatures live in the tools (they drift fast). File paths and architectural notes live in the codemap (drift slow). The registry is just the directory of repos.

Full design rationale in [DECISIONS.md](DECISIONS.md) — 23 architectural decisions with reasoning.

---

## Limitations

- TypeScript / JavaScript only.
- No cross-file dependency graph. Re-exports are recorded but not followed.
- No semantic search / embeddings.
- No destructured exports (`export const { a, b } = obj`).
- No `namespace` / `module` declarations.
- No automatic sub-map generation for very large repos (manual workaround: register subdirectories).
- Anonymous default exports (`export default function() {}`) not captured.

---

## Contributing

```bash
git clone https://github.com/justinjamesmathew/tokenmax-mcp.git
cd tokenmax-mcp
npm install
npm run typecheck && npm test && npm run build
```

44 tests across parser, codemap generator, registry, discover, CLI. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev loop and project layout.

---

## License

MIT © [Justin James Mathew](https://github.com/justinjamesmathew)
