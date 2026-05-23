import { startServer } from "./server.js";

startServer().catch((err) => {
  process.stderr.write(
    `[repo-context-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
