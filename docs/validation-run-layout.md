# Validation run filesystem layout

This document summarises the helper introduced in `src/validationRun/layout.ts` and its
expected usage when executing the validation scenarios described in `AGENTS.md`.

## Purpose

The validation workflow must guarantee that every artefact — logs, per-scenario runs,
metrics, snapshots, and final reports — resides under the repository-level
`validation_run/` folder. Centralising the data:

- simplifies archiving and post-mortem analysis,
- ensures scripts never pollute legacy `runs/` directories,
- keeps environment variable expectations explicit and reproducible.

## Helper API

The module exposes two functions:

- `ensureValidationRunLayout(baseRoot?: string)` creates the mandatory directory
  structure. It is idempotent and safe to call before each scenario.
- `computeValidationRunEnv(layout)` returns the environment variables required by
  the orchestrator (`MCP_RUNS_ROOT`, `MCP_LOG_FILE`, rotation hints).

Section 1 of the checklist also requires snapshotting the runtime environment. The
companion module `src/validationRun/snapshots.ts` builds on the layout helper to
persist:

- `versions.txt` (Node/npm versions),
- `git.txt` (current commit or `N/A`),
- `.env.effective` (sanitised MCP/SEARCH/UNSTRUCTURED variables),
- `searxng_probe.txt` and `unstructured_probe.txt` (lightweight reachability checks).

Operators can trigger the snapshot capture via the CLI:

```bash
npm run validation:snapshots
```

The command logs every generated file relative to the repository root so the next
validation phase can reference them immediately.

Both helpers are written in strict TypeScript, avoid exposing `undefined`, and include
comments detailing the intent of each exported field so future contributors can extend
the layout without breaking existing workflows.

## Recommended usage

1. Call `ensureValidationRunLayout()` during startup to guarantee the folders exist.
2. Merge `computeValidationRunEnv()` into the process environment before spawning the
   orchestrator or HTTP server.
3. Store scenario-specific artefacts under `validation_run/runs/<scenario>/` following
   the naming scheme described in the checklist.

## Scenario scaffolding helper

To reduce operator toil when preparing section 4 of the checklist, the module
`src/validationRun/scenario.ts` exposes `initialiseScenarioRun` and
`initialiseAllScenarios`. They create (if needed) the canonical directories such
as `validation_run/runs/S01_pdf_science/` and pre-populate every required file:

- `input.json` receives the official payload defined in `AGENTS.md`,
- `response.json`, `events.ndjson`, `timings.json`, `errors.json`,
  `kg_changes.ndjson`, `vector_upserts.json`, and `server.log` are touched so the
  execution team immediately knows where to collect artefacts.

Bootstrap all scenarios with:

```bash
npm run validation:scenarios
```

The command prints the relative paths for each scenario and re-applies the
recommended MCP log environment variables, mirroring the snapshot CLI.

### Preparing reruns

When a scenario requires a remediation pass (section 7 of the checklist), the
same CLI can materialise additional folders without touching the base runs. The
utility auto-increments rerun suffixes so repeated invocations remain ordered:

```bash
npm run validation:scenarios -- --rerun S05 --rerun S05:rerun2
```

- `--rerun <reference>` accepts `S0X`, the numeric id (`5`), or the canonical
  slug (`S05_idempotence`).
- When no suffix is provided, the script picks the next available `rerunN` based
  on the folders present on disk.
- Pass `--no-base` to skip re-creating the ten canonical scenario folders when
  only reruns need to be updated.

By following these steps we satisfy the "conditions réelles" validation campaign
requirements and keep observability assets neatly organised inside `validation_run/`.
