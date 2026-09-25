/**
 * Runbooks: the commands an operator would type for each kind of issue,
 * pre-filled with this cluster's names. Written from real incidents (a
 * deletion stuck on a pinned pod and a volume; a node whose pod networking
 * stopped). Supervisor commands use the Supervisor's kubeconfig context;
 * cluster commands use the cluster's context.
 */
import { FleetCluster, MachineInfo, RunbookStep, StuckObject } from './types';

export interface RunbookContext {
  c: FleetCluster;
  /** kubeconfig context for the Supervisor (also its server address with kubectl vsphere login). */
  sup: string;
  /** kubeconfig context for the workload cluster. */
  ctx: string;
}

export function signIn({ c, sup }: RunbookContext): RunbookStep {
  return {
    title: `Sign in to ${c.name} (skip if you already have its context)`,
    commands: [
      `kubectl vsphere login --server=${sup} --vsphere-username <you@domain> --insecure-skip-tls-verify \\\n  --tanzu-kubernetes-cluster-namespace ${c.namespace} --tanzu-kubernetes-cluster-name ${c.name}`,
    ],
  };
}

export function networkRunbook(r: RunbookContext, node: string, machine?: MachineInfo): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  return [
    signIn(r),
    { title: 'See the pods stuck on the node', commands: [`${k} get pods -A -o wide --field-selector spec.nodeName=${node},status.phase=Pending`] },
    {
      title: "Find the network plugin's pods on that node, and read their logs",
      commands: [
        `${k} get pods -A -o wide --field-selector spec.nodeName=${node} | grep -i -E 'multus|calico|antrea|cni'`,
        `${k} logs -n <namespace> <network-pod> --tail=50`,
      ],
    },
    {
      title: 'Restart them (their DaemonSet recreates them straight away)',
      commands: [`${k} delete pod -n <namespace> <network-pod>`],
    },
    {
      title: 'Still failing? Move the pods off the node',
      commands: [
        `${k} cordon ${node}`,
        `${k} get pods -A --field-selector spec.nodeName=${node},status.phase=Pending \\\n  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name --no-headers |\nwhile read ns name; do ${k} delete pod -n "$ns" "$name" --grace-period=0 --force; done`,
      ],
    },
    {
      title: 'Then have VKS replace the node (the one Machine change VKS allows)',
      commands: [
        `kubectl --context ${r.sup} annotate machine -n ${r.c.namespace} ${machine?.name ?? node} cluster.x-k8s.io/remediate-machine=""`,
      ],
      note: 'Or use Replace on the machine page, which does the same with a dry run first.',
    },
  ];
}

export function stuckDeletionRunbook(r: RunbookContext, m: MachineInfo): RunbookStep[] {
  const node = m.nodeName ?? m.name;
  const k = `kubectl --context ${r.ctx}`;
  const s = `kubectl --context ${r.sup}`;
  return [
    {
      title: 'See which stage the deletion is stuck in (drain, volumes, hooks)',
      commands: [`${s} describe machine -n ${r.c.namespace} ${m.name} | tail -40`],
    },
    signIn(r),
    { title: 'Pods still on the node', commands: [`${k} get pods -A -o wide --field-selector spec.nodeName=${node}`] },
    {
      title: 'Pods that keep coming back: look for a nodeName pin in their owners',
      commands: [`${k} get deploy,statefulset -A -o yaml | grep -n "nodeName: ${node}"`],
      note: 'Remove the pin (kubectl patch … --type json -p \'[{"op":"remove","path":"/spec/template/spec/nodeName"}]\') or scale that workload to 0.',
    },
    {
      title: 'Disks still attached to the node',
      commands: [`${k} get volumeattachment | grep ${node}`],
      note: "A disk stays attached while a pod using it is still on the node. Scale that workload down so it can detach.",
    },
    {
      title: 'Last resort: stop waiting',
      note: 'Use Unblock deletion on the machine page (a drain or volume-detach timeout on the pool), then clear the timeout once the machine is gone.',
    },
  ];
}

export function repairStoppedRunbook(r: RunbookContext): RunbookStep[] {
  const s = `kubectl --context ${r.sup}`;
  return [
    { title: 'Health checks and their limits', commands: [`${s} get machinehealthchecks -n ${r.c.namespace} -o wide`] },
    { title: 'Which machines are unhealthy, and why', commands: [`${s} get machines -n ${r.c.namespace} -o wide | grep ${r.c.name}`, `${s} describe machine -n ${r.c.namespace} <machine> | tail -30`] },
    { title: 'Supervisor warnings for the cluster', commands: [`${s} get events -n ${r.c.namespace} --field-selector type=Warning --sort-by=.lastTimestamp | grep ${r.c.name} | tail -20`] },
  ];
}

export function unreachableRunbook(r: RunbookContext): RunbookStep[] {
  const s = `kubectl --context ${r.sup}`;
  const ep = r.c.endpoint ? `https://${r.c.endpoint.host}:${r.c.endpoint.port}` : '<api-endpoint>';
  return [
    { title: "Is the API answering? (from the machine running Headlamp)", commands: [`curl -k --max-time 5 ${ep}/healthz; echo`] },
    { title: "Control-plane VM and machine state on the Supervisor", commands: [`${s} get vm,machines -n ${r.c.namespace} -o wide | grep ${r.c.name}`] },
    { title: "The cluster's load balancer service on the Supervisor", commands: [`${s} get virtualmachineservices -n ${r.c.namespace} | grep ${r.c.name}`] },
  ];
}

