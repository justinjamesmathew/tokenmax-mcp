import { runCli } from "./cli.js";

runCli(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `[codemap] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
