/** Pure helpers for "since your last visit" and the command palette. */
import { Issue } from './types';

export function diffSeen(previous: Record<string, string> | undefined, current: Issue[]) {
  const prev = previous ?? {};
  const now = new Map(current.map(i => [i.id, i]));
  return {
    added: current.filter(i => !(i.id in prev)),
    resolved: Object.entries(prev)
      .filter(([id]) => !now.has(id))
      .map(([id, title]) => ({ id, title })),
  };
}

export interface PaletteEntry {
  kind: 'Page' | 'Cluster' | 'VM' | 'Namespace' | 'Search';
  label: string;
  hint?: string;
  path: string;
}

/** Entries matching every word of the query, best matches first. */
export function rankEntries(entries: PaletteEntry[], query: string, limit = 12): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.filter(e => e.kind === 'Page').slice(0, limit);
  const score = (e: PaletteEntry) => {
    const text = `${e.label} ${e.hint ?? ''} ${e.kind}`.toLowerCase();
    if (!words.every(w => text.includes(w))) return -1;
    const label = e.label.toLowerCase();
    return 1 + (label.startsWith(words[0]) ? 10 : 0) + (label.includes(words.join(' ')) ? 5 : 0) + (e.kind === 'Page' ? 2 : 0) - Math.min(label.length, 90) / 100;
  };
  return entries
    .map(e => ({ e, s: score(e) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.e);
}
