/**
 * Shorter display names. VKS names are long and share prefixes
 * ("kubernetes-cluster-a1b2", nodes "kubernetes-cluster-c3d4-kubernetes-cluster-c3d4-np-1-7d8jrql2vq"),
 * which truncate to the same "kubernetes-clus…" everywhere. The full name
 * stays available (tooltips, links); only the label is shortened.
 */

/** The prefix all names share, up to a "-" boundary, when there are several and every name keeps something after it. */
export function commonPrefix(names: string[]): string {
  const uniq = Array.from(new Set(names));
  if (uniq.length < 2) return '';
  let p = uniq[0];
  for (const n of uniq) while (p && !n.startsWith(p)) p = p.slice(0, -1);
  const cut = p.lastIndexOf('-');
  if (cut <= 0) return '';
  p = p.slice(0, cut + 1);
  return uniq.every(n => n.length > p.length) ? p : '';
}

/** A function shortening each of these names by their shared prefix. */
export function shortener(names: string[]): (name: string) => string {
  const p = commonPrefix(names);
  return name => (p && name.startsWith(p) ? name.slice(p.length) : name);
}

/** A node's name without its cluster's name in front (VKS can repeat it). */
export function shortNode(cluster: string, node: string): string {
  let n = node;
  while (n.startsWith(`${cluster}-`) && n.length > cluster.length + 1) n = n.slice(cluster.length + 1);
  return n;
}
