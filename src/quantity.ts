/** Kubernetes resource quantities ("8", "500m", "32Gi", "1.5T") as numbers. */

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

export function parseQuantity(q: unknown): number | undefined {
  if (typeof q === 'number') return Number.isFinite(q) ? q : undefined;
  if (typeof q !== 'string') return undefined;
  const m = /^\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([a-zA-Z]{0,2})\s*$/.exec(q);
  if (!m) return undefined;
  const value = Number(m[1]);
  const suffix = m[2];
  const factor = BINARY[suffix] ?? DECIMAL[suffix];
  return factor === undefined ? undefined : value * factor;
}

export function formatBytes(bytes: number): string {
  const gib = bytes / 2 ** 30;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1).replace(/\.0$/, '')} TiB`;
  if (gib >= 1) return `${gib.toFixed(gib >= 100 ? 0 : 1).replace(/\.0$/, '')} GiB`;
  return `${Math.round(bytes / 2 ** 20)} MiB`;
}
