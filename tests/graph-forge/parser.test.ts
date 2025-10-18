import { strict as assert } from "node:assert";

import { describe, it } from "mocha";

import { compileSource } from "../../graph-forge/src/compiler.ts";
import { parse } from "../../graph-forge/src/parser.ts";

/**
 * Vérifie que le parseur DSL expose un AST cohérent et que la phase de
 * compilation accepte les structures produites.  Nous couvrons deux points :
 *
 * 1. `parseSource` doit renvoyer les nœuds et arêtes attendus à partir d'un DSL
 *    minimal.
 * 2. `compileSource` ne doit pas lancer d'exception sur le même DSL — il doit
 *    renvoyer un graphe opérationnel et des métadonnées d'analyse.
 */
describe("graph-forge parser", () => {
  const sample = `graph Flow {
  node Start
  node End

  edge Start -> End { weight: 1 }
}`;

  it("returns the expected AST structure", () => {
    const ast = parse(sample);

    assert.equal(ast.graphs.length, 1, "un unique graphe doit être détecté");
    const graph = ast.graphs[0];
    assert.equal(graph.name, "Flow", "le nom du graphe doit être conservé");
    assert.deepEqual(
      graph.nodes.map((node) => node.name),
      ["Start", "End"],
      "les nœuds Start/End doivent être présents",
    );
    assert.deepEqual(
      graph.edges.map((edge) => [edge.from, edge.to]),
      [["Start", "End"]],
      "l'arête Start → End doit être générée",
    );
  });

  it("compiles the DSL without throwing", () => {
    const { graph, analyses } = compileSource(sample);

    assert.equal(graph.nodes.size, 2, "le graphe compilé doit contenir deux nœuds");
    assert.equal(graph.listEdges().length, 1, "un unique arc est attendu");
    assert.equal(analyses.length, 0, "aucune analyse n'est déclarée dans ce DSL minimal");
  });
});

