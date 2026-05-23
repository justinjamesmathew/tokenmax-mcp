import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex } from "../src/indexer.js";
import {
  derivePurposeFromPackageJson,
  generateCodemap,
} from "../src/codemap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (n: string): string => path.join(here, "fixtures", n);

describe("codemap generator", () => {
  it("emits a compact map for the react-app fixture", async () => {
    const root = fixtures("react-app");
    const index = await buildIndex(root);
    const md = await generateCodemap({
      slug: "react-app",
      repoRoot: root,
      index,
      purpose: "Test fixture for the codemap generator.",
      tech: "React / TypeScript",
    });

    expect(md).toContain("# CODEMAP: react-app");
    expect(md).toContain("React / TypeScript");
    expect(md).toContain("Test fixture for the codemap generator.");
    expect(md).toContain("interface GreetingProps");
    expect(md).toContain("function Greeting");
    expect(md).toContain("class Formatter");
    // Public methods of Formatter should be listed.
    expect(md).toContain("greet()");
    expect(md).toContain("for()");
    // The constructor should NOT be in the public listing.
    expect(md).not.toContain("constructor()");
    // Line numbers should NOT appear in the elaborated-but-curated map
    // (drift-fast info — reserved for the tool).
    expect(md).not.toMatch(/L\d+/);
    expect(md).not.toMatch(/\[\d+(?:-\d+)?\]/);
  });

  it("stays under 5KB for a small fixture (cheap to inline)", async () => {
    const root = fixtures("react-app");
    const index = await buildIndex(root);
    const md = await generateCodemap({
      slug: "react-app",
      repoRoot: root,
      index,
    });
    // Loose ceiling; the actual size for a 3-file fixture should be ~1KB.
    expect(md.length).toBeLessThan(5000);
  });

  it("includes user-supplied conventions verbatim", async () => {
    const root = fixtures("react-app");
    const index = await buildIndex(root);
    const md = await generateCodemap({
      slug: "react-app",
      repoRoot: root,
      index,
      conventions:
        "- All exports use named-export form (no default exports).\n- Tests use Vitest and live next to source.",
    });
    expect(md).toContain("named-export form");
    expect(md).toContain("Vitest");
  });
});

describe("derivePurposeFromPackageJson", () => {
  it("returns empty when package.json is absent", async () => {
    const r = await derivePurposeFromPackageJson(fixtures("react-app"));
    // The fixture has no package.json; we accept either undefined or {} shape.
    expect(r.purpose).toBeUndefined();
  });
});
