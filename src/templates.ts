/**
 * String templates emitted by the `codemap init` and `codemap register`
 * commands. Kept separate so iteration on the user-facing text is cheap.
 */

export function userScopeClaudeMd(registryRelPath: string): string {
  return `# Cross-repo coding context

You have access to a multi-repo codebase. The registry below lists every repo registered with \`codemap\`.

@${registryRelPath}

## How to use this

1. **Orient first.** The registry tells you which repos exist, where each lives, and what each does. When the user describes a task, use the registry to identify which repo(s) the task touches before reading any source code.

2. **Load per-repo context on demand.** Each repo has its own CODEMAP at the path shown in the registry. Use the Read tool to load a repo's CODEMAP when the task touches it. Don't preemptively load codemaps for repos the task doesn't involve.

3. **Find before reading.** For symbol-level lookups across repos, run:
   \`\`\`
   codemap find <name>                # search all repos
   codemap find <name> --repo <slug>  # scope to one repo
   codemap read <file> <symbol> --repo <slug>
   \`\`\`
   This returns just the matches/source you need, without loading whole files.

4. **Prefer codemap+find over Read+grep.** Reading source files to figure out where things live is expensive and slow. The registry + codemaps + \`codemap find\` are designed to short-circuit that exploration.

5. **Treat stale entries with caution.** The registry shows when each repo's codemap was last generated and whether the repo has commits since then. If an entry is flagged stale, verify with \`codemap read\` (which uses live source) before trusting the codemap for that repo.
`;
}

export function projectScopeClaudeMd(slug: string, codemapAbsPath: string): string {
  return `# ${slug} (project codemap)

@${codemapAbsPath}

This is the structural map of this repo. When you need to navigate the codebase, use this map first instead of reading source files exploratorily.

For symbol-level lookups in this repo:
\`\`\`
codemap find <name> --repo ${slug}
codemap read <file> <symbol> --repo ${slug}
\`\`\`

For symbol lookups across all your registered repos (registry shows the list):
\`\`\`
codemap find <name>
\`\`\`
`;
}

/**
 * Git template hook script. Installed to ~/.codemaps/githooks/post-commit
 * and pointed at via \`git config --global core.hooksPath\`.
 *
 * Triggers \`codemap regen\` for whichever repo the commit happened in,
 * but only if that repo is registered.
 */
export const POST_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Auto-regenerate the codemap for this repo after each commit.
# Installed by \`codemap install-git-hook\`. Safe to skip if codemap is unavailable.
set -e
if ! command -v codemap >/dev/null 2>&1; then
  exit 0
fi
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$REPO_ROOT" ] && exit 0
# Run in background so commits aren't blocked.
( codemap regen --path "$REPO_ROOT" >/dev/null 2>&1 || true ) &
exit 0
`;
