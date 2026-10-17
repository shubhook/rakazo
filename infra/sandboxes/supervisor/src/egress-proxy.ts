/**
 * The only route out of a restricted Docker computer. The computer sits on an internal
 * network and reaches the internet through this HTTP proxy, which accepts CONNECT tunnels
 * and plain-HTTP requests only to hosts on the computer's allowlist. The supervisor runs one
 * per restricted computer from its own image, with the policy as the only argument.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ComputerEgressPolicy } from "@milo/contracts";
import { ComputerEgressPolicySchema, egressAllows } from "@milo/contracts";

export const EGRESS_PROXY_PORT = 3128;
const CONNECT_TIMEOUT_MS = 15_000;

export type ResolvedAddress = { address: string; family: number };

// The same non-public blocks as infra/compose/restrict-computer-egress.sh, plus the IPv6
// prefixes that embed an IPv4 address. An allowed name must still resolve to the internet.
const BLOCKED_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

export function isBlockedEgressAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface EgressProxyOptions {
  policy: ComputerEgressPolicy;
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  isBlockedAddress?: (address: string) => boolean;
  onDenied?: (host: string, port: number) => void;
}

type Target = { ok: true; address: string } | { ok: false; status: 403 | 502 };

export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const resolve =
    options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const isBlocked = options.isBlockedAddress ?? isBlockedEgressAddress;

  async function target(host: string, port: number): Promise<Target> {
    if (!egressAllows(options.policy, host, port)) {
      options.onDenied?.(host, port);
      return { ok: false, status: 403 };
    }
    let addresses: ResolvedAddress[];
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, status: 502 };
    }
    // Any private answer fails the whole name, so a mixed record cannot reach the LAN.
    if (addresses.length === 0 || addresses.some((entry) => isBlocked(entry.address))) {
      options.onDenied?.(host, port);
      return { ok: false, status: 403 };
    }
    return { ok: true, address: addresses[0]!.address };
  }

  const server = http.createServer((req, res) => {
    void forwardHttp(req, res);
  });

  async function forwardHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return reply(res, 400);
    }
    // HTTPS goes through CONNECT; a plain proxy request only ever carries http:.
    if (url.protocol !== "http:" || url.username || url.password) return reply(res, 400);
    const port = Number(url.port || 80);
    const resolved = await target(url.hostname, port);
    if (!resolved.ok) return reply(res, resolved.status, url.hostname, port);
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
    for (const name of ["proxy-authorization", "proxy-connection", "connection", "keep-alive"]) {
      delete headers[name];
    }
    const upstream = http.request(
      {
        host: resolved.address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
        timeout: CONNECT_TIMEOUT_MS,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
    upstream.on("error", () => {
      if (!res.headersSent) reply(res, 502);
      else res.destroy();
    });
    req.pipe(upstream);
  }

  server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    void tunnel(req, socket, head);
  });

  async function tunnel(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const authority = parseAuthority(req.url ?? "");
    if (!authority) return refuse(socket, 400);
    const resolved = await target(authority.host, authority.port);
    if (!resolved.ok) return refuse(socket, resolved.status, authority.host, authority.port);
    const upstream = net.connect({ host: resolved.address, port: authority.port });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("timed out")));
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (upstream.connecting || upstream.pending) refuse(socket, 502);
      else socket.destroy();
    });
    socket.on("close", () => upstream.destroy());
  }

  return server;
}

/** `host:port` from a CONNECT request line. IPv6 literals never match an allowlist. */
export function parseAuthority(value: string): { host: string; port: number } | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const host = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  return port >= 1 && port <= 65_535 ? { host, port } : undefined;
}

function deniedBody(status: number, host?: string, port?: number) {
  if (status === 403 && host) return `Blocked by the computer's network policy: ${host}:${port}\n`;
  return `${http.STATUS_CODES[status] ?? "Error"}\n`;
}

function reply(res: http.ServerResponse, status: number, host?: string, port?: number) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(deniedBody(status, host, port));
}

function refuse(socket: Duplex, status: number, host?: string, port?: number) {
  if (socket.destroyed) return;
  const body = deniedBody(status, host, port);
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
      `content-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
}

function main() {
  const policy = ComputerEgressPolicySchema.parse(JSON.parse(process.argv[2] ?? ""));
  const server = createEgressProxy({
    policy,
    onDenied: (host, port) => {
      process.stderr.write(`${JSON.stringify({ event: "egress.denied", host, port })}\n`);
    },
  });
  server.listen(EGRESS_PROXY_PORT, "0.0.0.0");
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
