# Changesets workflow

This repository uses [Changesets](https://github.com/changesets/changesets) to track
contract changes for the MCP façade surface. Every entry **must** declare the
impact using the `patch`, `minor`, or `major` (BREAKING) labels so downstream
agents can reason about upgrades. Run:

```bash
npm run changeset
```

to start an interactive prompt that creates a markdown file under
`.changeset/`. Document the affected façades, call out any protocol changes, and
link follow-up validation evidence when relevant.
