import readline from "node:readline";

process.stdin.setEncoding("utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let counter = 0;

const emit = (payload: { type: string; [key: string]: unknown }): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

emit({ type: "ready", mode: "stubborn", pid: process.pid });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let payload: Record<string, unknown> & { type?: string };
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown> & { type?: string };
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
  emit({ type: "ack", id: counter, payload });
});

const ignoreSignal = (signal: NodeJS.Signals | string): void => {
  emit({ type: "signal", signal });
};

process.on("SIGINT", () => ignoreSignal("SIGINT"));
process.on("SIGTERM", () => ignoreSignal("SIGTERM"));

// Keep a periodic heartbeat so the process remains alive even if STDIN closes.
//
// Node.js 22 started closing readline interfaces after SIGTERM which cleared the
// interval below and allowed the process to exit gracefully. The child runtime
// tests expect this runner to ignore graceful shutdown signals so the parent is
// forced to escalate to SIGKILL. By intentionally leaving the interval running
// we guarantee the event loop stays active, making the child stubborn across
// the supported Node.js versions.
setInterval(() => {
  emit({ type: "tick", ts: Date.now() });
}, 2000);

