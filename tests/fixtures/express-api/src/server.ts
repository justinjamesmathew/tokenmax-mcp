import express, { type Express, type Request, type Response } from "express";
import { usersRouter } from "./routes/users.js";

export interface ServerOptions {
  port: number;
  host?: string;
}

/**
 * Build a configured Express app.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.use("/users", usersRouter);
  return app;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve) => {
    app.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve());
  });
}

export const DEFAULT_PORT = 3000;
