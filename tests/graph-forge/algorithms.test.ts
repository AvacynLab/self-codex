import { strict as assert } from "node:assert";

import { describe, it } from "mocha";

import { compileSource } from "../../graph-forge/src/compiler.ts";
import { criticalPath } from "../../graph-forge/src/algorithms/criticalPath.ts";
import { shortestPath } from "../../graph-forge/src/algorithms/dijkstra.ts";
import { tarjanScc } from "../../graph-forge/src/algorithms/tarjan.ts";

/**
 * Suite de tests dédiée aux algorithmes de Graph Forge.  Nous validons ici les
 * invariants essentiels de l'outil DSL embarqué :
 *
 * - `shortestPath` doit conserver la distance minimale et la séquence de
 *   nœuds optimale.
 * - `tarjanScc` garantit que les composantes fortement connexes sont détectées
 *   sans dupliquer les sommets.
 * - `criticalPath` retourne la chaîne la plus longue afin de piloter
 *   correctement les analyses de dépendances.
 *
 * Chaque test réutilise un graphe miniature produit par `compileSource` afin de
 * couvrir l'intégration complète du compilateur DSL jusqu'aux algorithmes.
 */
describe("graph-forge algorithms", () => {
  const sample = `graph Flow {
  node Start
  node Middle
  node End

  edge Start -> Middle { weight: 2 }
  edge Middle -> End { weight: 3 }
  edge Start -> End { weight: 10 }
}`;
  // Scénario dédié au chemin critique où l'arête directe est plus courte que
  // la chaîne intermédiaire afin de vérifier que l'algorithme explore toutes
  // les branches avant de retenir le résultat le plus long.
  const criticalSample = `graph Critical {
  node Start
  node Middle
  node End

  edge Start -> Middle { weight: 5 }
  edge Middle -> End { weight: 4 }
  edge Start -> End { weight: 3 }
}`;

  it("finds the optimal shortest path", () => {
    const { graph } = compileSource(sample);
    const result = shortestPath(graph, "Start", "End");

    assert.equal(result.distance, 5, "distance minimale Start → End incorrecte");
    assert.deepEqual(
      result.path,
      ["Start", "Middle", "End"],
      "chemin optimal attendu pour le graphe Flow",
    );
  });

  it("detects strongly connected components", () => {
    const { graph } = compileSource(sample);
    const components = tarjanScc(graph);

    assert.ok(
      components.some((component) => component.length === 1 && component[0] === "Start"),
      "la racine 'Start' doit apparaître comme composante isolée",
    );
  });

  it("computes the critical path length", () => {
    const { graph } = compileSource(criticalSample);
    const result = criticalPath(graph);

    assert.equal(result.length, 9, "la longueur cumulée doit valoir 9");
    assert.deepEqual(
      result.path,
      ["Start", "Middle", "End"],
      "le chemin critique doit suivre Start → Middle → End",
    );
  });
});

