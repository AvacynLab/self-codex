import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Unique identifier describing an exported symbol inside a file. The format is
 * `<relative-file-path>#<export-name>` with POSIX-style separators so entries
 * can be shared across environments and stored in allowlists.
 */
export interface DeadExportCoordinate {
  readonly file: string;
  readonly exportName: string;
}

/**
 * Lightweight description of a reference returned by TypeScript. Tests use the
 * structure to assert that references beyond the definition are discovered,
 * while the CLI surfaces the data when flagging dead exports to operators.
 */
export interface ExportReference {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly isDefinition: boolean;
}

/**
 * Entry produced for every exported symbol that has no references outside its
 * own definition. Consumers can surface the list to operators or wire it into
 * lint rules that fail CI when unused exports accumulate.
 */
export interface DeadExportReport extends DeadExportCoordinate {
  readonly kind: string;
  readonly definition: ExportReference;
  readonly references: ReadonlyArray<ExportReference>;
}

/** Result of a full scan across the project. */
export interface DeadCodeScanResult {
  readonly totalExports: number;
  readonly deadExports: ReadonlyArray<DeadExportReport>;
}

/** Options accepted by {@link scanForDeadExports}. */
export interface DeadCodeScanOptions {
  /** Path to the project root used to produce relative coordinates. */
  readonly projectRoot?: string;
  /** Optional explicit path to the tsconfig file (defaults to `tsconfig.json`). */
  readonly tsconfigPath?: string;
  /**
   * Collection of export coordinates that should be ignored by the scanner.
   * Use this for public entrypoints consumed outside of the monorepo.
   */
  readonly allowlist?: Iterable<string>;
}

/**
 * Minimum information retained for each exported symbol so we can format rich
 * diagnostics once we know whether the entry is unused.
 */
interface ExportCandidate extends DeadExportCoordinate {
  readonly kind: string;
  readonly declaration: ts.Declaration;
}

/** Regular expression ensuring coordinates always use POSIX separators. */
const BACKSLASH_REGEX = /\\/g;

/**
 * Creates a deterministic coordinate key that callers can store in allowlists
 * or compare against CLI output.
 */
export function formatCoordinate(file: string, exportName: string): string {
  return `${file.replace(BACKSLASH_REGEX, "/")}#${exportName}`;
}

/**
 * Parses the provided coordinate string back into its components. The helper is
 * intentionally strict to surface malformed entries early.
 */
export function parseCoordinate(key: string): DeadExportCoordinate {
  const [file, exportName, extra] = key.split("#");
  if (!file || !exportName || extra !== undefined) {
    throw new Error(`Invalid dead-export coordinate: ${key}`);
  }
  return { file, exportName };
}

/**
 * Loads and parses the project tsconfig so we can mirror compiler settings.
 */
function loadTsConfig(tsconfigPath: string): ts.ParsedCommandLine {
  const resolved = resolve(tsconfigPath);
  const configFile = ts.readConfigFile(resolved, (path) => {
    const contents = readFileSync(path, "utf8");
    return contents;
  });
  if (configFile.error) {
    throw new Error(ts.formatDiagnostic(configFile.error, createDiagnosticHost(dirname(resolved))));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(resolved),
    undefined,
    resolved,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, createDiagnosticHost(dirname(resolved))));
  }
  return parsed;
}

/** Creates a diagnostic host for pretty-printing TypeScript errors. */
function createDiagnosticHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCurrentDirectory: () => rootDir,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  };
}

/**
 * Minimal language service host that loads snapshots directly from disk. The
 * scanner runs in a read-only fashion so we can keep versions static.
 */
function createLanguageServiceHost(
  files: ReadonlyArray<string>,
  options: ts.CompilerOptions,
  currentDirectory: string,
): ts.LanguageServiceHost {
  const snapshots = new Map<string, ts.IScriptSnapshot>();
  return {
    getScriptFileNames: () => files,
    getCompilationSettings: () => options,
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getScriptVersion: () => "0",
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getScriptSnapshot: (fileName) => {
      const existing = snapshots.get(fileName);
      if (existing) {
        return existing;
      }
      if (!ts.sys.fileExists(fileName)) {
        return undefined;
      }
      const content = readFileSync(fileName, "utf8");
      const snapshot = ts.ScriptSnapshot.fromString(content);
      snapshots.set(fileName, snapshot);
      return snapshot;
    },
  };
}

/**
 * Collects additional TypeScript source files residing outside of the primary
 * `src/` tree (for example integration tests or maintenance scripts). The
 * compiler program does not include these paths by default but they may import
 * runtime exports, so we mirror them manually to avoid false positives.
 */
function collectSupplementaryFiles(projectRoot: string): ReadonlyArray<string> {
  const directories = ["tests", "scripts"];
  const extensions = [".ts", ".tsx"];
  const discovered = new Set<string>();
  for (const directory of directories) {
    const absoluteDirectory = resolve(projectRoot, directory);
    if (!ts.sys.directoryExists || !ts.sys.directoryExists(absoluteDirectory)) {
      continue;
    }
    const includes =
      directory === "tests"
        ? ["**/*.test.ts", "**/*.test.tsx", "setup.ts", "**/setup.ts"]
        : ["**/*"];
    const files = ts.sys.readDirectory(absoluteDirectory, extensions, undefined, includes);
    for (const fileName of files) {
      if (fileName.endsWith(".d.ts")) {
        continue;
      }
      discovered.add(fileName);
    }
  }
  return Array.from(discovered);
}

/**
 * Converts a declaration node into a list of identifier nodes whose references
 * we should inspect. Export specifiers are treated specially so aliases are
 * still tracked accurately.
 */
