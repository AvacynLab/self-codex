export enum TokenType {
  Graph = "GRAPH",
  Node = "NODE",
  Edge = "EDGE",
  Directive = "DIRECTIVE",
  Analysis = "ANALYSIS",
  Identifier = "IDENT",
  Number = "NUMBER",
  String = "STRING",
  Boolean = "BOOLEAN",
  LBrace = "LBRACE",
  RBrace = "RBRACE",
  LParen = "LPAREN",
  RParen = "RPAREN",
  Colon = "COLON",
  Comma = "COMMA",
  Semicolon = "SEMICOLON",
  Arrow = "ARROW",
  At = "AT",
  EOF = "EOF"
}

export interface Token {
  type: TokenType;
  lexeme: string;
  literal?: string | number | boolean | null;
  line: number;
  column: number;
  index: number;
}

const keywords = new Map<string, TokenType>([
  ["graph", TokenType.Graph],
  ["node", TokenType.Node],
  ["edge", TokenType.Edge],
  ["directive", TokenType.Directive],
  ["true", TokenType.Boolean],
  ["false", TokenType.Boolean]
]);

export class LexerError extends Error {
  constructor(message: string, public readonly line: number, public readonly column: number) {
    super(message);
    this.name = "LexerError";
  }
}

type CharPredicate = (ch: string) => boolean;

export class Lexer {
  private readonly tokens: Token[] = [];
  private start = 0;
  private startLine = 1;
  private startColumn = 1;
  private current = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly source: string) {}

  scanTokens(): Token[] {
    while (!this.isAtEnd()) {
      this.start = this.current;
      this.startLine = this.line;
      this.startColumn = this.column;
      this.scanToken();
    }
    this.tokens.push({
      type: TokenType.EOF,
      lexeme: "",
      line: this.line,
      column: this.column,
      index: this.current
    });
    return this.tokens;
  }

  private scanToken(): void {
    const c = this.advance();
    switch (c) {
      case "{":
        this.addToken(TokenType.LBrace);
        break;
      case "}":
        this.addToken(TokenType.RBrace);
        break;
      case "(":
        this.addToken(TokenType.LParen);
        break;
      case ")":
        this.addToken(TokenType.RParen);
        break;
      case ":":
        this.addToken(TokenType.Colon);
        break;
      case ",":
        this.addToken(TokenType.Comma);
        break;
      case ";":
        this.addToken(TokenType.Semicolon);
        break;
      case "@":
        this.addToken(TokenType.At);
        break;
      case "-":
        if (this.match(">")) {
          this.addToken(TokenType.Arrow);
        } else {
          this.error("Unexpected character '-' without '>'", this.startLine, this.startColumn);
        }
        break;
      case "\n":
        this.line++;
        this.column = 1;
        break;
      case " ":
      case "\r":
      case "\t":
        break;
      case "/":
        if (this.match("/")) {
          this.skipWhile((ch) => ch !== "\n");
        } else {
          this.error("Unexpected character '/'", this.startLine, this.startColumn);
        }
        break;
      case "\"":
        this.string();
        break;
      default:
        if (this.isDigit(c)) {
          this.number();
        } else if (this.isAlpha(c)) {
          this.identifier();
        } else {
          this.error(`Unexpected character '${c}'`, this.startLine, this.startColumn);
        }
    }
  }

  private identifier(): void {
    this.consumeWhile((ch) => this.isAlphaNumeric(ch));
    const text = this.source.substring(this.start, this.current);
    if (text === "analysis") {
      this.addToken(TokenType.Analysis);
      return;
    }
    const keyword = keywords.get(text);
    if (keyword === TokenType.Boolean) {
      this.addToken(keyword, text === "true");
    } else if (keyword) {
      this.addToken(keyword);
    } else {
      this.addToken(TokenType.Identifier);
    }
  }

  private number(): void {
    this.consumeWhile((ch) => this.isDigit(ch));
    if (this.peek() === "." && this.isDigit(this.peekNext())) {
      this.advance();
      this.consumeWhile((ch) => this.isDigit(ch));
    }
    const text = this.source.substring(this.start, this.current);
    this.addToken(TokenType.Number, Number(text));
  }

  private string(): void {
    let value = "";
    while (!this.isAtEnd()) {
      const ch = this.advance();
      if (ch === "\"") {
        this.addToken(TokenType.String, value);
        return;
      }
      if (ch === "\n") {
        this.line++;
        this.column = 1;
        value += "\n";
        continue;
      }
      if (ch === "\\") {
        const next = this.advance();
        switch (next) {
          case "\"":
          case "\\":
            value += next;
            break;
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          default:
            this.error(`Unsupported escape '${next}'`, this.line, this.column - 1);
        }
      } else {
        value += ch;
      }
    }
    this.error("Unterminated string", this.startLine, this.startColumn);
  }

  private addToken(type: TokenType, literal?: string | number | boolean): void {
    const lexeme = this.source.substring(this.start, this.current);
    this.tokens.push({ type, lexeme, literal: literal ?? null, line: this.startLine, column: this.startColumn, index: this.start });
  }

  private consumeWhile(predicate: CharPredicate): void {
    while (!this.isAtEnd() && predicate(this.peek())) {
      this.advance();
    }
  }

  private skipWhile(predicate: CharPredicate): void {
    while (!this.isAtEnd() && predicate(this.peek())) {
      this.advance();
    }
  }

  private advance(): string {
    const ch = this.source.charAt(this.current++);
    if (ch === "\n") {
      return ch;
    }
    this.column++;
    return ch;
  }

  private match(expected: string): boolean {
    if (this.isAtEnd()) {
      return false;
    }
    if (this.source.charAt(this.current) !== expected) {
      return false;
    }
    this.current++;
    if (expected === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return true;
  }

  private peek(): string {
    if (this.isAtEnd()) {
      return "\0";
    }
    return this.source.charAt(this.current);
  }

  private peekNext(): string {
    if (this.current + 1 >= this.source.length) {
      return "\0";
    }
    return this.source.charAt(this.current + 1);
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isAlpha(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isAlphaNumeric(ch: string): boolean {
    return this.isAlpha(ch) || this.isDigit(ch);
  }

  private isAtEnd(): boolean {
    return this.current >= this.source.length;
  }

  private error(message: string, line: number, column: number): never {
    throw new LexerError(message, line, column);
  }
}
