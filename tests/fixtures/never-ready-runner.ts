/**
 * Fixture that purposefully withholds the ready handshake so the orchestrator
 * must rely on timeout paths. The process keeps the event loop alive and exits
 * cleanly when it receives a termination signal, mirroring a misbehaving
 * runtime that spawned successfully but never advertised readiness.
 */

// Keep stdin open so the parent can deliver signals while preventing the
// process from exiting on its own.
process.stdin.resume();

// Periodically tick to keep the event loop active without emitting protocol
// messages. The payload mirrors the JSON structure used by other fixtures so
// debugging remains familiar when the logs are inspected.
setInterval(() => {
  process.stdout.write(`${JSON.stringify({ type: "heartbeat", pid: process.pid })}\n`);
}, 2000);

const shutdown = (): void => {
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

