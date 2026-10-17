import { describe, expect, it } from "vitest";
import {
  ComputerEgressPolicySchema,
  egressAllows,
  MAX_EGRESS_ALLOWED_DOMAINS,
  OPEN_COMPUTER_EGRESS,
  parseEgressTcpTarget,
} from "./egress.js";

const restricted = (allowedDomains: string[], allowedTcp: string[] = []) =>
  ComputerEgressPolicySchema.parse({ mode: "restricted", allowedDomains, allowedTcp });

describe("computer egress policy validation", () => {
  it("normalizes case and whitespace and drops duplicates", () => {
    expect(
      restricted([" PyPI.org ", "pypi.org", "*.GitHubUserContent.com"], ["GitHub.com:22"]),
    ).toEqual({
      mode: "restricted",
      allowedDomains: ["pypi.org", "*.githubusercontent.com"],
      allowedTcp: ["github.com:22"],
    });
  });

  it.each([
    "localhost",
    "10.0.0.1",
    "169.254.169.254",
    "[::1]",
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "*.com.",
    "*example.com",
    "a.*.example.com",
    "-bad.example.com",
    "",
    `${"a".repeat(64)}.com`,
  ])("rejects %j as an allowed domain", (value) => {
    expect(
      ComputerEgressPolicySchema.safeParse({
        mode: "restricted",
        allowedDomains: [value],
        allowedTcp: [],
      }).success,
    ).toBe(false);
  });

  it.each(["github.com", "github.com:0", "github.com:65536", "10.0.0.1:22", "*.example.com:x"])(
    "rejects %j as a TCP target",
    (value) => {
      expect(parseEgressTcpTarget(value)).toBeUndefined();
      expect(
        ComputerEgressPolicySchema.safeParse({
          mode: "restricted",
          allowedDomains: [],
          allowedTcp: [value],
        }).success,
      ).toBe(false);
    },
  );

  it("caps the allowlist size", () => {
    const domains = Array.from({ length: MAX_EGRESS_ALLOWED_DOMAINS + 1 }, (_, i) => `h${i}.test`);
    expect(
      ComputerEgressPolicySchema.safeParse({
        mode: "restricted",
        allowedDomains: domains,
        allowedTcp: [],
      }).success,
    ).toBe(false);
  });
});

describe("egressAllows", () => {
  it("allows everything when open", () => {
    expect(egressAllows(OPEN_COMPUTER_EGRESS, "anything.example", 25)).toBe(true);
  });

  it("matches exact hosts on HTTP and HTTPS ports only", () => {
    const policy = restricted(["pypi.org"]);
    expect(egressAllows(policy, "pypi.org", 443)).toBe(true);
    expect(egressAllows(policy, "PyPI.org.", 80)).toBe(true);
    expect(egressAllows(policy, "pypi.org", 8443)).toBe(false);
    expect(egressAllows(policy, "files.pypi.org", 443)).toBe(false);
    expect(egressAllows(policy, "evilpypi.org", 443)).toBe(false);
    expect(egressAllows(policy, "pypi.org.evil.test", 443)).toBe(false);
  });

  it("matches wildcard subdomains but not the apex", () => {
    const policy = restricted(["*.githubusercontent.com"]);
    expect(egressAllows(policy, "raw.githubusercontent.com", 443)).toBe(true);
    expect(egressAllows(policy, "a.b.githubusercontent.com", 443)).toBe(true);
    expect(egressAllows(policy, "githubusercontent.com", 443)).toBe(false);
    expect(egressAllows(policy, "evilgithubusercontent.com", 443)).toBe(false);
  });

  it("allows other ports only through exact TCP entries", () => {
    const policy = restricted(["github.com"], ["github.com:22"]);
    expect(egressAllows(policy, "github.com", 22)).toBe(true);
    expect(egressAllows(policy, "github.com", 2222)).toBe(false);
    expect(egressAllows(policy, "gitlab.com", 22)).toBe(false);
  });

  it("never matches IP literals or malformed hosts", () => {
    const policy = restricted(["example.com"]);
    expect(egressAllows(policy, "93.184.216.34", 443)).toBe(false);
    expect(egressAllows(policy, "[::1]", 443)).toBe(false);
    expect(egressAllows(policy, "*.example.com", 443)).toBe(false);
    expect(egressAllows(policy, "", 443)).toBe(false);
  });
});
