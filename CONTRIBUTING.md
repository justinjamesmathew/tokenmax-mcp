# Contributing to repo-context-mcp

Thanks for your interest. This guide covers the dev loop, project layout, and how to propose changes.

## Dev loop

Requires Node 20+.

```bash
git clone https://github.com/justinjamesmathew/repo-context-mcp.git
cd repo-context-mcp
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # tsup → dist/
```

To iterate on a real session locally:

```bash
npm link              # exposes `codemap` + `repo-context-mcp` on PATH
# then in some other repo:
codemap init
codemap register .
codemap regen
```

## Project layout

```
src/
  cli-entry.ts        # `codemap` bin entry
  cli.ts              # CLI subcommand router
  codemap.ts          # CODEMAP.md generator
  discover.ts         # Repo auto-discovery
  index.ts            # `repo-context-mcp` MCP bin entry
  indexer.ts          # Filesystem walk + symbol indexing
  parser.ts           # tree-sitter wrapper, symbol extraction, CJS export detection
  paths.ts            # Workspace root resolution, path safety
  queries/
    typescript.ts     # Shared tree-sitter S-expression queries
  registry.ts         # ~/.codemaps/registry.json CRUD + REGISTRY.md generator
  server.ts           # MCP server (single- + cross-repo tools)
  setup.ts            # `codemap init` + git hook installer
  symbolIndex.ts      # Per-repo persisted symbol indexes (for fast cross-repo find)
  templates.ts        # CLAUDE.md template + git hook script
  types.ts            # Shared types

tests/
  fixtures/           # Tiny sample TS/TSX/JS projects used by tests
  *.test.ts           # Vitest suites

DECISIONS.md          # Architecture decisions + tradeoffs (read this before deep changes)
```

## Where to make changes

- **Bug in symbol extraction** → `src/parser.ts` (and possibly `src/queries/typescript.ts`)
- **Codemap output format** → `src/codemap.ts`
- **CLI subcommand** → `src/cli.ts`
- **MCP tool** → `src/server.ts`
- **Multi-repo registry behavior** → `src/registry.ts`

## Tests

```bash
npm test              # one-shot
npm run test:watch    # watch mode
```

When fixing a parser bug, add a fixture file under `tests/fixtures/<scenario>/` and a test in `tests/index.test.ts` that asserts the expected symbol extraction. Real-world parser bugs are easy to regress; fixtures lock them down.

## Pull requests

- Open an issue first for anything bigger than a small fix — it's faster to align on approach than on a finished PR.
- Keep PRs scoped. One concern per PR.
- Add tests for any behavior change.
- Update `DECISIONS.md` when you make an architectural change worth documenting (anything someone in 6 months would want context on).
- `npm run typecheck && npm test && npm run build` must pass.

## Things to know before going deep

1. **`web-tree-sitter` is pinned to 0.22.6.** Latest (0.26.x) requires ABI 15 WASM grammars which aren't published anywhere. See `DECISIONS.md` #2.
2. **CJS export detection is regex-based.** Tree-sitter doesn't model `module.exports = X` as an export, so we post-process the source. See `applyCjsExports` in `parser.ts`.
3. **Registry storage is JSON; markdown is generated.** Edit `registry.json` (or use CLI) — REGISTRY.md is overwritten on every mutation. See `DECISIONS.md` #15.
4. **Tests can use `CODEMAPS_HOME` env var** to redirect storage from `~/.codemaps` to a tmpdir. Use this in any test that mutates registry state.

## Release process (maintainer only)

1. Bump version in `package.json`.
2. Update `CHANGELOG.md` if it exists by then.
3. Commit + tag: `git tag v0.x.y && git push --tags`.
4. The publish GitHub Actions workflow fires on the tag push and runs `npm publish`.

(Alternatively, manual publish: `npm publish` with 2FA. `prepack` runs typecheck + tests + build automatically.)
