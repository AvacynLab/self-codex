/**
 * Minimal type shims for the Node.js standard library. The project intentionally
 * avoids depending on the full `@types/node` package so we provide the smallest
 * surface necessary for the TypeScript compiler to understand the imports used
 * across the runtime while still relying on the real Node implementations at
 * execution time.
 */

declare namespace NodeJS {
  interface Timeout {
    ref(): this;
    unref(): this;
  }

  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

declare module "node:events" {
  class EventEmitter {
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string | symbol): this;
    emit(event: string | symbol, ...args: any[]): boolean;
    listenerCount(event: string | symbol): number;
  }

  export { EventEmitter };
}

declare module "node:util" {
  export function inspect(value: unknown, options?: Record<string, unknown>): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | ArrayBufferView | ArrayBuffer): Hash;
    digest(encoding?: "hex" | "base64" | "base64url" | "latin1"): string;
  }

  export function randomUUID(): string;
  export function createHash(algorithm: string): Hash;
}

declare module "crypto" {
  export { randomUUID } from "node:crypto";
}

declare module "node:buffer" {
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

  export class Buffer<T extends ArrayBufferLike = ArrayBuffer> extends Uint8Array {
    constructor();
    buffer: T;
    static from(data: string | ArrayBuffer | ArrayBufferView | readonly number[], encoding?: BufferEncoding): Buffer;
    static from(data: Uint8Array): Buffer;
    static byteLength(data: string | Uint8Array, encoding?: BufferEncoding): number;
    static concat(list: readonly (Uint8Array | Buffer)[], totalLength?: number): Buffer;
    static isBuffer(value: unknown): value is Buffer;
    static alloc(size: number, fill?: number | string, encoding?: BufferEncoding): Buffer;
    toString(encoding?: BufferEncoding): string;
    write(string: string, encoding?: BufferEncoding): number;
  }
}

declare module "node:process" {
  import type { EventEmitter } from "node:events";
  import type { Writable } from "node:stream";

  interface StdoutStderr extends Writable {
    write(data: string | Uint8Array, encoding?: string, callback?: (error?: Error | null) => void): boolean;
    end(data?: string | Uint8Array, encoding?: string, callback?: () => void): void;
  }

  interface Process extends EventEmitter {
    env: NodeJS.ProcessEnv;
    argv: string[];
    pid: number;
    stdout: StdoutStderr;
    stderr: StdoutStderr;
    cwd(): string;
    kill(pid: number, signal?: string | number): void;
    exit(code?: number): never;
    nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
    resourceUsage(): {
      userCPUTime: number;
      systemCPUTime: number;
      maxRSS: number;
      sharedMemorySize: number;
      unsharedDataSize: number;
      unsharedStackSize: number;
      minorPageFault: number;
      majorPageFault: number;
      voluntaryContextSwitches: number;
      involuntaryContextSwitches: number;
    };
  }

  const process: Process;
  export default process;
}

