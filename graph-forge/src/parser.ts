import { Lexer, LexerError, Token, TokenType } from "./lexer.js";

export type ValueNode =
  | { kind: "number"; value: number; token: Token }
  | { kind: "string"; value: string; token: Token }
  | { kind: "boolean"; value: boolean; token: Token }
  | { kind: "identifier"; value: string; token: Token };

export interface AttributeNode {
  readonly key: string;
  readonly keyToken: Token;
  readonly value: ValueNode;
}

export interface DirectiveNode {
  readonly name: string;
  readonly nameToken: Token;
  readonly value: ValueNode;
}

export interface NodeDeclNode {
  readonly name: string;
  readonly nameToken: Token;
  readonly attributes: AttributeNode[];
}

export interface EdgeDeclNode {
  readonly from: string;
  readonly fromToken: Token;
  readonly to: string;
  readonly toToken: Token;
  readonly attributes: AttributeNode[];
}

export interface AnalysisNode {
  readonly keywordToken: Token;
  readonly name: string;
  readonly nameToken: Token;
  readonly args: ValueNode[];
}

export interface GraphNode {
  readonly name: string;
  readonly nameToken: Token;
  readonly directives: DirectiveNode[];
  readonly nodes: NodeDeclNode[];
  readonly edges: EdgeDeclNode[];
  readonly analyses: AnalysisNode[];
}

export interface GraphFileNode {
  readonly graphs: GraphNode[];
}

export class ParserError extends Error {
  constructor(message: string, public readonly token: Token) {
    super(message);
    this.name = "ParserError";
  }
}

export function parse(source: string): GraphFileNode {
  try {
    const lexer = new Lexer(source);
    const tokens = lexer.scanTokens();
    const parser = new Parser(tokens);
    return parser.parseFile();
  } catch (err) {
    if (err instanceof LexerError || err instanceof ParserError) {
      throw err;
    }
    throw err;
  }
}

class Parser {
  private current = 0;

  constructor(private readonly tokens: Token[]) {}

  parseFile(): GraphFileNode {
    const graphs: GraphNode[] = [];
    while (!this.isAtEnd()) {
      if (this.match(TokenType.Graph)) {
        graphs.push(this.graphDeclaration());
      } else if (this.check(TokenType.EOF)) {
        break;
      } else {
        throw this.error(this.peek(), "Expected 'graph' declaration");
      }
    }
    return { graphs };
  }

  private graphDeclaration(): GraphNode {
    const nameToken = this.consume(TokenType.Identifier, "Graph name expected after 'graph'");
    this.consume(TokenType.LBrace, "Expected '{' to start graph block");

    const directives: DirectiveNode[] = [];
    const nodes: NodeDeclNode[] = [];
    const edges: EdgeDeclNode[] = [];
    const analyses: AnalysisNode[] = [];

    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      if (this.match(TokenType.Directive)) {
        directives.push(this.directive());
      } else if (this.match(TokenType.Node)) {
        nodes.push(this.nodeDecl());
      } else if (this.match(TokenType.Edge)) {
        edges.push(this.edgeDecl());
      } else if (this.match(TokenType.At)) {
        analyses.push(this.analysis());
      } else {
        throw this.error(this.peek(), "Unexpected statement inside graph block");
      }
    }

    this.consume(TokenType.RBrace, "Expected '}' to close graph block");

    return {
      name: nameToken.lexeme,
      nameToken,
      directives,
      nodes,
      edges,
      analyses
    };
  }

  private directive(): DirectiveNode {
    const nameToken = this.consume(TokenType.Identifier, "Directive name expected");
    const value = this.valueNode();
    this.consumeOptional(TokenType.Semicolon);
    return { name: nameToken.lexeme, nameToken, value };
  }

  private nodeDecl(): NodeDeclNode {
    const nameToken = this.consume(TokenType.Identifier, "Node identifier expected");
    const attributes = this.attributeBlockOptional();
    this.consumeOptional(TokenType.Semicolon);
    return { name: nameToken.lexeme, nameToken, attributes };
  }

  private edgeDecl(): EdgeDeclNode {
    const fromToken = this.consume(TokenType.Identifier, "Edge requires a source node");
    this.consume(TokenType.Arrow, "Expected '->' in edge declaration");
    const toToken = this.consume(TokenType.Identifier, "Edge requires a destination node");
    const attributes = this.attributeBlockOptional();
    this.consumeOptional(TokenType.Semicolon);
    return {
      from: fromToken.lexeme,
      fromToken,
      to: toToken.lexeme,
      toToken,
      attributes
    };
  }

  private analysis(): AnalysisNode {
    const keyword = this.consume(TokenType.Analysis, "Expected 'analysis' keyword after '@'");
    const nameValue = this.valueNode();
    const args: ValueNode[] = [];
    while (!this.check(TokenType.Semicolon) && !this.check(TokenType.RBrace) && !this.isAtEnd()) {
      args.push(this.valueNode());
    }
    this.consumeOptional(TokenType.Semicolon);
    const derivedName = nameValue.kind === "identifier" ? nameValue.value : nameValue.token.lexeme;
    return { keywordToken: keyword, name: derivedName, nameToken: nameValue.token, args };
  }

  private attributeBlockOptional(): AttributeNode[] {
    if (!this.match(TokenType.LBrace)) {
      return [];
    }
    const attributes: AttributeNode[] = [];
    if (this.check(TokenType.RBrace)) {
      this.advance();
      return attributes;
    }
    while (true) {
      const keyToken = this.consume(TokenType.Identifier, "Attribute key expected");
      this.consume(TokenType.Colon, "Expected ':' in attribute pair");
      const value = this.valueNode();
      attributes.push({ key: keyToken.lexeme, keyToken, value });
      if (this.match(TokenType.Comma)) {
        if (this.check(TokenType.RBrace)) {
          break; // tolerate trailing comma
        }
        continue;
      }
      break;
    }
    this.consume(TokenType.RBrace, "Expected '}' to close attribute block");
    return attributes;
  }

  private valueNode(): ValueNode {
    if (this.match(TokenType.Number)) {
      const token = this.previous();
      return { kind: "number", value: Number(token.literal), token };
    }
    if (this.match(TokenType.String)) {
      const token = this.previous();
      return { kind: "string", value: String(token.literal ?? ""), token };
    }
    if (this.match(TokenType.Boolean)) {
      const token = this.previous();
      return { kind: "boolean", value: Boolean(token.literal), token };
    }
    const ident = this.consume(TokenType.Identifier, "Expected value");
    return { kind: "identifier", value: ident.lexeme, token: ident };
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) {
      return this.advance();
    }
    throw this.error(this.peek(), message);
  }

  private consumeOptional(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) {
      return type === TokenType.EOF;
    }
    return this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.current++;
    }
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private error(token: Token, message: string): ParserError {
    return new ParserError(`${message} (line ${token.line}, column ${token.column})`, token);
  }
}
