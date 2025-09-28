// Example pipeline graph

graph Pipeline {
  directive format table;
  directive allowCycles false;

  node Ingest { label: "Data intake" }
  node Transform { label: "Normalize" cost: 3 }
  node Store { label: "Persist" cost: 4 }

  edge Ingest -> Transform { weight: 1 }
  edge Transform -> Store { weight: 2, channel: "s3" }
  edge Ingest -> Store { weight: 5 }

  @analysis shortestPath Ingest Store;
  @analysis criticalPath;
  @analysis stronglyConnected;
}
