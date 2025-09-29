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

emit({ type: "ready", mode: "stubborn", pid: process.pid });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    emit({ type: "error", message: "invalid-json", raw: trimmed });
    return;
  }

  counter += 1;
  emit({ type: "ack", id: counter, payload });
});

const ignoreSignal = (signal) => {
  emit({ type: "signal", signal });
};

process.on("SIGINT", () => ignoreSignal("SIGINT"));
process.on("SIGTERM", () => ignoreSignal("SIGTERM"));

const timer = setInterval(() => {
  emit({ type: "tick", ts: Date.now() });
}, 2000);

rl.on("close", () => {
  clearInterval(timer);
});
