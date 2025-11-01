# Validation run 20251007T184620Z

This directory captures the artefacts for the MCP validation and improvement campaign.

## Structure

- `inputs/` — JSON payloads sent to the server for each tool invocation.
- `outputs/` — Raw JSON responses captured verbatim from the server.
- `events/` — Event stream dumps stored as JSON Lines.
- `logs/` — Timestamped execution logs for the harness and server.
- `resources/` — Snapshots of resources read during validation.
- `report/` — Human-readable and machine-readable summaries.
- `lib/` — Reusable utilities specific to this validation run.
- `tests/` — Focused automated checks covering the validation utilities.

## Planned workflow

1. Bootstrap the run context and trace identifier generator.
2. Connect to the MCP server and enumerate available tools.
3. Execute each checklist stage while recording structured artefacts.
   - Stage 1 focuses on introspection (`lib/introspection.ts`).
   - Stage 2 introduces deterministic smoke tests for graph-centric tools (`lib/baseTools.ts`).
   - Stage 3 validates transactions, graph diff/patch flows, cooperative locks and idempotency (`lib/transactions.ts`).
4. Generate the final report deliverables under `report/`.

Each stage of the workflow maps directly to the checklist maintained in `AGENTS.md`.
