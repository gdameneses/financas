import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetDb, Browser, ORIGIN } from "./helpers";
import { SECURITY_HEADERS, crossSiteWrite } from "../src/lib/security";

describe("security headers", () => {
  beforeEach(resetDb);

  it("are on gate redirects, gate pages and 404s", async () => {
    const b = new Browser("203.0.113.9");
    for (const path of ["/", "/acesso", "/nao-existe"]) {
      const res = await b.fetch(path);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), `${path} ${k}`).toBe(v);
    }
  });

  it("forbid framing", () => {
    expect(SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
    expect(SECURITY_HEADERS["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

describe("cross-site writes", () => {
  beforeEach(resetDb);

  const req = (method: string, headers: Record<string, string>) => new Request(ORIGIN + "/acesso", { method, headers });

  it("lets same-origin and header-less writes through, blocks other origins", () => {
    expect(crossSiteWrite(req("POST", { origin: ORIGIN }))).toBe(false);
    expect(crossSiteWrite(req("POST", {}))).toBe(false);
    expect(crossSiteWrite(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(crossSiteWrite(req("POST", { origin: "https://evil.example" }))).toBe(true);
    expect(crossSiteWrite(req("POST", { origin: "null" }))).toBe(true);
    expect(crossSiteWrite(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(crossSiteWrite(req("GET", { origin: "https://evil.example" }))).toBe(false);
  });

  it("answers 403 and logs the attempt as cross_site", async () => {
    const b = new Browser("203.0.113.10");
    const res = await b.fetch("/acesso", { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ email: "x@example.com" }) });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    await new Promise((r) => setTimeout(r, 50));
    const row = await env.DB.prepare("SELECT outcome, status FROM access_log ORDER BY id DESC LIMIT 1").first<{ outcome: string; status: number }>();
    expect(row).toEqual({ outcome: "cross_site", status: 403 });
  });
});
