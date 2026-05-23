export interface CommandContext {
  verbose: boolean;
  cwd: string;
}

export async function run(args: string[], verbose: boolean): Promise<number> {
  const ctx: CommandContext = { verbose, cwd: process.cwd() };
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "build":
      return new BuildCommand(ctx).execute(rest);
    case "test":
      return new TestCommand(ctx).execute(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      return 1;
  }
}

abstract class BaseCommand {
  protected ctx: CommandContext;
  constructor(ctx: CommandContext) {
    this.ctx = ctx;
  }
  abstract execute(args: string[]): Promise<number>;
}

export class BuildCommand extends BaseCommand {
  async execute(_args: string[]): Promise<number> {
    if (this.ctx.verbose) process.stderr.write("building...\n");
    return 0;
  }
}

export class TestCommand extends BaseCommand {
  async execute(_args: string[]): Promise<number> {
    if (this.ctx.verbose) process.stderr.write("testing...\n");
    return 0;
  }
}
