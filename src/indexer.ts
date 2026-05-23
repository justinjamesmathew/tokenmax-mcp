import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignoreFactory from "ignore";

import { parseFile, initParser } from "./parser.js";
import {
  isSupportedSourceFile,
  languageForFile,
  toRelativePosix,
} from "./paths.js";
import type { FileIndex, RepoIndex, SourceSymbol } from "./types.js";

const DEFAULT_SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".vercel",
  ".cache",
];

export async function buildIndex(root: string): Promise<RepoIndex> {
  await initParser();
  const ig = await loadGitignore(root);

  const entries = await fg("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: root,
    absolute: true,
    dot: false,
    followSymbolicLinks: false,
    onlyFiles: true,
    ignore: DEFAULT_SKIP_DIRS.map((d) => `**/${d}/**`),
  });

  const index: RepoIndex = {
    root,
    files: new Map(),
    byLowerName: new Map(),
  };

  const tasks: Promise<FileIndex | null>[] = [];
  for (const abs of entries) {
    const rel = toRelativePosix(root, abs);
    if (ig.ignores(rel)) continue;
    if (!isSupportedSourceFile(rel)) continue;
    tasks.push(indexOne(root, abs));
  }

  // Bounded concurrency: parse in batches to avoid file-descriptor spikes.
  const BATCH = 32;
  for (let i = 0; i < tasks.length; i += BATCH) {
    const slice = await Promise.all(tasks.slice(i, i + BATCH));
    for (const fi of slice) {
      if (fi) addFile(index, fi);
    }
  }

  return index;
}

export async function refreshFileIfStale(
  index: RepoIndex,
  relPath: string,
): Promise<FileIndex | undefined> {
  const existing = index.files.get(relPath);
  const abs = path.resolve(index.root, relPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    if (existing) removeFile(index, relPath);
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (existing && existing.mtimeMs === stat.mtimeMs) return existing;
  if (!isSupportedSourceFile(relPath)) return undefined;
  const fi = await indexOne(index.root, abs);
  if (!fi) return undefined;
  if (existing) removeFileSymbolsFromNameIndex(index, existing);
  addFile(index, fi);
  return fi;
}

async function indexOne(
  root: string,
  abs: string,
): Promise<FileIndex | null> {
  const rel = toRelativePosix(root, abs);
  if (!isSupportedSourceFile(rel)) return null;
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return parseFile(abs, rel, languageForFile(rel), stat.mtimeMs);
}

function addFile(index: RepoIndex, fi: FileIndex): void {
  index.files.set(fi.path, fi);
  for (const sym of fi.symbols) addToNameIndex(index, sym);
}

function removeFile(index: RepoIndex, relPath: string): void {
  const fi = index.files.get(relPath);
  if (!fi) return;
  removeFileSymbolsFromNameIndex(index, fi);
  index.files.delete(relPath);
}

function addToNameIndex(index: RepoIndex, sym: SourceSymbol): void {
  const k = sym.name.toLowerCase();
  const list = index.byLowerName.get(k);
  if (list) list.push(sym);
  else index.byLowerName.set(k, [sym]);
}

function removeFileSymbolsFromNameIndex(
  index: RepoIndex,
  fi: FileIndex,
): void {
  for (const sym of fi.symbols) {
    const k = sym.name.toLowerCase();
    const list = index.byLowerName.get(k);
    if (!list) continue;
    const next = list.filter((s) => s.file !== fi.path);
    if (next.length === 0) index.byLowerName.delete(k);
    else index.byLowerName.set(k, next);
  }
}

async function loadGitignore(root: string): Promise<ReturnType<typeof ignoreFactory>> {
  const ig = ignoreFactory();
  try {
    const text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    ig.add(text);
  } catch {
    // no .gitignore — that's fine
  }
  // Always exclude the defaults too, in case .gitignore omits them.
  ig.add(DEFAULT_SKIP_DIRS.map((d) => `${d}/`).join("\n"));
  return ig;
}
