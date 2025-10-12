/**
 * Shared helpers used by the offline network guard.  Extracted into a separate
 * module so unit tests can validate the allow/deny logic without executing the
 * full Mocha bootstrap.
 */
export interface ConnectionTarget {
  host?: string;
  port?: number;
  path?: string;
}

/** Normalises IPv4/IPv6 textual representations for comparison. */
export function normaliseHost(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extracts the target host/port/path tuple from the various connection
 * signatures exposed by Node's networking primitives.
 */
export function deriveConnectionTarget(args: unknown[]): ConnectionTarget {
  if (args.length === 0) {
    return {};
  }
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const record = first as { host?: string; hostname?: string; port?: number; path?: string };
    return {
      host: record.host ?? record.hostname,
      port: typeof record.port === "number" ? record.port : undefined,
      path: typeof record.path === "string" ? record.path : undefined,
    };
  }
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? (args[1] as string) : undefined;
    return { host, port: first };
  }
  if (typeof first === "string") {
    if (first.startsWith("/")) {
      return { path: first };
    }
    const numeric = Number(first);
    if (Number.isInteger(numeric)) {
      const host = typeof args[1] === "string" ? (args[1] as string) : undefined;
      return { host, port: numeric };
    }
    return { host: first };
  }
  return {};
}

/**
 * Validates whether the requested target is whitelisted for loopback traffic.
 * Only explicit loopback hosts and the configured port range are accepted to
 * keep the guard hermetic for external destinations.
 */
export function isAllowedLoopback(
  target: ConnectionTarget,
  hosts: Set<string>,
  ports: Set<number>,
  allowEphemeralPorts: boolean,
): boolean {
  if (target.path && !target.path.startsWith("\\\\.\\pipe\\")) {
    return false;
  }
  const normalised = normaliseHost(target.host ?? "127.0.0.1");
  if (!normalised || !hosts.has(normalised)) {
    return false;
  }
  if (!target.port) {
    return allowEphemeralPorts || ports.size === 0;
  }
  if (ports.size === 0) {
    return true;
  }
  if (ports.has(target.port)) {
    return true;
  }
  if (allowEphemeralPorts && target.port >= 1024) {
    return true;
  }
  return false;
}
