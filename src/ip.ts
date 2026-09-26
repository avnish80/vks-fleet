/** IPv4 helpers for subnet usage and the IP map. */

export function ipToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return undefined;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function parseCidr(cidr: string): { base: number; prefix: number } | undefined {
  const [ip, p] = cidr.split('/');
  const base = ipToInt(ip);
  const prefix = p === undefined ? 32 : Number(p);
  if (base === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, prefix };
}

export function cidrContains(cidr: string, ip: string): boolean {
  const c = parseCidr(cidr);
  const n = ipToInt(ip.split('/')[0]);
  if (!c || n === undefined) return false;
  const mask = c.prefix === 0 ? 0 : (~0 << (32 - c.prefix)) >>> 0;
  return ((n & mask) >>> 0) === c.base;
}

export function cidrSize(cidr: string): number {
  const c = parseCidr(cidr);
  return c ? 2 ** (32 - c.prefix) : 0;
}

/** Addresses a workload can get: size minus network, gateway and broadcast. */
export function usableAddresses(cidr: string): number {
  return Math.max(0, cidrSize(cidr) - 3);
}

export const isIPv4 = (s: string) => ipToInt(s) !== undefined;

/** Whether two CIDR ranges share any address. */
export function cidrOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  const end = (c: { base: number; prefix: number }) => c.base + 2 ** (32 - c.prefix) - 1;
  return x.base <= end(y) && y.base <= end(x);
}
