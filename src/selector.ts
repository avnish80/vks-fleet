/** Kubernetes label selectors (matchLabels + matchExpressions). */
export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

/** An empty selector matches everything; a missing one matches nothing. */
export function matchesSelector(selector: LabelSelector | null | undefined, labels: Record<string, string> = {}): boolean {
  if (!selector) return false;
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) {
    if (labels[k] !== v) return false;
  }
  for (const e of selector.matchExpressions ?? []) {
    const has = e.key in labels;
    const vals = e.values ?? [];
    switch (e.operator) {
      case 'In':
        if (!has || !vals.includes(labels[e.key])) return false;
        break;
      case 'NotIn':
        if (has && vals.includes(labels[e.key])) return false;
        break;
      case 'Exists':
        if (!has) return false;
        break;
      case 'DoesNotExist':
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}
