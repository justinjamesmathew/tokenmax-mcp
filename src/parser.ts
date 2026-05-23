import { createRequire } from "node:module";
import fs from "node:fs/promises";
import Parser from "web-tree-sitter";

import type {
  FileIndex,
  Language as LangKind,
  SourceSymbol,
  SymbolKind,
  SymbolModifiers,
} from "./types.js";
import { TS_QUERY_SOURCE } from "./queries/typescript.js";

type Node = Parser.SyntaxNode;
type Language = Parser.Language;
type Query = Parser.Query;
type QueryCapture = Parser.QueryCapture;
type QueryMatch = Parser.QueryMatch;

const req = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
let langTs: Language | null = null;
let langTsx: Language | null = null;
let queryTs: Query | null = null;
let queryTsx: Query | null = null;
let parserTs: Parser | null = null;
let parserTsx: Parser | null = null;

export async function initParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    const tsPath = req.resolve(
      "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
    );
    const tsxPath = req.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm");
    langTs = await Parser.Language.load(tsPath);
    langTsx = await Parser.Language.load(tsxPath);
    queryTs = langTs.query(TS_QUERY_SOURCE);
    queryTsx = langTsx.query(TS_QUERY_SOURCE);
    parserTs = new Parser();
    parserTs.setLanguage(langTs);
    parserTsx = new Parser();
    parserTsx.setLanguage(langTsx);
  })();
  return initPromise;
}

function getParser(lang: LangKind): Parser {
  return lang === "tsx" ? parserTsx! : parserTs!;
}

function getQuery(lang: LangKind): Query {
  return lang === "tsx" ? queryTsx! : queryTs!;
}

