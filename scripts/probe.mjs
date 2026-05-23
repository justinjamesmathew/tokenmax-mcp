import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const req = createRequire(import.meta.url);

await Parser.init();
const langTs = await Language.load(
  req.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm"),
);
const langTsx = await Language.load(
  req.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm"),
);

const samples = {
  "abstract class": `abstract class Foo { abstract bar(): void; }`,
  "default class anon": `export default class { bar() {} }`,
  "default class named": `export default class Foo { bar() {} }`,
  "default function anon": `export default function() {}`,
  "default function named": `export default function foo() {}`,
  "namespace": `namespace Foo { export const x = 1; }`,
  "decorator class": `@Component()\nclass Foo { @log bar() {} }`,
  "arrow const exported": `export const f = (x: number): number => x + 1;`,
  "object method": `const o = { foo() { return 1; } };`,
  "type alias generic": `type Pair<A, B> = { a: A; b: B };`,
  "interface generic": `interface Box<T> { value: T; }`,
  "enum": `enum Color { Red, Green, Blue }`,
  "reexport named": `export { Foo, Bar as Baz } from "./other";`,
  "reexport star": `export * from "./other";`,
  "static method": `class C { static foo(): void {} async bar() {} private baz = 1; }`,
  "getter setter": `class C { get x() { return 1; } set x(v: number) {} }`,
  "jsx function": `function Comp(props: { name: string }) { return <div>{props.name}</div>; }`,
  "jsx arrow": `const Comp = (props: { name: string }) => <div>{props.name}</div>;`,
};

function dump(name, lang, code) {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(code);
  console.log(`\n=== ${name} ===`);
  console.log(tree.rootNode.toString());
}

for (const [name, code] of Object.entries(samples)) {
  const useTsx = name.startsWith("jsx") || name.startsWith("decorator");
  dump(name, useTsx ? langTsx : langTs, code);
}