export function podsRunbook(r: RunbookContext, pods: string[]): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  const [ns, name] = (pods[0] ?? '<namespace>/<pod>').split('/');
  return [
    signIn(r),
    { title: 'All pods that are not running', commands: [`${k} get pods -A -o wide | grep -v -E 'Running|Completed'`] },
    { title: `Why ${name} is failing`, commands: [`${k} describe pod -n ${ns} ${name} | tail -25`, `${k} logs -n ${ns} ${name} --all-containers --previous --tail=50`] },
  ];
}

export function packageRunbook(r: RunbookContext, failed: Array<{ namespace: string; name: string }>): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  const first = failed[0] ?? { namespace: '<namespace>', name: '<package-install>' };
  return [
    signIn(r),
    { title: 'Package installs and their status', commands: [`${k} get packageinstalls -A`] },
    {
      title: `kapp-controller's error for ${first.name}`,
      commands: [`${k} get app -n ${first.namespace} ${first.name} -o jsonpath='{.status.usefulErrorMessage}{"\\n"}'`, `${k} describe packageinstall -n ${first.namespace} ${first.name} | tail -20`],
    },
    {
      title: 'Retry after fixing the cause',
      commands: [`${k} annotate app -n ${first.namespace} ${first.name} kapp.k14s.io/reconcile-trigger="$(date +%s)" --overwrite`],
    },
  ];
}

export function serviceRunbook(sup: string, namespace: string): RunbookStep[] {
  const s = `kubectl --context ${sup}`;
  return [
    { title: 'Service pods', commands: [`${s} get pods -n ${namespace} -o wide`] },
    { title: 'Logs of a failing pod', commands: [`${s} logs -n ${namespace} <pod> --all-containers --tail=100`] },
    { title: 'Recent warnings in the service namespace', commands: [`${s} get events -n ${namespace} --field-selector type=Warning --sort-by=.lastTimestamp | tail -20`] },
    {
      title: 'Old failed pods (already replaced) can be removed',
      commands: [`${s} delete pod -n ${namespace} --field-selector=status.phase=Failed`],
    },
  ];
}

export function pvcRunbook(r: RunbookContext, claims: StuckObject[]): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  const s = `kubectl --context ${r.sup}`;
  const first = claims[0];
  return [
    signIn(r),
    { title: `Why ${first?.name ?? 'the claim'} is pending`, commands: [`${k} describe pvc -n ${first?.namespace ?? '<namespace>'} ${first?.name ?? '<claim>'} | tail -15`] },
    { title: 'Storage classes available in the cluster', commands: [`${k} get storageclass`] },
    {
      title: 'Storage quota on the Supervisor namespace',
      commands: [`${s} get resourcequota,storagepolicyquotas -n ${r.c.namespace}`],
      note: 'A claim for a storage class the namespace has no quota or policy for stays Pending.',
    },
  ];
}

export function loadBalancerRunbook(r: RunbookContext, services: StuckObject[]): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  const s = `kubectl --context ${r.sup}`;
  const first = services[0];
  return [
    signIn(r),
    { title: `Events for ${first?.name ?? 'the service'}`, commands: [`${k} describe svc -n ${first?.namespace ?? '<namespace>'} ${first?.name ?? '<service>'} | tail -15`] },
    {
      title: 'Load balancer services the Supervisor created for this cluster',
      commands: [`${s} get virtualmachineservices -n ${r.c.namespace} | grep ${r.c.name}`],
    },
    {
      title: 'Supervisor warnings about IPs or load balancers',
      commands: [`${s} get events -n ${r.c.namespace} --field-selector type=Warning | grep -i -E 'loadbalancer|vip|ip pool|ipaddress'`],
      note: 'A common cause is the namespace network running out of external (load balancer) IPs.',
    },
  ];
}

export function dnsRunbook(r: RunbookContext): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  return [
    signIn(r),
    { title: 'CoreDNS pods and where they run', commands: [`${k} -n kube-system get pods -l k8s-app=kube-dns -o wide`] },
    { title: "Why they're not ready", commands: [`${k} -n kube-system describe pods -l k8s-app=kube-dns | tail -30`] },
    { title: 'Restart CoreDNS once the cause is fixed', commands: [`${k} -n kube-system rollout restart deploy/coredns`] },
  ];
}

export function attachRunbook(r: RunbookContext, machineName: string, node: string): RunbookStep[] {
  const s = `kubectl --context ${r.sup}`;
  return [
    {
      title: 'Attachment status on the Supervisor',
      commands: [
        `${s} get cnsnodevmbatchattachments -n ${r.c.namespace} ${machineName} -o yaml | tail -40`,
        `${s} get events -n ${r.c.namespace} --field-selector involvedObject.name=${machineName}`,
      ],
    },
    signIn(r),
    { title: 'Volume attachments the cluster expects on the node', commands: [`kubectl --context ${r.ctx} get volumeattachment | grep ${node}`] },
  ];
}

export function hotNodeRunbook(r: RunbookContext, node: string): RunbookStep[] {
  const k = `kubectl --context ${r.ctx}`;
  return [
    signIn(r),
    { title: 'Busiest pods on the node', commands: [`${k} top pods -A --sort-by=memory | head -15`, `${k} get pods -A -o wide --field-selector spec.nodeName=${node}`] },
    { title: 'What the node has promised (requests and limits)', commands: [`${k} describe node ${node} | sed -n '/Allocated resources/,/Events/p'`] },
    {
      title: 'Then: spread or grow',
      note: 'Set requests and limits on the heavy pods so the scheduler spreads them, or scale the node pool (Scale on the cluster page, checked against quota on the Capacity page).',
    },
  ];
}
