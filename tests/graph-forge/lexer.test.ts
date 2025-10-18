import { strict as assert } from "node:assert";

import { describe, it } from "mocha";

import { Lexer, TokenType } from "../../graph-forge/src/lexer.ts";

/**
 * S'assure que le lexer convertit correctement un DSL minimal en séquence de
 * tokens et que les métadonnées (positions, catégories) correspondent à nos
 * attentes.  Ces vérifications détectent rapidement les régressions dues à une
 * évolution du langage Graph Forge.
 */
describe("graph-forge lexer", () => {
  const sample = `graph Flow {
  node Start
  edge Start -> Start
}`;

  it("emits the expected token categories", () => {
    const tokens = new Lexer(sample).scanTokens();

    assert.deepEqual(
      tokens.map((token) => token.type),
      [
        TokenType.Graph,
        TokenType.Identifier,
        TokenType.LBrace,
        TokenType.Node,
        TokenType.Identifier,
        TokenType.Edge,
        TokenType.Identifier,
        TokenType.Arrow,
        TokenType.Identifier,
        TokenType.RBrace,
        TokenType.EOF,
      ],
      "la suite de catégories lexicales doit rester stable",
    );
  });

  it("tracks the origin offsets for error reporting", () => {
    const tokens = new Lexer(sample).scanTokens();

    assert.deepEqual(
      tokens.map((token) => token.index),
      [0, 6, 11, 15, 20, 28, 33, 39, 42, 48, 49],
      "les positions de début doivent pointer vers les offsets du DSL",
    );
  });
});

