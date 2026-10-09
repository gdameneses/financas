import { describe, it, expect } from "vitest";
import { ipInCidr, parseCidr, ipAllowed } from "../src/lib/ip";

describe("ip / cidr", () => {
  it("matches exact IPv4 and ranges", () => {
    expect(ipInCidr("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipInCidr("203.0.113.8", "203.0.113.7")).toBe(false);
    expect(ipInCidr("203.0.113.200", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.114.1", "203.0.113.0/24")).toBe(false);
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
  });
  it("matches IPv6 with :: compression", () => {
    expect(ipInCidr("2804:14d:1::1", "2804:14d::/32")).toBe(true);
    expect(ipInCidr("2804:14e::1", "2804:14d::/32")).toBe(false);
    expect(ipInCidr("::1", "::1")).toBe(true);
  });
  it("never cross-matches families and rejects garbage", () => {
    expect(ipInCidr("::1", "127.0.0.1")).toBe(false);
    expect(parseCidr("300.1.1.1")).toBeNull();
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("abc")).toBeNull();
    expect(ipAllowed("1.2.3.4", [])).toBe(false);
  });
});
