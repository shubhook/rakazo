import * as z from "zod";

export const MAX_EGRESS_ALLOWED_DOMAINS = 200;
export const MAX_EGRESS_ALLOWED_TCP = 50;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// At least two labels and a final label with a letter, so IP literals never match.
const DOMAIN = `(?:${LABEL}\\.)+(?=[a-z0-9-]*[a-z])${LABEL}`;
const DOMAIN_PATTERN = new RegExp(`^(?:\\*\\.)?${DOMAIN}$`);
const TCP_TARGET_PATTERN = new RegExp(`^((?:\\*\\.)?${DOMAIN}):(\\d{1,5})$`);

/** `example.com` matches only that host; `*.example.com` matches its subdomains. */
export function isEgressDomainPattern(value: string): boolean {
  return value.length <= 253 && DOMAIN_PATTERN.test(value);
}

/** Splits a `host:port` TCP allowlist entry, or returns undefined when it is malformed. */
export function parseEgressTcpTarget(value: string): { host: string; port: number } | undefined {
  const match = TCP_TARGET_PATTERN.exec(value);
  if (!match || match[1]!.length > 253) return undefined;
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : undefined;
}

const normalizedEntry = z.string().trim().toLowerCase().max(260);
const unique = <T>(values: T[]) => [...new Set(values)];

export const ComputerEgressModeSchema = z.enum(["open", "restricted"]);
export type ComputerEgressMode = z.infer<typeof ComputerEgressModeSchema>;

export const ComputerEgressPolicySchema = z.object({
  mode: ComputerEgressModeSchema,
  allowedDomains: z
    .array(normalizedEntry.refine(isEgressDomainPattern, "Enter a host name like example.com"))
    .max(MAX_EGRESS_ALLOWED_DOMAINS)
    .transform(unique),
  allowedTcp: z
    .array(
      normalizedEntry.refine(
        (value) => parseEgressTcpTarget(value) !== undefined,
        "Enter a host and port like github.com:22",
      ),
    )
    .max(MAX_EGRESS_ALLOWED_TCP)
    .transform(unique),
});
export type ComputerEgressPolicy = z.infer<typeof ComputerEgressPolicySchema>;

export const OPEN_COMPUTER_EGRESS: ComputerEgressPolicy = {
  mode: "open",
  allowedDomains: [],
  allowedTcp: [],
};

export const ComputerEgressSchema = z.object({
  policy: ComputerEgressPolicySchema,
  /** False when this computer's provider cannot enforce a restricted policy. */
  supported: z.boolean(),
});
export type ComputerEgress = z.infer<typeof ComputerEgressSchema>;

const DOMAIN_PORTS = new Set([80, 443]);

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/**
 * Whether a restricted computer may open a connection to `host:port`. Allowed domains cover
 * HTTP and HTTPS (ports 80 and 443); any other port needs an exact `allowedTcp` entry.
 * IP literals never match, so the allowlist stays a list of host names.
 */
export function egressAllows(policy: ComputerEgressPolicy, host: string, port: number): boolean {
  if (policy.mode === "open") return true;
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (!isEgressDomainPattern(name) || name.startsWith("*.")) return false;
  if (DOMAIN_PORTS.has(port) && policy.allowedDomains.some((entry) => hostMatches(entry, name))) {
    return true;
  }
  return policy.allowedTcp.some((entry) => {
    const target = parseEgressTcpTarget(entry);
    return target?.port === port && hostMatches(target.host, name);
  });
}
