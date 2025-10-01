# Exports disponibles

- [demo_graph.json](../exports/demo_graph.json) — structure sérialisée (nœuds, arêtes, attributs).
- [demo_graph.mmd](../exports/demo_graph.mmd) — diagramme Mermaid (prévisualisation locale via un éditeur Markdown compatible ou `npm run build` suivi d'un rendu avec `node_modules/.bin/mmdc` si disponible).
- [demo_graph.dot](../exports/demo_graph.dot) — graphviz DOT (rendu hors-ligne avec `dot -Tpng exports/demo_graph.dot -O` depuis `playground_codex_demo/`).
- [dashboard_heatmap.json](../logs/dashboard_heatmap.json) — projection JSON du dashboard (peut être importée dans un tableur ou Grafana).