export async function parseFile(
  absPath: string,
  relPath: string,
  language: LangKind,
  mtimeMs: number,
): Promise<FileIndex> {
  await initParser();
  const source = await fs.readFile(absPath, "utf8");

  try {
    const tree = getParser(language).parse(source);
    if (!tree) {
      return fallbackIndex(
        absPath,
        relPath,
        language,
        mtimeMs,
        source,
        "parser returned null",
      );
    }
    const cjs = detectCjsExports(source);
    const { symbols, importBlockEndLine } = extractSymbols(
      tree.rootNode,
      source,
      relPath,
      language,
      cjs,
    );
    applyCjsExports(symbols, cjs);
    const parseError =
      tree.rootNode.hasError && symbols.length === 0
        ? "tree-sitter parse error, no symbols extracted"
        : undefined;
    tree.delete();
    if (parseError) {
      return fallbackIndex(
        absPath,
        relPath,
        language,
        mtimeMs,
        source,
        parseError,
      );
    }
    return {
      path: relPath,
      absPath,
      mtimeMs,
      language,
      symbols,
      importBlockEndLine,
    };
  } catch (err) {
    return fallbackIndex(
      absPath,
      relPath,
      language,
      mtimeMs,
      source,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------- extraction ----------

interface CapMap {
  [name: string]: Node | undefined;
}

function mapCaptures(captures: QueryCapture[]): CapMap {
  const out: CapMap = {};
  for (const c of captures) {
    if (out[c.name] === undefined) out[c.name] = c.node;
  }
  return out;
}

interface CjsExports {
  named: Set<string>;
  defaultName: string | undefined;
}

function extractSymbols(
  root: Node,
  source: string,
  file: string,
  language: LangKind,
  cjs: CjsExports,
): { symbols: SourceSymbol[]; importBlockEndLine: number } {
  const query = getQuery(language);
  const matches: QueryMatch[] = query.matches(root);

  const symbols: SourceSymbol[] = [];
  const constFunctionDeclaratorIds = new Set<number>();

  for (const m of matches) {
    const cap = mapCaptures(m.captures);
    if (cap["sym.const_function"]) {
      constFunctionDeclaratorIds.add(cap["sym.const_function"].id);
    }
  }

  for (const m of matches) {
    const cap = mapCaptures(m.captures);

    if (cap["sym.function"]) {
      const sym = buildFunctionDeclaration(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.class"]) {
      const sym = buildClassDeclaration(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.interface"]) {
      const sym = buildHeaderDeclaration(cap, source, file, "interface");
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.type"]) {
      const sym = buildHeaderDeclaration(cap, source, file, "type");
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.enum"]) {
      const sym = buildHeaderDeclaration(cap, source, file, "enum");
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.method"]) {
      const sym = buildMethod(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.const_function"]) {
      const sym = buildConstFunction(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.const_value"]) {
      const node = cap["sym.const_value"]!;
      if (constFunctionDeclaratorIds.has(node.id)) continue;
      const sym = buildConstValue(cap, source, file, cjs);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.reexport"]) {
      const sym = buildReexport(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
    if (cap["sym.reexport_star"]) {
      const sym = buildReexportStar(cap, source, file);
      if (sym) symbols.push(sym);
      continue;
    }
  }

  symbols.sort(
    (a, b) => a.startLine - b.startLine || a.startByte - b.startByte,
  );

  return { symbols, importBlockEndLine: findImportBlockEndLine(root) };
}

// ---------- builders ----------

function buildFunctionDeclaration(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const decl = cap["sym.function"]!;
  const nameNode = cap["sym.name"];
  if (!isTopLevel(decl)) return undefined;
  const { exported, isDefault } = exportInfo(decl);
  const name = nameNode?.text ?? (isDefault ? "default" : undefined);
  if (!name) return undefined;
  const modifiers = extractFunctionModifiers(decl);
  return {
    name,
    qualifiedName: name,
    kind: "function",
    file,
    startLine: lineOf(decl.startPosition.row),
    endLine: lineOf(decl.endPosition.row),
    startByte: decl.startIndex,
    endByte: decl.endIndex,
    signature: extractSignature(decl, source),
    docComment: findLeadingDocComment(decl, source),
    exported,
    isDefaultExport: isDefault,
    ...(Object.keys(modifiers).length ? { modifiers } : {}),
  };
}

function buildClassDeclaration(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const decl = cap["sym.class"]!;
  const nameNode = cap["sym.name"];
  if (!isTopLevel(decl)) return undefined;
  const { exported, isDefault } = exportInfo(decl);
  const name = nameNode?.text ?? (isDefault ? "default" : undefined);
  if (!name) return undefined;
  const modifiers = extractFunctionModifiers(decl);
  return {
    name,
    qualifiedName: name,
    kind: "class",
    file,
    startLine: lineOf(decl.startPosition.row),
    endLine: lineOf(decl.endPosition.row),
    startByte: decl.startIndex,
    endByte: decl.endIndex,
    signature: extractSignature(decl, source),
    docComment: findLeadingDocComment(decl, source),
    exported,
    isDefaultExport: isDefault,
    ...(Object.keys(modifiers).length ? { modifiers } : {}),
  };
}

function buildHeaderDeclaration(
  cap: CapMap,
  source: string,
  file: string,
  kind: Extract<SymbolKind, "interface" | "type" | "enum">,
): SourceSymbol | undefined {
  const capName = `sym.${kind}` as const;
  const decl = cap[capName]!;
  const nameNode = cap["sym.name"];
  if (!isTopLevel(decl)) return undefined;
  if (!nameNode) return undefined;
  const { exported, isDefault } = exportInfo(decl);
  return {
    name: nameNode.text,
    qualifiedName: nameNode.text,
    kind,
    file,
    startLine: lineOf(decl.startPosition.row),
    endLine: lineOf(decl.endPosition.row),
    startByte: decl.startIndex,
    endByte: decl.endIndex,
    signature: extractSignature(decl, source),
    docComment: findLeadingDocComment(decl, source),
    exported,
    isDefaultExport: isDefault,
  };
}

function buildMethod(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const decl = cap["sym.method"]!;
  const nameNode = cap["sym.name"];
  if (!nameNode) return undefined;
  const parentClass = findEnclosingClassName(decl);
  if (!parentClass) return undefined; // skip object-literal methods

  const { kind, isConstructor } = classifyMethod(decl);
  const name = isConstructor ? "constructor" : nameNode.text;
  const qualifiedName = `${parentClass}.${name}`;
  const modifiers = extractMethodModifiers(decl);

  return {
    name,
    qualifiedName,
    kind,
    file,
    startLine: lineOf(decl.startPosition.row),
    endLine: lineOf(decl.endPosition.row),
    startByte: decl.startIndex,
    endByte: decl.endIndex,
    signature: extractSignature(decl, source),
    docComment: findLeadingDocComment(decl, source),
    exported: false,
    isDefaultExport: false,
    parent: parentClass,
    ...(Object.keys(modifiers).length ? { modifiers } : {}),
  };
}

function buildConstFunction(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const declarator = cap["sym.const_function"]!;
  const nameNode = cap["sym.name"];
  if (!nameNode) return undefined;
  const lexDecl = declarator.parent;
  if (!lexDecl || !isTopLevel(lexDecl)) return undefined;
  const { exported, isDefault } = exportInfo(lexDecl);
  const valueNode = declarator.childForFieldName("value");
  const isAsync = !!valueNode?.children.some((c) => c.type === "async");
  const isGen = valueNode?.type === "generator_function";
  const mods: SymbolModifiers = {};
  if (isAsync) mods.async = true;
  if (isGen) mods.generator = true;
  return {
    name: nameNode.text,
    qualifiedName: nameNode.text,
    kind: "function",
    file,
    startLine: lineOf(lexDecl.startPosition.row),
    endLine: lineOf(declarator.endPosition.row),
    startByte: lexDecl.startIndex,
    endByte: declarator.endIndex,
    signature: extractConstFunctionSignature(declarator, source),
    docComment: findLeadingDocComment(lexDecl, source),
    exported,
    isDefaultExport: isDefault,
    ...(Object.keys(mods).length ? { modifiers: mods } : {}),
  };
}

function buildConstValue(
  cap: CapMap,
  source: string,
  file: string,
  cjs: CjsExports,
): SourceSymbol | undefined {
  const declarator = cap["sym.const_value"]!;
  const nameNode = cap["sym.name"];
  if (!nameNode) return undefined;
  const lexDecl = declarator.parent;
  if (!lexDecl || !isTopLevel(lexDecl)) return undefined;
  const { exported: esExported, isDefault: esDefault } = exportInfo(lexDecl);
  const cjsNamed = cjs.named.has(nameNode.text);
  const cjsDefault = cjs.defaultName === nameNode.text;
  const exported = esExported || cjsNamed || cjsDefault;
  const isDefault = esDefault || cjsDefault;
  if (!exported) return undefined; // still: only exported top-level value consts (ES or CJS)
  return {
    name: nameNode.text,
    qualifiedName: nameNode.text,
    kind: "const",
    file,
    startLine: lineOf(lexDecl.startPosition.row),
    endLine: lineOf(declarator.endPosition.row),
    startByte: lexDecl.startIndex,
    endByte: declarator.endIndex,
    signature: extractConstValueSignature(lexDecl, declarator, source),
    docComment: findLeadingDocComment(lexDecl, source),
    exported,
    isDefaultExport: isDefault,
  };
}

function buildReexport(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const stmt = cap["sym.reexport"]!;
  const nameNode = cap["sym.reexport_name"];
  const aliasNode = cap["sym.reexport_alias"];
  const fromNode = cap["sym.reexport_from"];
  if (!nameNode || !fromNode) return undefined;
  const fromText = fromNode.text.slice(1, -1);
  const localName = aliasNode?.text ?? nameNode.text;
  return {
    name: localName,
    qualifiedName: localName,
    kind: "reexport",
    file,
    startLine: lineOf(stmt.startPosition.row),
    endLine: lineOf(stmt.endPosition.row),
    startByte: stmt.startIndex,
    endByte: stmt.endIndex,
    signature: oneLine(source.slice(stmt.startIndex, stmt.endIndex)),
    exported: true,
    isDefaultExport: false,
    reexport: {
      from: fromText,
      originalName: nameNode.text,
      localName,
    },
  };
}

function buildReexportStar(
  cap: CapMap,
  source: string,
  file: string,
): SourceSymbol | undefined {
  const stmt = cap["sym.reexport_star"]!;
  const fromNode = cap["sym.reexport_star_from"];
  if (!fromNode) return undefined;
  const hasClause = stmt.children.some((c) => c.type === "export_clause");
  if (hasClause) return undefined;
  const hasStar = stmt.children.some((c) => c.type === "*");
  if (!hasStar) return undefined;
  const fromText = fromNode.text.slice(1, -1);
  return {
    name: "*",
    qualifiedName: `*from:${fromText}`,
    kind: "reexport",
    file,
    startLine: lineOf(stmt.startPosition.row),
    endLine: lineOf(stmt.endPosition.row),
    startByte: stmt.startIndex,
    endByte: stmt.endIndex,
    signature: oneLine(source.slice(stmt.startIndex, stmt.endIndex)),
    exported: true,
    isDefaultExport: false,
    reexport: { from: fromText },
  };
}

// ---------- helpers ----------

function lineOf(row: number): number {
  return row + 1;
}

function isTopLevel(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (p.type === "program") return true;
  if (p.type === "export_statement" && p.parent?.type === "program") return true;
  return false;
}

function exportInfo(node: Node): { exported: boolean; isDefault: boolean } {
  const p = node.parent;
  if (!p || p.type !== "export_statement") {
    return { exported: false, isDefault: false };
  }
  let isDefault = false;
  for (const c of p.children) {
    if (c.type === "default") {
      isDefault = true;
      break;
    }
  }
  return { exported: true, isDefault };
}

function findEnclosingClassName(node: Node): string | undefined {
  let p = node.parent;
  while (p) {
    if (
      p.type === "class_declaration" ||
      p.type === "abstract_class_declaration" ||
      p.type === "class" ||
      p.type === "class_expression"
    ) {
      const nameNode = p.childForFieldName("name");
      if (nameNode) return nameNode.text;
      return "default";
    }
    p = p.parent;
  }
  return undefined;
}

function classifyMethod(node: Node): {
  kind: "method" | "getter" | "setter";
  isConstructor: boolean;
} {
  let kind: "method" | "getter" | "setter" = "method";
  let isConstructor = false;
  for (const c of node.children) {
    if (c.type === "get") kind = "getter";
    else if (c.type === "set") kind = "setter";
    else if (
      (c.type === "property_identifier" ||
        c.type === "private_property_identifier") &&
      c.text === "constructor"
    ) {
      isConstructor = true;
    }
  }
  return { kind, isConstructor };
}

function extractMethodModifiers(node: Node): SymbolModifiers {
  const mods: SymbolModifiers = {};
  for (const c of node.children) {
    switch (c.type) {
      case "async":
        mods.async = true;
        break;
      case "static":
        mods.static = true;
        break;
      case "abstract":
        mods.abstract = true;
        break;
      case "readonly":
        mods.readonly = true;
        break;
      case "accessibility_modifier":
        mods.visibility = c.text as "public" | "private" | "protected";
        break;
      case "*":
        mods.generator = true;
        break;
    }
  }
  return mods;
}

function extractFunctionModifiers(node: Node): SymbolModifiers {
  const mods: SymbolModifiers = {};
  for (const c of node.children) {
    if (c.type === "async") mods.async = true;
    else if (c.type === "abstract") mods.abstract = true;
    else if (c.type === "*") mods.generator = true;
  }
  return mods;
}

function extractSignature(declNode: Node, source: string): string {
  let end = declNode.endIndex;
  const body = declNode.childForFieldName("body");
  if (body) end = body.startIndex;
  let sig = source.slice(declNode.startIndex, end);
  sig = oneLine(sig).replace(
    /^(export\s+default\s+|export\s+|default\s+)/,
    "",
  );
  if (sig.length > 200) sig = sig.slice(0, 197) + "...";
  return sig;
}

function extractConstFunctionSignature(
  declarator: Node,
  source: string,
): string {
  const value = declarator.childForFieldName("value");
  let end = declarator.endIndex;
  if (value) {
    const body = value.childForFieldName("body");
    if (body) end = body.startIndex;
  }
  let sig = source.slice(declarator.startIndex, end);
  sig = oneLine(sig);
  if (sig.length > 200) sig = sig.slice(0, 197) + "...";
  return sig;
}

function extractConstValueSignature(
  lexDecl: Node,
  declarator: Node,
  source: string,
): string {
  const value = declarator.childForFieldName("value");
  const typeNode = declarator.childForFieldName("type");
  const end = value
    ? value.startIndex - 1
    : typeNode
      ? typeNode.endIndex
      : declarator.endIndex;
  let sig = source.slice(lexDecl.startIndex, end);
  sig = oneLine(sig).replace(/\s*=\s*$/, "");
  if (sig.length > 200) sig = sig.slice(0, 197) + "...";
  return sig;
}

function findLeadingDocComment(
  declOrWrapper: Node,
  source: string,
): string | undefined {
  let outer = declOrWrapper;
  let p = declOrWrapper.parent;
  while (p && p.type === "export_statement") {
    outer = p;
    p = p.parent;
  }
  let prev = outer.previousSibling;
  while (prev && prev.type === "decorator") {
    prev = prev.previousSibling;
  }
  const comments: Node[] = [];
  let cursorStartRow = outer.startPosition.row;
  while (prev && prev.type === "comment") {
    if (cursorStartRow - prev.endPosition.row > 2) break;
    comments.push(prev);
    cursorStartRow = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  if (comments.length === 0) return undefined;
  const top = comments[comments.length - 1]!;
  return extractFirstDocLine(source.slice(top.startIndex, top.endIndex));
}

function extractFirstDocLine(commentText: string): string | undefined {
  const stripped = commentText.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
  const lines = stripped
    .split(/\r?\n/)
    .map((l) =>
      l.replace(/^\s*\*\s?/, "").replace(/^\/\/\s?/, "").trim(),
    )
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith("@"))
    // Drop section-divider lines like "============", "----", "****", etc.
    // — common in older JS codebases as visual separators inside comments.
    .filter((l) => !/^[=\-*_+#~]{4,}$/.test(l));
  const first = lines[0];
  if (!first) return undefined;
  return first.length > 200 ? first.slice(0, 197) + "..." : first;
}

function findImportBlockEndLine(root: Node): number {
  let lastImportEndLine = 0;
  for (const c of root.children) {
    if (c.type === "import_statement") {
      lastImportEndLine = c.endPosition.row + 1;
    }
  }
  return lastImportEndLine;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Detect CommonJS export patterns by scanning source text. Tree-sitter-typescript
 * doesn't model `module.exports = X` as an export, so we extract these via regex.
 *
 * Patterns recognised:
 *   module.exports = X                          → X marked default-exported
 *   module.exports = { a, b: c, d }             → a, b, d marked exported
 *   module.exports.X = ...                      → X marked exported
 *   exports.X = ...                             → X marked exported
 *   Object.assign(module.exports, { a, b })     → a, b marked exported
 */
function detectCjsExports(source: string): CjsExports {
  const named = new Set<string>();
  let defaultName: string | undefined;

  // module.exports = <identifier>;
  const defaultRe = /\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/;
  const dm = defaultRe.exec(source);
  if (dm) defaultName = dm[1];

  // module.exports.X = ... / exports.X = ...
  const propRe = /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const m of source.matchAll(propRe)) {
    named.add(m[1]!);
  }

  // module.exports = { a, b: c, d, ... }
  const objRe = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g;
  for (const m of source.matchAll(objRe)) {
    const body = m[1]!;
    for (const k of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?:,|:|$)/g)) {
      named.add(k[1]!);
    }
  }

  // Object.assign(module.exports, { ... })
  const assignRe =
    /\bObject\.assign\s*\(\s*module\.exports\s*,\s*\{([^}]*)\}/g;
  for (const m of source.matchAll(assignRe)) {
    const body = m[1]!;
    for (const k of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?:,|:|$)/g)) {
      named.add(k[1]!);
    }
  }

  return { named, defaultName };
}

function applyCjsExports(symbols: SourceSymbol[], cjs: CjsExports): void {
  for (const sym of symbols) {
    if (sym.kind === "method" || sym.kind === "getter" || sym.kind === "setter") {
      continue; // class members inherit export-ness from the class
    }
    if (cjs.named.has(sym.name)) sym.exported = true;
    if (cjs.defaultName && sym.name === cjs.defaultName) {
      sym.exported = true;
      sym.isDefaultExport = true;
    }
  }
}

function fallbackIndex(
  absPath: string,
  relPath: string,
  language: LangKind,
  mtimeMs: number,
  source: string,
  error: string,
): FileIndex {
  const snippet = oneLine(source.slice(0, 200));
  const lineCount = source.split(/\r?\n/).length;
  const sym: SourceSymbol = {
    name: relPath.split("/").pop() ?? relPath,
    qualifiedName: relPath,
    kind: "const",
    file: relPath,
    startLine: 1,
    endLine: Math.max(1, Math.min(1, lineCount)),
    startByte: 0,
    endByte: Math.min(source.length, 200),
    signature: snippet,
    exported: false,
    isDefaultExport: false,
  };
  return {
    path: relPath,
    absPath,
    mtimeMs,
    language,
    symbols: [sym],
    importBlockEndLine: 0,
    parseError: error,
  };
}
