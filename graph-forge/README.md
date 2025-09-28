# Graph Forge DSL

Graph Forge is a TypeScript reference implementation of a lightweight domain-specific language for describing weighted directed graphs with metadata and requested analyses. The toolchain lexes, parses, and compiles `.gf` scripts into an immutable in-memory model, then executes algorithms such as shortest path, strongly connected components, and critical path.

## DSL at a glance

```
// pipeline.gf

graph Pipeline {
  directive format table;
  directive allowCycles false;

  node Ingest    { label: "Data intake" }
  node Transform { label: "Normalize" cost: 3 }
  node Store     { label: "Persist" cost: 4 }

  edge Ingest -> Transform { weight: 1 }
  edge Transform -> Store  { weight: 2, channel: "s3" }

  @analysis shortestPath Ingest Store;
  @analysis criticalPath;
}
```

See `src/lexer.ts` and `src/parser.ts` for the grammar and AST, and `src/cli.ts` for the command-line entry point.

## Folder structure

- `src/lexer.ts` — Tokenizer that produces rich tokens with location tracking
- `src/parser.ts` — Recursive descent parser generating an abstract syntax tree
- `src/model.ts` — Immutable runtime graph representation and helpers
- `src/compiler.ts` — Validates ASTs and builds runtime models
- `src/algorithms/` — Graph algorithms (Dijkstra, Tarjan SCC, critical path)
- `src/cli.ts` — CLI interface to parse `.gf` files and run analyses
- `test/` — Focused unit tests for tokenizer, parser, and algorithms

## Usage (development)

```
# Compile TS to JS (reuses repository TypeScript config)
npm run build

# Execute the CLI via ts-node
ts-node graph-forge/src/cli.ts examples/pipeline.gf --analysis shortestPath Ingest Store
```

The CLI can emit JSON or human-readable summaries depending on flags. For more examples inspect the fixtures under `graph-forge/examples` (planned extension).
