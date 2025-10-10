import process from "node:process";

/**
 * Minimal runtime-dependent types derived from the Node.js process globals. The
 * helpers keep our TypeScript configuration independent from the `@types/node`
 * ambient declarations while still providing precise typings for the values we
 * manipulate frequently (environment variables, POSIX signals, resource usage
 * snapshots and errno-flavoured errors).
 */
export type ProcessEnv = typeof process.env;

/** Name of the POSIX signal understood by {@link process.kill}. */
export type SignalName =
  | "SIGABRT"
  | "SIGALRM"
  | "SIGBUS"
  | "SIGCHLD"
  | "SIGCONT"
  | "SIGFPE"
  | "SIGHUP"
  | "SIGILL"
  | "SIGINT"
  | "SIGIO"
  | "SIGIOT"
  | "SIGKILL"
  | "SIGPIPE"
  | "SIGPOLL"
  | "SIGPROF"
  | "SIGPWR"
  | "SIGQUIT"
  | "SIGSEGV"
  | "SIGSTKFLT"
  | "SIGSTOP"
  | "SIGSYS"
  | "SIGTERM"
  | "SIGTRAP"
  | "SIGTSTP"
  | "SIGTTIN"
  | "SIGTTOU"
  | "SIGURG"
  | "SIGUSR1"
  | "SIGUSR2"
  | "SIGVTALRM"
  | "SIGWINCH"
  | "SIGUNUSED"
  | "SIGBREAK"
  | "SIGLOST"
  | "SIGINFO"
  | "SIGXCPU"
  | "SIGXFSZ";

export type Signal = SignalName | number | undefined;

/** Snapshot describing the CPU and memory usage of the current process. */
export type ResourceUsage = ReturnType<typeof process.resourceUsage>;

/**
 * Lightweight representation of an errno-flavoured error. Only the properties
 * we actually inspect in the codebase are included which keeps the definition
 * compact while avoiding a hard dependency on the Node.js ambient types.
 */
export interface ErrnoException extends Error {
  code?: string;
  errno?: number;
  path?: string;
  syscall?: string;
}

/** Union of the text encodings accepted by {@link Buffer.from}. */
export type BufferEncoding =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "utf-16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "hex";
