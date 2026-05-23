import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const req = createRequire(import.meta.url);
await Parser.init();
const lang = await Parser.Language.load(
  req.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm"),
);

// Enumerate node type names containing "function" or "class" etc
const target = ["function", "class", "method", "arrow", "abstract", "decorator", "lexical", "variable"];
const found = [];
for (let i = 0; i < lang.nodeTypeCount; i++) {
  const n = lang.nodeTypeForId(i);
  if (n && target.some((t) => n.includes(t))) {
    found.push(`${i}: ${n} (named=${lang.nodeTypeIsNamed(i)})`);
  }
}
console.log(found.join("\n"));

console.log("\n--- parse + dump anonymous fn ---");
const parser = new Parser();
parser.setLanguage(lang);
const code = `const f = function() {}; const g = function*() {}; const h = async function() {};`;
const tree = parser.parse(code);
console.log(tree.rootNode.toString());
