# Validation run execution helper

The `validation:scenario:run` script automates the execution of the validation
scenarios defined in the checklist. It bootstraps the validation layout, runs
the web search pipeline with full observability, and persists the required
artefacts under `validation_run/`. Scenario S10 (Qualité RAG) is now orchestrated
automatically by aggregating the knowledge graph/vector artefacts produced by
S01→S09 and issuing a RAG-assisted knowledge query.

## Supported scenarios

Scenarios S01 to S09 rely on the Searx → fetch → extraction pipeline and are
executed end-to-end. Scenario S10 (Qualité RAG) consumes the artefacts generated
by previous runs to answer a knowledge question without performing new web
fetches. The helper aggregates the captured triples/vectors, executes the
knowledge assist pipeline, and records the answer with citations.

## Usage

```bash
npm run validation:scenario:run -- --scenario 1
```

### Arguments

| Flag | Description |
| ---- | ----------- |
| `-s`, `--scenario <id>` | Scenario identifier (`1` → `S01_pdf_science`, ..., `10` → `S10_qualite_rag`). |
| `-j`, `--job <id>` | Optional custom job identifier forwarded to the search pipeline. |
| `-r`, `--root <path>` | Overrides the default `validation_run/` root (useful for sandboxes). |
| `--no-artifacts` | Skips the auxiliary dumps stored under `validation_run/artifacts/`. |
| `--artifacts` | Forces artefact dumps (default). |
| `-h`, `--help` | Displays the usage banner. |

Any positional argument that is not attached to a flag is treated as the
scenario identifier, making `npm run validation:scenario:run -- 3` equivalent to
`--scenario 3`.

## Persisted artefacts

For each run the script writes the canonical artefacts into
`validation_run/runs/SXX_*` via `recordScenarioRun`:

- `input.json` (canonical payload)
- `response.json` (search or RAG result summary, stats, metrics)
- `events.ndjson` (job-specific events captured from the in-memory store)
- `timings.json` (auto-generated timing report built from the events — empty for S10)
- `errors.json` (structured taxonomy of pipeline errors)
- `kg_changes.ndjson` (knowledge graph inserts/updates, one triple per line)
- `vector_upserts.json` (vector chunk metadata)
- `server.log` (extrait automatique du journal `self-codex.log` autour du job)

When artefact dumps are enabled (default), additional files are materialised in
`validation_run/artifacts/SXX_*`:

- `knowledge_graph.json` – full export of the in-memory knowledge graph (for S10 this contains the aggregated triples)
- `documents_summary.json` – metadata for every structured document produced
- `knowledge_summary.json` – per-document triple counts and mentions
- `vector_chunks.json` – per-chunk metadata (token count, tags, provenance). For S10 this reflects the aggregated index.
- `response_summary.json` – copy of the structured response for quick browsing
- `timing_notes.json` – optional list of diagnostics emitted by the timing
  aggregation

The vector index backing the run is persisted under
`validation_run/artifacts/SXX_*/vector_index/` so that replays can reuse the
stored embeddings.

## Exit status and logging

On success the script prints a concise summary containing the job identifier,
requested/received result counts, ingestion counters, document coverage and the
location of the persisted artefacts. Timing diagnostics (when any) are surfaced
as warnings to help operators inspect missing metrics before generating the
final report.

Failures bubble up the underlying error message and return a non-zero exit code
so the command can be chained in larger automation scripts.
