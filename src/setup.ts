import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  codemapsHome,
  ensureHome,
  loadRegistry,
  registryMarkdownPath,
  saveRegistry,
} from "./registry.js";
import {
  POST_COMMIT_HOOK_SCRIPT,
  userScopeClaudeMd,
} from "./templates.js";

const USER_CLAUDE_MD = path.join(os.homedir(), ".claude", "CLAUDE.md");
const HOOKS_DIR = path.join(codemapsHome(), "githooks");
const POST_COMMIT_HOOK = path.join(HOOKS_DIR, "post-commit");

/**
 * `codemap init` — scaffold ~/.codemaps and update ~/.claude/CLAUDE.md to
 * @-reference the registry. Idempotent: re-runs are safe.
 *
 * Returns a list of human-readable actions performed (for the CLI to print).
 */
export async function runInit(): Promise<string[]> {
  const actions: string[] = [];

  await ensureHome();
  actions.push(`Ensured ${codemapsHome()} exists.`);

  // Initialise registry.json + REGISTRY.md if missing.
  const reg = await loadRegistry();
  await saveRegistry(reg);
  actions.push(`Initialised ${registryMarkdownPath()}.`);

  // Touch ~/.claude dir
  await fs.mkdir(path.dirname(USER_CLAUDE_MD), { recursive: true });

  // Update ~/.claude/CLAUDE.md to reference the registry, preserving existing
  // content if the user already has one.
  const registryRel = path.relative(
    path.dirname(USER_CLAUDE_MD),
    registryMarkdownPath(),
  );
  const block = userScopeClaudeMd(registryRel);
  await ensureClaudeMdHasBlock(USER_CLAUDE_MD, block);
  actions.push(`Updated ${USER_CLAUDE_MD} with registry @-reference.`);

  return actions;
}

/**
 * Append our marker block to ~/.claude/CLAUDE.md if it isn't already there.
 * Wrap in clear markers so we can detect and replace on future inits.
 */
async function ensureClaudeMdHasBlock(
  file: string,
  block: string,
): Promise<void> {
  const startMarker = "<!-- codemap-registry-start -->";
  const endMarker = "<!-- codemap-registry-end -->";
  const wrapped = `${startMarker}\n${block}\n${endMarker}\n`;

  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    // file doesn't exist; write fresh
  }

  if (existing.includes(startMarker) && existing.includes(endMarker)) {
    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker) + endMarker.length;
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx).replace(/^\n+/, "\n");
    const next = before + wrapped + after;
    if (next !== existing) {
      await fs.writeFile(file, next);
    }
    return;
  }

  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
  await fs.writeFile(file, existing + sep + wrapped);
}

/**
 * `codemap install-git-hook` — write the post-commit hook to
 * ~/.codemaps/githooks/ and configure git's global hooksPath.
 */
export async function installGitHook(): Promise<string[]> {
  const actions: string[] = [];
  await fs.mkdir(HOOKS_DIR, { recursive: true });
  await fs.writeFile(POST_COMMIT_HOOK, POST_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
  actions.push(`Wrote ${POST_COMMIT_HOOK}.`);

  // Hint at the config command rather than invoking git ourselves — touching
  // global git config is a per-machine decision the user should consent to.
  actions.push(
    `Run this once to enable auto-regen on commit:\n  git config --global core.hooksPath ${HOOKS_DIR}`,
  );
  actions.push(
    `(If you already have a global hooksPath, you'll want to merge by hand.)`,
  );
  return actions;
}
