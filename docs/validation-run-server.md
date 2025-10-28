# Validation run – server orchestration

The validation checklist requires running the MCP server in HTTP mode with a
precise set of environment variables and log destinations. This document
explains how to use the automation provided in `scripts/startValidationServer.ts`
and highlights the information captured for the audit trail.

## Summary

The helper exported by `src/validationRun/server.ts`:

- prepares the validation layout (including the optional `children/` workspace),
- merges the mandatory MCP logging environment variables with the recommended
  HTTP settings (`START_HTTP=1`, `MCP_HTTP_JSON=on`, etc.),
- spawns the server command (defaults to `npm run start:http`) while streaming
  stdout/stderr into `validation_run/logs/validation-server.log`, and
- polls the `/health` endpoint until it responds successfully, retrying up to
  fifteen times by default.

The accompanying CLI (`npm run validation:server`) wraps the helper with a
friendly operator experience: it prints the resolved MCP environment, keeps the
process in the foreground, and reacts to `SIGINT`/`SIGTERM` by issuing a graceful
shutdown.

## Usage

```bash
npm run validation:server
```

The command accepts the following optional environment variables:

- `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH` – override the default HTTP
  binding (`127.0.0.1:8765` and `/mcp`).
- `MCP_HTTP_TOKEN` – reuse an existing token instead of letting the script
  generate a random hexadecimal secret.
- Standard search/Unstructured variables are untouched and continue to be
  validated by `npm run validation:runtime`.

When the server becomes healthy you will see output similar to:

```
✔ Validation server running.
  PID: 12345
  Logs: /repo/validation_run/logs/validation-server.log
  Health: http://127.0.0.1:8765/mcp/health
  MCP_RUNS_ROOT=/repo/validation_run
  MCP_HTTP_TOKEN=...
Press Ctrl+C to stop the server.
```

Hitting `Ctrl+C` (or sending `SIGTERM`) triggers a graceful `SIGTERM` followed by
`SIGKILL` if the process refuses to exit within five seconds. All shutdown
attempts are recorded inside the log file.

## Log location

Every execution appends to `validation_run/logs/validation-server.log`. The log
contains:

- a header with the command, MCP host/port/path and token status,
- interleaved `[stdout]` / `[stderr]` entries,
- readiness probe results (`[health] attempt ...`), and
- explicit stop markers when the helper terminates the process.

This structure matches the requirements listed in `AGENTS.md` and keeps the
validation artefacts centralised under `validation_run/`.

## Integration in the checklist

1. Run `npm run validation:build` to produce the compiled server.
2. Execute `npm run validation:runtime` to validate the environment and third
   party services.
3. Start the server with `npm run validation:server` and keep it in the
   foreground while executing the scenarios.
4. Once all runs are captured, stop the server (`Ctrl+C`) and continue with the
   artefact collection (`npm run validation:report`, `npm run validation:audit`,
   etc.).

The readiness polling ensures that subsequent steps (scenario playback, metric
collection) only start once the MCP endpoint answers with the expected status
code.