declare module "node:fs/promises" {
  import type { Buffer, BufferEncoding } from "node:buffer";

  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  export function writeFile(
    path: string | URL,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<void>;
  export function readFile(path: string | URL, options: BufferEncoding): Promise<string>;
  export function readFile(path: string | URL, options: { encoding: BufferEncoding }): Promise<string>;
  export function readFile(path: string | URL, options?: { encoding?: null } | null): Promise<Buffer>;
  export function appendFile(
    path: string | URL,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<void>;
  export function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function stat(path: string | URL): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
  export function readdir(path: string | URL, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readdir(path: string | URL, options?: { withFileTypes?: false }): Promise<string[]>;
  export function unlink(path: string | URL): Promise<void>;
}

declare module "node:fs" {
  export const promises: typeof import("node:fs/promises");
  export function mkdirSync(path: string | URL, options?: { recursive?: boolean }): void;
  export function existsSync(path: string | URL): boolean;
  export function writeFileSync(
    path: string | URL,
    data: string | Uint8Array,
    options?: { encoding?: string | null } | string,
  ): void;
}

declare module "node:path" {
  export function resolve(...segments: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function join(...segments: string[]): string;
}

declare module "node:url" {
  export { URL } from "url";
}

declare module "url" {
  export function pathToFileURL(path: string): URL;
}

declare module "node:http" {
  import { EventEmitter } from "node:events";
  import type { Buffer } from "node:buffer";

  export interface IncomingHttpHeaders {
    [header: string]: string | string[] | undefined;
  }

  export class IncomingMessage extends EventEmitter {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    socket: { end(data?: string): void };
    setEncoding(encoding: string): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<string | Buffer>;
  }

  export class ServerResponse extends EventEmitter {
    statusCode: number;
    statusMessage?: string;
    headersSent: boolean;
    setHeader(name: string, value: string | number | readonly string[]): void;
    writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): this;
    write(chunk: string | Uint8Array, encoding?: string, callback?: (error?: Error | null) => void): boolean;
    end(data?: string | Uint8Array, encoding?: string, callback?: () => void): void;
  }

  export interface AddressInfo {
    port: number;
    family: string;
    address: string;
  }

  export interface Server extends EventEmitter {
    listen(port?: number, hostname?: string, callback?: () => void): this;
    address(): AddressInfo | string | null;
    close(callback: (err?: Error | null) => void): void;
  }

  export function createServer(
    listener: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): Server;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    constructor();
    run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
    getStore(): T | undefined;
    exit<R>(callback: (...args: any[]) => R, ...args: any[]): R;
  }
}

declare module "node:timers" {
  export function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): NodeJS.Timeout;
  export function clearTimeout(timeoutId: NodeJS.Timeout | number): void;
  export function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): NodeJS.Timeout;
  export function clearInterval(intervalId: NodeJS.Timeout | number): void;
}

declare module "node:timers/promises" {
  export function setTimeout<T = void>(delay: number, value?: T, options?: { ref?: boolean }): Promise<T>;
}

declare module "node:assert" {
  export function ok(value: unknown, message?: string): asserts value;
  export const strict: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    fail(message?: string): never;
  };
}

declare module "node:child_process" {
  import { EventEmitter } from "node:events";
  import type { Readable, Writable } from "node:stream";

  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Array<"pipe" | "ignore" | "inherit">;
    detached?: boolean;
  }

  export interface ChildProcessWithoutNullStreams extends EventEmitter {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill(signal?: string | number): void;
    once(event: string, listener: (...args: any[]) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcessWithoutNullStreams;
}

declare module "node:stream" {
  import { EventEmitter } from "node:events";
  import type { Buffer } from "node:buffer";

  export interface Readable extends EventEmitter {
    setEncoding(encoding: string): this;
    read(size?: number): Buffer | null;
    pipe<T extends Writable>(destination: T, options?: { end?: boolean }): T;
    on(event: "data", listener: (chunk: string | Buffer) => void): this;
    on(event: "end", listener: () => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<string | Buffer>;
  }

  export interface Writable extends EventEmitter {
    write(chunk: string | Uint8Array, encoding?: string, callback?: (err?: Error | null) => void): boolean;
    end(chunk?: string | Uint8Array, encoding?: string, callback?: () => void): void;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
  }
}

/**
 * Minimal DOM-style globals used throughout the codebase. They are available in
 * modern Node.js runtimes but TypeScript does not know about them when
 * `@types/node` is absent.
 */
declare class DOMException extends Error {
  name: string;
  code: number;
  static readonly ABORT_ERR: number;
  constructor(message?: string, name?: string);
}

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: (this: AbortSignal, event: unknown) => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: (this: AbortSignal, event: unknown) => void, options?: { once?: boolean }): void;
  throwIfAborted(): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare function structuredClone<T>(value: T): T;

declare function queueMicrotask(callback: () => void): void;

declare class URL {
  constructor(url: string, base?: string | URL);
  href: string;
  pathname: string;
}

declare interface ImportMeta {
  url: string;
}
