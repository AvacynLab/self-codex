# Changelog

## 2025-11-02

### feature: search llm searxng
- Documented the search module architecture, configuration, and operations runbook in `docs/search-module.md`.
- Captured the introduction of the SearxNG-backed search pipeline, MCP façades, and dashboard telemetry.

### improvement: search robustness (URL canonicalization, MIME sniff, conditional GET, NFC); validation folder unified
- Documented canonicalisation, MIME sniffing, and conditional revalidation in the search runbook alongside the unified
  `validation_run/` layout expectations.
- Added an automated migration for legacy `validation_runs/` directories with regression tests to ensure stale folders are
  removed after consolidation.
