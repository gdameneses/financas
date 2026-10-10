// Client IP extraction and CIDR matching (IPv4 + IPv6), no dependencies.

/**
 * Only `cf-connecting-ip` is trusted: Cloudflare sets it on every request and strips a
 * client-supplied one. Outside Cloudflare (wrangler dev, ngrok) there is no trustworthy
 * source, so everything is 127.0.0.1; use LIBERADO=true for demos through a tunnel.
 */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "127.0.0.1";
}

/** Rate-limit bucket: exact IPv4, /64 for IPv6 (a host usually owns a whole /64). */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const bits = parseV6(ip);
  if (bits === null) return ip;
  const prefix = bits >> 64n;
  return `${prefix.toString(16)}::/64`;
}

export function parseCidr(cidr: string): { bits: bigint; prefix: number; size: number } | null {
  const [addr, p] = cidr.trim().split("/");
  const v6 = addr.includes(":");
  const size = v6 ? 128 : 32;
  const bits = v6 ? parseV6(addr) : parseV4(addr);
  if (bits === null) return null;
  const prefix = p === undefined ? size : Number(p);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > size) return null;
  return { bits, prefix, size };
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr);
  const a = parseCidr(ip);
  if (!c || !a || a.size !== c.size) return false;
  const shift = BigInt(c.size - c.prefix);
  return a.bits >> shift === c.bits >> shift;
}

export function ipAllowed(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    out = (out << 8n) | BigInt(Number(p));
  }
  return out;
}

function parseV6(s: string): bigint | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}
