import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { ComputerEgressPolicySchema } from "@milo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEgressProxy, isBlockedEgressAddress, parseAuthority } from "./egress-proxy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function listen(server: net.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(
    () =>
      new Promise((resolve) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

async function setup(allowedTcp: (upstreamPort: number) => string[]) {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const web = http.createServer((req, res) =>
    res.end(`${req.method} ${req.url} ${req.headers.host}`),
  );
  const webPort = await listen(web);
  const resolve = vi.fn(async (host: string) =>
    host.endsWith(".private.test")
      ? [{ address: "10.0.0.5", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }],
  );
  const proxy = createEgressProxy({
    policy: ComputerEgressPolicySchema.parse({
      mode: "restricted",
      allowedDomains: [],
      allowedTcp: [...allowedTcp(echoPort), ...allowedTcp(webPort)],
    }),
    resolve,
    // Loopback stands in for the internet here; real private ranges stay blocked.
    isBlockedAddress: (address) => address !== "127.0.0.1" && isBlockedEgressAddress(address),
  });
  const proxyPort = await listen(proxy);
  return { echoPort, webPort, proxyPort, resolve };
}

async function connectThrough(proxyPort: number, authority: string) {
  const socket = net.connect(proxyPort, "127.0.0.1");
  closers.push(async () => void socket.destroy());
  await once(socket, "connect");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let received = "";
  socket.setEncoding("utf8");
  while (!received.includes("\r\n\r\n")) {
    const [chunk] = (await Promise.race([
      once(socket, "data"),
      once(socket, "end").then(() => [""]),
    ])) as [string];
    if (!chunk) break;
    received += chunk;
  }
  return { socket, status: Number(received.split(" ")[1]), received };
}

function proxiedGet(proxyPort: number, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: url, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("egress proxy", () => {
  it("tunnels CONNECT to an allowed host and port", async () => {
    const { echoPort, proxyPort } = await setup((port) => [`allowed.test:${port}`]);
    const { socket, status } = await connectThrough(proxyPort, `allowed.test:${echoPort}`);
    expect(status).toBe(200);
    socket.write("ping");
    const [echoed] = (await once(socket, "data")) as [string];
    expect(echoed).toBe("ping");
  });

  it("refuses hosts and ports outside the allowlist without resolving them", async () => {
    const { echoPort, proxyPort, resolve } = await setup((port) => [`allowed.test:${port}`]);
    const other = await connectThrough(proxyPort, `other.test:${echoPort}`);
    expect(other.status).toBe(403);
    expect(other.received).toContain("Blocked by the computer's network policy");
    expect((await connectThrough(proxyPort, "allowed.test:1")).status).toBe(403);
    expect((await connectThrough(proxyPort, `127.0.0.1:${echoPort}`)).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses an allowed name that resolves to a private address", async () => {
    const { echoPort, proxyPort } = await setup((port) => [`db.private.test:${port}`]);
    expect((await connectThrough(proxyPort, `db.private.test:${echoPort}`)).status).toBe(403);
  });

  it("forwards plain HTTP to allowed hosts only", async () => {
    const { webPort, proxyPort } = await setup((port) => [`allowed.test:${port}`]);
    await expect(
      proxiedGet(proxyPort, `http://allowed.test:${webPort}/simple?x=1`),
    ).resolves.toEqual({ status: 200, body: `GET /simple?x=1 allowed.test:${webPort}` });
    expect((await proxiedGet(proxyPort, `http://other.test:${webPort}/`)).status).toBe(403);
    expect((await proxiedGet(proxyPort, `https://allowed.test:${webPort}/`)).status).toBe(400);
    expect((await proxiedGet(proxyPort, "/relative")).status).toBe(400);
  });
});

describe("egress address checks", () => {
  it.each([
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.20.0.2",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:10.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedEgressAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (address) => {
    expect(isBlockedEgressAddress(address)).toBe(false);
  });

  it("parses CONNECT authorities", () => {
    expect(parseAuthority("github.com:22")).toEqual({ host: "github.com", port: 22 });
    expect(parseAuthority("[::1]:443")).toEqual({ host: "[::1]", port: 443 });
    expect(parseAuthority("github.com")).toBeUndefined();
    expect(parseAuthority("github.com:0")).toBeUndefined();
    expect(parseAuthority("github.com:99999")).toBeUndefined();
  });
});
