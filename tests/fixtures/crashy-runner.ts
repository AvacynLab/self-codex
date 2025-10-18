import readline from "node:readline";

/**
 * Minimal child runner used by robustness tests to simulate a sudden crash.
 *
 * The script advertises a ready message, echoes deterministic acknowledgements
 * for regular prompts, and terminates with the requested exit code when it
 * receives an `explode` command. The shutdown path mirrors how a flaky model
 * runner might disappear while leaving the orchestrator in charge of cleaning
 * the workspace and recovering the plan.
 */
interface ExplodeCommand {
  readonly type: "explode";
  readonly exitCode?: number;
  readonly reason?: string;
}

type CrashyCommand =
  | { readonly type: "prompt"; readonly content?: unknown }
  | ExplodeCommand
  | { readonly type: string; readonly [key: string]: unknown };

process.stdin.setEncoding("utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let counter = 0;

const emit = (payload: { type: string; [key: string]: unknown }): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

emit({ type: "ready", mode: "crashy", pid: process.pid });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let payload: CrashyCommand;
  try {
    payload = JSON.parse(trimmed) as CrashyCommand;
  } catch (error) {
    emit({
      type: "error",
      message: "invalid-json",
      raw: trimmed,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  counter += 1;

  if (payload.type === "prompt") {
    emit({ type: "response", id: counter, echo: payload.content ?? null });
    return;
  }

  if (payload.type === "explode") {
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : 1;
    const reason = payload.reason ?? "forced-crash";
    emit({ type: "fatal", id: counter, reason });
    // Allow stdout to flush before the process terminates.
    setImmediate(() => {
      process.exit(exitCode);
    });
    return;
  }

  emit({ type: "event", id: counter, payload });
});

const graceful = (signal: NodeJS.Signals | string): void => {
  emit({ type: "shutdown", signal });
  rl.close();
  process.exit(0);
};

process.on("SIGINT", () => graceful("SIGINT"));
process.on("SIGTERM", () => graceful("SIGTERM"));

rl.on("close", () => {
  emit({ type: "closed" });
});

