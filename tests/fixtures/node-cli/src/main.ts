import { parseArgs } from "node:util";
import { run } from "./commands.js";

/** CLI entry point. */
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });
  return run(positionals, !!values.verbose);
}

export const VERSION = "0.1.0";