function getDeclarationIdentifiers(declaration: ts.Declaration): ReadonlyArray<ts.Node> {
  if (ts.isExportSpecifier(declaration)) {
    return [declaration.name];
  }
  if (ts.isExportAssignment(declaration)) {
    return declaration.expression && ts.isIdentifier(declaration.expression)
      ? [declaration.expression]
      : [];
  }
  if (ts.isVariableDeclaration(declaration)) {
    return ts.isIdentifier(declaration.name) ? [declaration.name] : [];
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  ) {
    return declaration.name ? [declaration.name] : [];
  }
  if (ts.isModuleDeclaration(declaration)) {
    return declaration.name && ts.isIdentifier(declaration.name) ? [declaration.name] : [];
  }
  return [];
}

/**
 * Collects exported declarations from a module symbol. The helper filters out
 * entries originating from declaration files so we do not attempt to flag
 * library exports.
 */
function collectExportCandidates(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  allowlist: ReadonlySet<string>,
  projectRoot: string,
): { candidates: Array<ExportCandidate>; total: number } {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return { candidates: [], total: 0 };
  }
  const exports = checker.getExportsOfModule(moduleSymbol);
  const candidates: Array<ExportCandidate> = [];
  let total = 0;
  for (const symbol of exports) {
    const exportName = symbol.getName();
    if (exportName === "__esModule") {
      continue;
    }
    total += 1;
    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      continue;
    }
    for (const declaration of declarations) {
      if (declaration.getSourceFile().isDeclarationFile) {
        continue;
      }
      const identifiers = getDeclarationIdentifiers(declaration);
      if (identifiers.length === 0) {
        continue;
      }
      const relativePath = relative(projectRoot, sourceFile.fileName) || sourceFile.fileName;
      const normalisedPath = relativePath.replace(BACKSLASH_REGEX, "/");
      const coordinateKey = formatCoordinate(normalisedPath, exportName);
      if (allowlist.has(coordinateKey)) {
        continue;
      }
      candidates.push({
        file: normalisedPath,
        exportName,
        kind: ts.SyntaxKind[declaration.kind] ?? "Unknown",
        declaration,
      });
      break;
    }
  }
  return { candidates, total };
}

/**
 * Converts a raw reference returned by the language service into a stable data
 * structure containing both textual coordinates and metadata.
 */
function convertReference(
  reference: ts.ReferencedSymbolEntry,
  program: ts.Program,
  projectRoot: string,
): ExportReference | null {
  const source = program.getSourceFile(reference.fileName);
  if (!source) {
    return null;
  }
  const { line, character } = ts.getLineAndCharacterOfPosition(source, reference.textSpan.start);
  const relativePath = (relative(projectRoot, reference.fileName) || reference.fileName).replace(BACKSLASH_REGEX, "/");
  return {
    file: relativePath,
    line: line + 1,
    character: character + 1,
    isDefinition: reference.isDefinition ?? false,
  };
}

/**
 * Runs a scan across the project and returns all exports that have no
 * references beyond their definition. The helper mirrors the compiler settings
 * defined in `tsconfig.json` so path aliases and JSX settings are honoured.
 */
export function scanForDeadExports(options: DeadCodeScanOptions = {}): DeadCodeScanResult {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const tsconfigPath = options.tsconfigPath
    ? resolve(options.tsconfigPath)
    : ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!tsconfigPath) {
    throw new Error(`Unable to locate tsconfig.json from ${projectRoot}`);
  }
  const parsed = loadTsConfig(tsconfigPath);
  const supplementaryFiles = collectSupplementaryFiles(projectRoot);
  const files = Array.from(
    new Set(
      [...parsed.fileNames, ...supplementaryFiles].filter(
        (fileName) => fileName.endsWith(".ts") || fileName.endsWith(".tsx"),
      ),
    ),
  );
  const host = createLanguageServiceHost(files, parsed.options, dirname(tsconfigPath));
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (!program) {
    throw new Error("TypeScript language service did not return a program");
  }
  const checker = program.getTypeChecker();
  const allowlist = new Set<string>();
  if (options.allowlist) {
    for (const entry of options.allowlist) {
      allowlist.add(entry);
    }
  }

  const deadExports: Array<DeadExportReport> = [];
  let totalExports = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    if (!sourceFile.fileName.startsWith(projectRoot)) {
      continue;
    }
    const { candidates, total } = collectExportCandidates(sourceFile, checker, allowlist, projectRoot);
    totalExports += total;
    for (const candidate of candidates) {
      const identifiers = getDeclarationIdentifiers(candidate.declaration);
      if (identifiers.length === 0) {
        continue;
      }
      let hasReference = false;
      const references: Array<ExportReference> = [];
      for (const identifier of identifiers) {
        const refs = service.findReferences(identifier.getSourceFile().fileName, identifier.getStart());
        if (!refs) {
          continue;
        }
        for (const ref of refs) {
          for (const entry of ref.references) {
            const converted = convertReference(entry, program, projectRoot);
            if (!converted) {
              continue;
            }
            references.push(converted);
            if (!converted.isDefinition) {
              hasReference = true;
            }
          }
        }
      }
      if (hasReference) {
        continue;
      }
      const definitionReference = references.find((ref) => ref.isDefinition) ?? {
        file: candidate.file,
        line: 1,
        character: 1,
        isDefinition: true,
      };
      deadExports.push({
        file: candidate.file,
        exportName: candidate.exportName,
        kind: candidate.kind,
        definition: definitionReference,
        references,
      });
    }
  }

  return {
    totalExports,
    deadExports,
  };
}
