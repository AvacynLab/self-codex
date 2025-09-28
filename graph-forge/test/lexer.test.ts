import { strict as assert } from "node:assert";
import test from "node:test";
import { Lexer, TokenType } from "../src/lexer.ts";

test("lexer tokenizes graph declarations", () => {
  const source = "graph Demo {\n  node A;\n  edge A -> B;\n}";
  const lexer = new Lexer(source);
  const tokens = lexer.scanTokens();
  const types = tokens.map((token) => token.type);

  assert.deepEqual(
    types.slice(0, 10),
    [
      TokenType.Graph,
      TokenType.Identifier,
      TokenType.LBrace,
      TokenType.Node,
      TokenType.Identifier,
      TokenType.Semicolon,
      TokenType.Edge,
      TokenType.Identifier,
      TokenType.Arrow,
      TokenType.Identifier
    ]
  );
  assert.equal(types.at(-1), TokenType.EOF);
});
