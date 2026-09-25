/**
 * Available Kubernetes releases (VKrs) on the Supervisor, and which newer
 * version a cluster could move to. Best effort: if the releases can't be read,
 * clusters simply show no upgrade information.
 */
import { describeError, SupervisorClient } from './api/client';
import { KubeObject } from './capi/v1beta1';
import { UpgradeInfo } from './types';

export const RELEASE_PATHS = [
  // Long-standing TKr API; still served on VKS 3.x Supervisors.
  '/apis/run.tanzu.vmware.com/v1alpha3/tanzukubernetesreleases',
  // Newer API seen on the same Supervisors; tried if the first gives nothing.
  '/apis/kubernetes.vmware.com/v1alpha1/kubernetesreleases',
];

interface ParsedVersion {
  raw: string;
  parts: [number, number, number, number];
}

/** "v1.36.2+vmware.2" → [1, 36, 2, 2]. Suffixes after the vmware build (e.g. "-fips.1") are ignored. */
export function parseVersion(v: string | undefined): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+vmware\.(\d+))?/.exec((v ?? '').trim());
  if (!m) return null;
  return { raw: v!.trim(), parts: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] };
}

function compare(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 4; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  return 0;
}

function conditionFalse(obj: KubeObject, type: string): boolean {
  const c = Array.isArray(obj.status?.conditions)
    ? obj.status.conditions.find((x: any) => x?.type === type)
    : undefined;
  return c?.status === 'False';
}

/** Versions offered by release objects, skipping ones marked not ready or incompatible. */
export function versionsFromReleases(objs: KubeObject[]): string[] {
  const out = new Set<string>();
  for (const o of objs) {
    if (conditionFalse(o, 'Ready') || conditionFalse(o, 'Compatible')) continue;
    if (o.metadata.labels && 'run.tanzu.vmware.com/incompatible' in o.metadata.labels) continue;
    const v =
      o.spec?.version ?? o.spec?.kubernetes?.version ?? o.spec?.kubernetesVersion ?? o.status?.version;
    if (typeof v === 'string' && parseVersion(v)) out.add(v.trim());
  }
  return Array.from(out);
}

/**
 * Newest version the cluster can move to next. VKS upgrades one minor version
 * at a time, so a newer release in the next minor wins; otherwise a newer
 * patch or build in the current minor.
 */
export function findUpgrade(current: string | undefined, available: string[]): UpgradeInfo | undefined {
  const cur = parseVersion(current);
  if (!cur) return undefined;
  const candidates = available.map(parseVersion).filter((p): p is ParsedVersion => !!p);
  const newest = (list: ParsedVersion[]) => list.sort(compare)[list.length - 1];

  const nextMinor = candidates.filter(p => p.parts[0] === cur.parts[0] && p.parts[1] === cur.parts[1] + 1);
  if (nextMinor.length) return { version: newest(nextMinor).raw, kind: 'minor' };

  const sameMinor = candidates.filter(
    p => p.parts[0] === cur.parts[0] && p.parts[1] === cur.parts[1] && compare(p, cur) > 0
  );
  if (sameMinor.length) return { version: newest(sameMinor).raw, kind: 'patch' };
  return undefined;
}

export async function fetchReleaseVersions(
  client: SupervisorClient
): Promise<{ versions: string[]; warning?: string }> {
  let lastError: unknown;
  for (const path of RELEASE_PATHS) {
    try {
      const list = await client.get<{ items?: KubeObject[] }>(path);
      const versions = versionsFromReleases(list?.items ?? []);
      if (versions.length) return { versions };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    versions: [],
    warning: lastError ? `Upgrade availability unknown: ${describeError(lastError)}` : undefined,
  };
}

/**
 * Versions a cluster may upgrade to next: newer builds in its current minor,
 * and any release in the next minor (VKS moves one minor at a time).
 * Newest first.
 */
export function upgradeTargets(current: string | undefined, available: string[]): string[] {
  const cur = parseVersion(current);
  if (!cur) return [];
  const seen = new Set<string>();
  return available
    .map(parseVersion)
    .filter((p): p is ParsedVersion => !!p)
    .filter(
      p =>
        p.parts[0] === cur.parts[0] &&
        ((p.parts[1] === cur.parts[1] && compare(p, cur) > 0) || p.parts[1] === cur.parts[1] + 1)
    )
    .sort((a, b) => compare(b, a))
    .map(p => p.raw)
    .filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}

/** "v1.36.2+vmware.2" and "v1.37.1+vmware.1" → 'minor'; same minor → 'patch'. */
export function upgradeKind(current: string | undefined, target: string): 'patch' | 'minor' | undefined {
  const a = parseVersion(current);
  const b = parseVersion(target);
  if (!a || !b) return undefined;
  return a.parts[1] === b.parts[1] ? 'patch' : 'minor';
}
