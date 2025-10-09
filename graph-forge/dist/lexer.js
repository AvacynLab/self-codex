export var TokenType;
(function (TokenType) {
    TokenType["Graph"] = "GRAPH";
    TokenType["Node"] = "NODE";
    TokenType["Edge"] = "EDGE";
    TokenType["Directive"] = "DIRECTIVE";
    TokenType["Analysis"] = "ANALYSIS";
    TokenType["Identifier"] = "IDENT";
    TokenType["Number"] = "NUMBER";
    TokenType["String"] = "STRING";
    TokenType["Boolean"] = "BOOLEAN";
    TokenType["LBrace"] = "LBRACE";
    TokenType["RBrace"] = "RBRACE";
    TokenType["LParen"] = "LPAREN";
    TokenType["RParen"] = "RPAREN";
    TokenType["Colon"] = "COLON";
    TokenType["Comma"] = "COMMA";
    TokenType["Semicolon"] = "SEMICOLON";
    TokenType["Arrow"] = "ARROW";
    TokenType["At"] = "AT";
    TokenType["EOF"] = "EOF";
})(TokenType || (TokenType = {}));
const keywords = new Map([
    ["graph", TokenType.Graph],
    ["node", TokenType.Node],
    ["edge", TokenType.Edge],
    ["directive", TokenType.Directive],
    ["true", TokenType.Boolean],
    ["false", TokenType.Boolean]
]);
export class LexerError extends Error {
    line;
    column;
    constructor(message, line, column) {
        super(message);
        this.line = line;
        this.column = column;
        this.name = "LexerError";
    }
}
export class Lexer {
    source;
    tokens = [];
    start = 0;
    startLine = 1;
    startColumn = 1;
    current = 0;
    line = 1;
    column = 1;
    constructor(source) {
        this.source = source;
    }
    scanTokens() {
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
    scanToken() {
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
                }
                else {
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
                }
                else {
                    this.error("Unexpected character '/'", this.startLine, this.startColumn);
                }
                break;
            case "\"":
                this.string();
                break;
            default:
                if (this.isDigit(c)) {
                    this.number();
                }
                else if (this.isAlpha(c)) {
                    this.identifier();
                }
                else {
                    this.error(`Unexpected character '${c}'`, this.startLine, this.startColumn);
                }
        }
    }
    identifier() {
        this.consumeWhile((ch) => this.isAlphaNumeric(ch));
        const text = this.source.substring(this.start, this.current);
        if (text === "analysis") {
            this.addToken(TokenType.Analysis);
            return;
        }
        const keyword = keywords.get(text);
        if (keyword === TokenType.Boolean) {
            this.addToken(keyword, text === "true");
        }
        else if (keyword) {
            this.addToken(keyword);
        }
        else {
            this.addToken(TokenType.Identifier);
        }
    }
    number() {
        this.consumeWhile((ch) => this.isDigit(ch));
        if (this.peek() === "." && this.isDigit(this.peekNext())) {
            this.advance();
            this.consumeWhile((ch) => this.isDigit(ch));
        }
        const text = this.source.substring(this.start, this.current);
        this.addToken(TokenType.Number, Number(text));
    }
    string() {
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
            }
            else {
                value += ch;
            }
        }
        this.error("Unterminated string", this.startLine, this.startColumn);
    }
    addToken(type, literal) {
        const lexeme = this.source.substring(this.start, this.current);
        this.tokens.push({ type, lexeme, literal: literal ?? null, line: this.startLine, column: this.startColumn, index: this.start });
    }
    consumeWhile(predicate) {
        while (!this.isAtEnd() && predicate(this.peek())) {
            this.advance();
        }
    }
    skipWhile(predicate) {
        while (!this.isAtEnd() && predicate(this.peek())) {
            this.advance();
        }
    }
    advance() {
        const ch = this.source.charAt(this.current++);
        if (ch === "\n") {
            return ch;
        }
        this.column++;
        return ch;
    }
    match(expected) {
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
        }
        else {
            this.column++;
        }
        return true;
    }
    peek() {
        if (this.isAtEnd()) {
            return "\0";
        }
        return this.source.charAt(this.current);
    }
    peekNext() {
        if (this.current + 1 >= this.source.length) {
            return "\0";
        }
        return this.source.charAt(this.current + 1);
    }
    isDigit(ch) {
        return ch >= "0" && ch <= "9";
    }
    isAlpha(ch) {
        return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
    }
    isAlphaNumeric(ch) {
        return this.isAlpha(ch) || this.isDigit(ch);
    }
    isAtEnd() {
        return this.current >= this.source.length;
    }
    error(message, line, column) {
        throw new LexerError(message, line, column);
    }
}
//# sourceMappingURL=lexer.js.map