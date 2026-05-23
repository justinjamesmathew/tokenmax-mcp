import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const req = createRequire(import.meta.url);

await Parser.init();
const candidates = [
  "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  "@sourcegraph/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
];
for (const path of candidates) {
  try {
    const p = req.resolve(path);
    const lang = await Parser.Language.load(p);
    console.log(`OK: ${path} (version=${lang.version})`);
  } catch (e) {
    console.log(`FAIL: ${path} -> ${(e?.message ?? e).toString().split("\n")[0]}`);
  }
}
