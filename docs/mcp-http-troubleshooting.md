# MCP HTTP troubleshooting guide

This note explains how to confirm that the HTTP transport of the self-fork orchestrator is up, which environment variables drive its configuration, and where the structured logs are written.

## Quick checklist

1. Start the orchestrator with HTTP enabled (for example `npm run start:http` or via `scripts/setup-agent-env.sh` with `START_HTTP=1`).
2. Inspect the latest file in `runs/` (named `http-<timestamp>.log`) to ensure the `http_listening` event reports the expected host, port, and path.
3. Tail the structured journal under `runs/logs/server/orchestrator.jsonl` for deeper diagnostics.
4. Query the endpoint with a bearer token that matches `MCP_HTTP_TOKEN`.

## Log files

When the helper script is asked to boot the HTTP endpoint (`START_HTTP=1`), it writes stdout/stderr to `runs/http-<date>.log`, creating the directory on demand. 【F:scripts/setup-agent-env.sh†L56-L87】

Every server instance also streams structured entries to the journal `runs/logs/server/orchestrator.jsonl`, making it easy to track lifecycle events and warnings with external tooling. 【F:runs/logs/server/orchestrator.jsonl†L1-L6】

A healthy launch includes a `http_listening` record, which confirms that the orchestrator bound to the advertised address. 【F:runs/http-20251012-225314.log†L1-L6】

## Configuration knobs

The HTTP service inherits its options from environment variables. During tests, the harness seeds sensible defaults (host `127.0.0.1`, port `8765`, path `/mcp`, JSON mode enabled, stateless replies, and a placeholder bearer token `test-token`). 【F:tests/setup.ts†L45-L65】

At runtime, the logger honours the `MCP_LOG_*` settings so that operators can redirect the log file, configure rotation, and enable redaction. 【F:src/server.ts†L647-L752】

The HTTP listener emits `http_listening` once `http.Server.listen` resolves, and it rejects requests whose `Authorization` header does not match `MCP_HTTP_TOKEN`, returning a 401. 【F:src/httpServer.ts†L60-L140】

## Verifying connectivity

Export a token that matches the server configuration, then probe the endpoint:

```bash
export MCP_HTTP_TOKEN="test-token"
curl -H "Authorization: Bearer ${MCP_HTTP_TOKEN}" \
  "http://127.0.0.1:8765/mcp" | head
```

If the request fails, cross-check `runs/http-*.log` and `runs/logs/server/orchestrator.jsonl` for `http_server_error` or `http_request_failure` entries, and make sure another process is not already bound to the requested port. 【F:runs/http-20251012-225314.log†L1-L6】【F:runs/logs/server/orchestrator.jsonl†L1-L6】
