import { Lexer, LexerError, TokenType } from "./lexer.js";
export class ParserError extends Error {
    token;
    constructor(message, token) {
        super(message);
        this.token = token;
        this.name = "ParserError";
    }
}
export function parse(source) {
    try {
        const lexer = new Lexer(source);
        const tokens = lexer.scanTokens();
        const parser = new Parser(tokens);
        return parser.parseFile();
    }
    catch (err) {
        if (err instanceof LexerError || err instanceof ParserError) {
            throw err;
        }
        throw err;
    }
}
class Parser {
    tokens;
    current = 0;
    constructor(tokens) {
        this.tokens = tokens;
    }
    parseFile() {
        const graphs = [];
        while (!this.isAtEnd()) {
            if (this.match(TokenType.Graph)) {
                graphs.push(this.graphDeclaration());
            }
            else if (this.check(TokenType.EOF)) {
                break;
            }
            else {
                throw this.error(this.peek(), "Expected 'graph' declaration");
            }
        }
        return { graphs };
    }
    graphDeclaration() {
        const nameToken = this.consume(TokenType.Identifier, "Graph name expected after 'graph'");
        this.consume(TokenType.LBrace, "Expected '{' to start graph block");
        const directives = [];
        const nodes = [];
        const edges = [];
        const analyses = [];
        while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
            if (this.match(TokenType.Directive)) {
                directives.push(this.directive());
            }
            else if (this.match(TokenType.Node)) {
                nodes.push(this.nodeDecl());
            }
            else if (this.match(TokenType.Edge)) {
                edges.push(this.edgeDecl());
            }
            else if (this.match(TokenType.At)) {
                analyses.push(this.analysis());
            }
            else {
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
    directive() {
        const nameToken = this.consume(TokenType.Identifier, "Directive name expected");
        const value = this.valueNode();
        this.consumeOptional(TokenType.Semicolon);
        return { name: nameToken.lexeme, nameToken, value };
    }
    nodeDecl() {
        const nameToken = this.consume(TokenType.Identifier, "Node identifier expected");
        const attributes = this.attributeBlockOptional();
        this.consumeOptional(TokenType.Semicolon);
        return { name: nameToken.lexeme, nameToken, attributes };
    }
    edgeDecl() {
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
    analysis() {
        const keyword = this.consume(TokenType.Analysis, "Expected 'analysis' keyword after '@'");
        const nameValue = this.valueNode();
        const args = [];
        while (!this.check(TokenType.Semicolon) && !this.check(TokenType.RBrace) && !this.isAtEnd()) {
            args.push(this.valueNode());
        }
        this.consumeOptional(TokenType.Semicolon);
        const derivedName = nameValue.kind === "identifier" ? nameValue.value : nameValue.token.lexeme;
        return { keywordToken: keyword, name: derivedName, nameToken: nameValue.token, args };
    }
    attributeBlockOptional() {
        if (!this.match(TokenType.LBrace)) {
            return [];
        }
        const attributes = [];
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
    valueNode() {
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
    match(...types) {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }
    consume(type, message) {
        if (this.check(type)) {
            return this.advance();
        }
        throw this.error(this.peek(), message);
    }
    consumeOptional(type) {
        if (this.check(type)) {
            this.advance();
            return true;
        }
        return false;
    }
    check(type) {
        if (this.isAtEnd()) {
            return type === TokenType.EOF;
        }
        return this.peek().type === type;
    }
    advance() {
        if (!this.isAtEnd()) {
            this.current++;
        }
        return this.previous();
    }
    isAtEnd() {
        return this.peek().type === TokenType.EOF;
    }
    peek() {
        return this.tokens[this.current];
    }
    previous() {
        return this.tokens[this.current - 1];
    }
    error(token, message) {
        return new ParserError(`${message} (line ${token.line}, column ${token.column})`, token);
    }
}
//# sourceMappingURL=parser.js.map