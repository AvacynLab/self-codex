import readline from "node:readline";

/**
 * Minimal child runner that acknowledges readiness but ignores every incoming
 * payload. The orchestrator uses it to exercise timeout handling code paths
 * without relying on artificial sleeps or external processes.
 */
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const emit = (payload: { type: string; [key: string]: unknown }): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

emit({ type: "ready", mode: "silent", pid: process.pid });

rl.on("line", (line: string) => {
  if (!line.trim()) {
    return;
  }

  // Attempt to parse JSON payloads purely to mimic the behaviour of the other
  // fixtures. Any parsing error is surfaced so the orchestrator can observe the
  // failure even though no response will ever be emitted.
  try {
    JSON.parse(line);
  } catch (error) {
    emit({
      type: "error",
      message: "invalid-json",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

// Keep the process alive so the orchestrator is forced to rely on timeouts.
setInterval(() => {
  emit({ type: "heartbeat", ts: Date.now() });
}, 5000).unref();

