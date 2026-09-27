/**
 * Keeps a large fleet from opening hundreds of requests at once: at most
 * MAX_PER_CLUSTER in flight per cluster and MAX_TOTAL overall; the rest wait
 * in order. Also counts requests per cluster, for the diagnostics in Settings.
 */
export const MAX_PER_CLUSTER = 6;
export const MAX_TOTAL = 24;

interface Waiting {
  cluster: string;
  start: () => void;
}

const inFlight = new Map<string, number>();
let total = 0;
const queue: Waiting[] = [];

export interface ClusterStats {
  cluster: string;
  requests: number;
  errors: number;
  totalMs: number;
  slowestMs: number;
  lastError?: string;
}
const stats = new Map<string, ClusterStats>();
const since = Date.now();

function pump() {
  for (let i = 0; i < queue.length && total < MAX_TOTAL; ) {
    const w = queue[i];
    if ((inFlight.get(w.cluster) ?? 0) < MAX_PER_CLUSTER) {
      queue.splice(i, 1);
      w.start();
    } else i++;
  }
}

export function limited<T>(cluster: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      total += 1;
      inFlight.set(cluster, (inFlight.get(cluster) ?? 0) + 1);
      const t0 = Date.now();
      const s = stats.get(cluster) ?? { cluster, requests: 0, errors: 0, totalMs: 0, slowestMs: 0 };
      stats.set(cluster, s);
      fn()
        .then(resolve, err => {
          s.errors += 1;
          s.lastError = String((err as Error)?.message ?? err).slice(0, 160);
          reject(err);
        })
        .finally(() => {
          const ms = Date.now() - t0;
          s.requests += 1;
          s.totalMs += ms;
          s.slowestMs = Math.max(s.slowestMs, ms);
          total -= 1;
          inFlight.set(cluster, (inFlight.get(cluster) ?? 1) - 1);
          pump();
        });
    };
    queue.push({ cluster, start });
    pump();
  });
}

export function requestStats(): { since: number; waiting: number; inFlight: number; clusters: ClusterStats[] } {
  return { since, waiting: queue.length, inFlight: total, clusters: Array.from(stats.values()).sort((a, b) => b.requests - a.requests) };
}
