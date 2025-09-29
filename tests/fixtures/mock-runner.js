#!/usr/bin/env node
import readline from "node:readline";

process.stdin.setEncoding("utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let counter = 0;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

emit({ type: "ready", pid: process.pid, argv: process.argv.slice(2) });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    emit({ type: "error", message: "invalid-json", raw: trimmed });
    return;
  }

  counter += 1;

  if (payload.type === "prompt") {
    emit({ type: "response", id: counter, content: payload.content ?? null });
    return;
  }

  if (payload.type === "ping") {
    emit({ type: "pong", id: counter, ts: Date.now() });
    return;
  }

  emit({ type: "echo", id: counter, payload });
});

const graceful = (signal) => {
  emit({ type: "shutdown", signal });
  rl.close();
  process.exit(0);
};

process.on("SIGINT", () => graceful("SIGINT"));
process.on("SIGTERM", () => graceful("SIGTERM"));

rl.on("close", () => {
  emit({ type: "closed" });
});
