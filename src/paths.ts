import path from "node:path";
import fs from "node:fs";

export function resolveWorkspaceRoot(): string {
  // Precedence: explicit WORKSPACE_ROOT wins, then Claude Code's
  // CLAUDE_PROJECT_DIR (set automatically for spawned stdio MCP servers),
  // then process.cwd().
  const fromEnv =
    process.env["WORKSPACE_ROOT"] && process.env["WORKSPACE_ROOT"].length > 0
      ? process.env["WORKSPACE_ROOT"]
      : process.env["CLAUDE_PROJECT_DIR"] &&
          process.env["CLAUDE_PROJECT_DIR"].length > 0
        ? process.env["CLAUDE_PROJECT_DIR"]
        : undefined;
  const candidate = fromEnv ?? process.cwd();
  const absolute = path.resolve(candidate);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${absolute}`);
  }
  return absolute;
}

/**
 * Resolve a user-supplied path relative to the workspace root and reject anything
 * that escapes the root. Accepts absolute or relative input; output is always absolute.
 */
export function safeResolveWithin(root: string, requested: string): string {
  const absRoot = path.resolve(root);
  const joined = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(absRoot, requested);
  const rel = path.relative(absRoot, joined);
  if (rel === "" ) return joined;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path resolves outside workspace root: ${requested}`);
  }
  return joined;
}

export function toRelativePosix(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join("/");
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function isSupportedSourceFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return false;
  // Skip declaration files — they describe types without value-level definitions.
  if (p.endsWith(".d.ts") || p.endsWith(".d.mts") || p.endsWith(".d.cts")) {
    return false;
  }
  return true;
}

export function languageForFile(p: string): "typescript" | "tsx" {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".tsx" || ext === ".jsx") return "tsx";
  return "typescript";
}
