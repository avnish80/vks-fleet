/**
 * Tenant isolation report (Supervisor side): is each org really separated
 * from the others? Built from what the plugin already reads: VPCs, subnets,
 * public addresses, firewall policies and who has access to each namespace.
 */
import { AccessEntry, Inventory, SupervisorResult } from './types';
import { cidrContains, cidrOverlap } from './ip';

export type IsoStatus = 'pass' | 'fail' | 'review' | 'unknown';

export interface IsoCheck {
  id: string;
  title: string;
  status: IsoStatus;
  detail: string;
}

export interface OrgIsolation {
  orgId: string;
  org: string;
  namespaces: string[];
  checks: IsoCheck[];
}

export const ISO_CHECKS: Array<{ id: string; title: string }> = [
  { id: 'vpc', title: 'Own VPC' },
  { id: 'public-ips', title: 'Public addresses not shared' },
  { id: 'routed-ranges', title: 'Routed ranges don\u2019t overlap' },
  { id: 'shared-subnets', title: 'No shared subnets' },
  { id: 'access', title: 'No people shared with other orgs' },
  { id: 'firewall', title: 'Firewall policies' },
];

export function isolationReport(
  results: SupervisorResult[],
  inventories: Map<string, Inventory> | null,
  bindings: Map<string, AccessEntry[]> | null
): OrgIsolation[] {
  const orgOf = new Map<string, { id: string; name: string }>();
  for (const r of results) for (const n of r.namespaces ?? []) orgOf.set(n.name, { id: n.tenantId, name: n.tenantName });
  const invs = Array.from(inventories?.values() ?? []);
  const vpcs = invs.flatMap(i => i.vpcs);
  const subnets = invs.flatMap(i => i.subnets);
  const lbs = invs.flatMap(i => i.lbs);
  const vms = invs.flatMap(i => i.vms.filter(v => !v.cluster));
  const nsx = invs.flatMap(i => i.nsx);
  const orgs = new Map<string, { id: string; name: string; namespaces: string[] }>();
  for (const [ns, o] of orgOf) {
    const cur = orgs.get(o.id) ?? { ...o, namespaces: [] };
    cur.namespaces.push(ns);
    orgs.set(o.id, cur);
  }
  const otherOrg = (ns: string, id: string) => orgOf.get(ns) && orgOf.get(ns)!.id !== id;

  return Array.from(orgs.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(o => {
      const mine = new Set(o.namespaces);
      const checks: IsoCheck[] = [];

      // 1. Own VPC: a VPC (name and outbound NAT address) used by no other org.
      const myVpcs = vpcs.filter(v => mine.has(v.namespace));
      if (!inventories) checks.push({ id: 'vpc', title: 'Own VPC', status: 'unknown', detail: 'Still reading.' });
      else if (!myVpcs.length) checks.push({ id: 'vpc', title: 'Own VPC', status: 'unknown', detail: 'No VPC information (not a VPC-networked Supervisor, or not readable).' });
      else {
        const clash = myVpcs.filter(v => vpcs.some(w => otherOrg(w.namespace, o.id) && w.name === v.name && w.snatIP && w.snatIP === v.snatIP));
        checks.push(
          clash.length
            ? { id: 'vpc', title: 'Own VPC', status: 'fail', detail: `Shares VPC ${clash[0].name} (NAT ${clash[0].snatIP}) with another org.` }
            : { id: 'vpc', title: 'Own VPC', status: 'pass', detail: myVpcs.map(v => `${v.name}${v.snatIP ? ` (NAT ${v.snatIP})` : ''}`).filter((x, i, a) => a.indexOf(x) === i).join(', ') }
        );
      }

      // 2. Public addresses (load balancer VIPs, VMs on public subnets) used by one org only.
      const publicOf = (nsFilter: (ns: string) => boolean) => [
        ...lbs.filter(l => l.vip && nsFilter(l.namespace)).map(l => l.vip!),
        ...vms.filter(v => v.ip && nsFilter(v.namespace) && subnets.some(s => s.namespace === v.namespace && s.accessMode === 'Public' && s.cidrs.some(c => cidrContains(c, v.ip!)))).map(v => v.ip!),
      ];
      const myPublic = new Set(publicOf(ns => mine.has(ns)));
      const theirs = new Set(publicOf(ns => !!otherOrg(ns, o.id)));
      const dup = Array.from(myPublic).filter(ip => theirs.has(ip));
      checks.push(
        !inventories
          ? { id: 'public-ips', title: 'Public addresses not shared', status: 'unknown', detail: 'Still reading.' }
          : dup.length
          ? { id: 'public-ips', title: 'Public addresses not shared', status: 'fail', detail: `Also used by another org: ${dup.join(', ')}` }
          : { id: 'public-ips', title: 'Public addresses not shared', status: 'pass', detail: `${myPublic.size} public address${myPublic.size === 1 ? '' : 'es'}, none shared.` }
      );

      // 3. Ranges that are routed outside the VPC (public, or private through the transit gateway) must not overlap.
      const routed = (s: { accessMode?: string }) => s.accessMode === 'Public' || /TGW/i.test(s.accessMode ?? '');
      const mineRouted = subnets.filter(s => mine.has(s.namespace) && routed(s));
      const pairs = mineRouted.flatMap(s =>
        subnets
          .filter(t => otherOrg(t.namespace, o.id) && routed(t) && s.cidrs.some(a => t.cidrs.some(b => cidrOverlap(a, b))))
          .map(t => ({ publicClash: s.accessMode === 'Public' && t.accessMode === 'Public', text: `${s.name} ${s.cidrs.join(',')} overlaps ${orgOf.get(t.namespace)!.name}'s ${t.name} ${t.cidrs.join(',')}` }))
      );
      // Public ranges must never overlap; transit-gateway ranges only clash if the orgs share a gateway (not visible here).
      const publicClash = pairs.filter(p => p.publicClash);
      checks.push(
        !inventories
          ? { id: 'routed-ranges', title: 'Routed ranges don\u2019t overlap', status: 'unknown', detail: 'Still reading.' }
          : publicClash.length
          ? { id: 'routed-ranges', title: 'Routed ranges don\u2019t overlap', status: 'fail', detail: publicClash.slice(0, 3).map(p => p.text).join('; ') }
          : pairs.length
          ? {
              id: 'routed-ranges',
              title: 'Routed ranges don\u2019t overlap',
              status: 'review',
              detail: `${pairs.slice(0, 3).map(p => p.text).join('; ')}. A conflict only if both orgs route through the same transit gateway.`,
            }
          : { id: 'routed-ranges', title: 'Routed ranges don\u2019t overlap', status: 'pass', detail: `${mineRouted.length} routed subnet${mineRouted.length === 1 ? '' : 's'}; private VPC ranges may repeat across orgs by design.` }
      );

      // 4. Shared subnets connect namespaces across projects: fine if intended, worth a look.
      const shared = subnets.filter(s => mine.has(s.namespace) && s.shared);
      checks.push(
        shared.length
          ? { id: 'shared-subnets', title: 'No shared subnets', status: 'review', detail: `Shared subnets: ${shared.map(s => s.name).join(', ')}. Confirm who else is on them.` }
          : { id: 'shared-subnets', title: 'No shared subnets', status: inventories ? 'pass' : 'unknown', detail: inventories ? 'None.' : 'Still reading.' }
      );

      // 5. People or groups with access to this org and another one.
      if (!bindings) checks.push({ id: 'access', title: 'No people shared with other orgs', status: 'unknown', detail: 'Access not readable yet.' });
      else {
        const who = (nsFilter: (ns: string) => boolean) =>
          new Set(
            Array.from(bindings.entries())
              .filter(([ns]) => nsFilter(ns))
              .flatMap(([, es]) => es.filter(e => !e.system).map(e => `${e.subjectKind} ${e.subject}`))
          );
        const mineWho = who(ns => mine.has(ns));
        const theirsWho = who(ns => !!otherOrg(ns, o.id));
        const both = Array.from(mineWho).filter(x => theirsWho.has(x));
        checks.push(
          both.length
            ? { id: 'access', title: 'No people shared with other orgs', status: 'review', detail: `Also have access to another org: ${both.slice(0, 4).join(', ')}${both.length > 4 ? '…' : ''}. Fine for platform administrators; check the rest.` }
            : { id: 'access', title: 'No people shared with other orgs', status: 'pass', detail: `${mineWho.size} people or groups, none shared with another org.` }
        );
      }

      // 6. Firewall: explicit security policies in the org's namespaces.
      const policies = nsx.filter(x => x.kind === 'SecurityPolicy' && x.namespace && mine.has(x.namespace));
      checks.push(
        !inventories
          ? { id: 'firewall', title: 'Firewall policies', status: 'unknown', detail: 'Still reading.' }
          : policies.length
          ? { id: 'firewall', title: 'Firewall policies', status: policies.some(p => p.ready === false) ? 'fail' : 'pass', detail: `${policies.length} security polic${policies.length === 1 ? 'y' : 'ies'}${policies.some(p => p.ready === false) ? ', some not applied' : ', all applied'}.` }
          : { id: 'firewall', title: 'Firewall policies', status: 'review', detail: "No SecurityPolicy objects: traffic follows the VPC's default rules. Confirm they match your isolation needs." }
      );

      return { orgId: o.id, org: o.name, namespaces: o.namespaces.sort(), checks };
    });
}

export function isolationMarkdown(rows: OrgIsolation[], now: Date = new Date()): string {
  const out = [
    '# Tenant isolation report',
    '',
    `Generated ${now.toISOString().replace('T', ' ').slice(0, 16)} UTC by the vks-fleet Headlamp plugin, from the Supervisor's view.`,
    '',
    `| Org | ${ISO_CHECKS.map(c => c.title).join(' | ')} |`,
    `|---|${ISO_CHECKS.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.org} | ${ISO_CHECKS.map(c => r.checks.find(x => x.id === c.id)?.status ?? '—').join(' | ')} |`),
  ];
  for (const r of rows) {
    out.push('', `## ${r.org}`, '', `Namespaces: ${r.namespaces.join(', ')}`, '');
    for (const c of r.checks) out.push(`- **${c.title}: ${c.status}.** ${c.detail}`);
  }
  return out.join('\n');
}

/** Isolation failures as fleet issues (shared VPCs, public addresses or routed ranges between orgs). */
export function isolationIssues(rows: OrgIsolation[], supervisorId: string, now: Date = new Date()): import('./types').Issue[] {
  return rows.flatMap(r =>
    r.checks
      .filter(c => c.status === 'fail')
      .map(c => ({
        id: `${supervisorId}#isolation#${r.orgId}#${c.id}`,
        severity: (c.id === 'firewall' ? 'warning' : 'critical') as 'warning' | 'critical',
        supervisorId,
        title: `Tenant isolation: ${r.org} fails "${c.title}"`,
        cause: c.detail,
        evidence: [`Namespaces: ${r.namespaces.join(', ')}`],
        affected: { clusters: [], tenants: [r.org], nodes: [], pods: [] },
        fix: 'Give each org its own VPC, addresses and routed ranges (in VCF Automation or NSX), then check the report again.',
        primary: { label: 'Compliance', path: '/vks-fleet/compliance' },
        links: [],
        findingIds: [],
        detectedAt: now.toISOString(),
      }))
  );
}
