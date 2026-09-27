/**
 * Runs a kube-bench node scan in one cluster, step by step:
 * namespace → Jobs (control plane and worker) → wait → read JSON from the pod
 * logs → store the summary in the results ConfigMap → delete the Jobs.
 * Everything goes through the cluster's own context; the caller supplies the
 * client and writer, so the sequence is testable without a cluster.
 */
import { statusOf, SupervisorClient, SupervisorWriter } from './api/client';
import {
  addRun,
  jobManifest,
  NodeScanRun,
  parseKubeBench,
  readRuns,
  RESULTS_CM,
  resultsConfigMap,
  SCAN_NS,
  scanNamespaceManifest,
  ScanTarget,
  isForeignBenchmark,
} from './nodeScan';

export interface ScanStep {
  text: string;
  state: 'running' | 'done' | 'failed' | 'skipped';
}

export interface ScanOptions {
  image: string;
  /** CIS benchmark to use (e.g. cis-1.10), or "auto" to let kube-bench guess. */
  benchmark?: string;
  targets?: ScanTarget[];
  dryRun?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const BAD_WAIT = /ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerConfigError|CreateContainerError/;

export async function runNodeScan(
  client: SupervisorClient,
  writer: SupervisorWriter,
  opts: ScanOptions,
  progress: (steps: ScanStep[]) => void
): Promise<{ ok: boolean; runs: NodeScanRun[]; message: string }> {
  const steps: ScanStep[] = [];
  // Each step keeps a reference to its own entry, so its text can change while it runs.
  const step = (text: string) => {
    const entry: ScanStep = { text, state: 'running' };
    steps.push(entry);
    progress(steps.map(x => ({ ...x })));
    return (state: ScanStep['state'], note?: string) => {
      entry.state = state;
      entry.text = note ? `${text}: ${note}` : text;
      progress(steps.map(x => ({ ...x })));
    };
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const targets = opts.targets ?? ['control-plane', 'worker'];
  const dry = !!opts.dryRun;

  // 1. Namespace (it may already exist from an earlier scan).
  let done = step(`Namespace ${SCAN_NS}`);
  let nsExists = false;
  try {
    await client.get(`/api/v1/namespaces/${SCAN_NS}`);
    nsExists = true;
    done('done', 'exists');
  } catch (err) {
    if (statusOf(err) !== 404) {
      done('failed', String((err as Error).message));
      return { ok: false, runs: [], message: 'Could not read the scan namespace.' };
    }
    try {
      await writer.send({ method: 'POST', path: '/api/v1/namespaces', contentType: 'application/json', body: scanNamespaceManifest() }, dry);
      done('done', dry ? 'would be created (privileged Pod Security)' : 'created (privileged Pod Security)');
    } catch (e) {
      done('failed', String((e as Error).message));
      return { ok: false, runs: [], message: 'Creating the scan namespace was refused.' };
    }
  }

  // 2. Jobs, with unique names so an earlier run never gets in the way.
  const stamp = now().getTime().toString(36);
  const names: Record<string, string> = {};
  for (const t of targets) {
    const manifest = jobManifest(t, opts.image, opts.benchmark);
    manifest.metadata.name = `${manifest.metadata.name}-${stamp}`;
    names[t] = manifest.metadata.name;
    done = step(`Job for ${t === 'control-plane' ? 'the control plane' : 'a worker node'}`);
    if (dry && !nsExists) {
      done('skipped', 'checked once the namespace exists');
      continue;
    }
    try {
      await writer.send({ method: 'POST', path: `/apis/batch/v1/namespaces/${SCAN_NS}/jobs`, contentType: 'application/json', body: manifest }, dry);
      done('done', dry ? 'accepted in a dry run' : 'started');
    } catch (e) {
      done('failed', String((e as Error).message));
      return { ok: false, runs: [], message: 'Creating the scan Job was refused.' };
    }
  }
  if (dry) return { ok: true, runs: [], message: 'The dry run passed: the scan can run.' };

  // 3. Wait for each Job, reading its result from the pod's log.
  const collected: NodeScanRun[] = [];
  const deadline = now().getTime() + (opts.timeoutMs ?? 6 * 60 * 1000);
  for (const t of targets) {
    done = step(`Scanning ${t === 'control-plane' ? 'the control plane' : 'a worker node'}`);
    let finished = false;
    const startedAt = now().getTime();
    let lastEvent = '';
    while (!finished) {
      if (now().getTime() > deadline) {
        done('failed', `timed out${lastEvent ? ` (last event: ${lastEvent})` : ''}`);
        break;
      }
      try {
        const job: any = await client.get(`/apis/batch/v1/namespaces/${SCAN_NS}/jobs/${names[t]}`);
        const pods: any = await client.get(`/api/v1/namespaces/${SCAN_NS}/pods?labelSelector=${encodeURIComponent(`job-name=${names[t]}`)}`);
        const pod = pods?.items?.[0];
        const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason;
        const unschedulable = (pod?.status?.conditions ?? []).find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
        if (waiting && BAD_WAIT.test(waiting)) {
          done('failed', `${waiting}: can the cluster pull ${opts.image}? (set a mirrored image for air-gapped sites)`);
          break;
        }
        // Slow or stuck: say why (pulling a large image, or pod networking failing on the node).
        if (pod && !(job?.status?.succeeded > 0) && now().getTime() - startedAt > 45000) {
          try {
            const evs: any = await client.get(`/api/v1/namespaces/${SCAN_NS}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${pod.metadata.name}`)}`);
            const last = (evs?.items ?? []).sort((a: any, b: any) => String(a.lastTimestamp ?? a.eventTime ?? '').localeCompare(String(b.lastTimestamp ?? b.eventTime ?? ''))).pop();
            if (last) {
              lastEvent = `${last.reason}: ${String(last.message ?? '').slice(0, 160)}`;
              const s = steps[steps.length - 1];
              s.text = `${s.text.split(' (still')[0]} (still ${waiting ?? 'waiting'}: ${lastEvent})`;
              progress(steps.map(x => ({ ...x })));
            }
          } catch {
            // Events are a courtesy; carry on.
          }
        }
        if (unschedulable && now().getTime() - startedAt > 60000) {
          done('failed', `can't be scheduled: ${unschedulable.message ?? unschedulable.reason}`);
          break;
        }
        if ((job?.status?.failed ?? 0) > 0) {
          done('failed', 'kube-bench failed; see its pod log');
          break;
        }
        if ((job?.status?.succeeded ?? 0) > 0 && pod) {
          const log: any = await client.get(`/api/v1/namespaces/${SCAN_NS}/pods/${pod.metadata.name}/log`);
          const parsed = parseKubeBench(log);
          collected.push({ at: now().toISOString(), target: t, node: pod.spec?.nodeName, benchmark: parsed.benchmark, tests: parsed.tests });
          const fails = parsed.tests.filter(x => x.status === 'FAIL').length;
          done(
            'done',
            `${parsed.tests.length} checks, ${fails} failing${parsed.benchmark ? ` (${parsed.benchmark})` : ''}${
              isForeignBenchmark(parsed.benchmark) ? ' — wrong benchmark for VKS, results not counted' : ''
            }`
          );
          finished = true;
          break;
        }
      } catch (e) {
        if (statusOf(e) !== 404) {
          done('failed', String((e as Error).message));
          break;
        }
      }
      await sleep(opts.pollMs ?? 5000);
    }
  }

  // 4. Keep the results in the cluster.
  if (collected.length) {
    done = step(`Saving results to ${SCAN_NS}/${RESULTS_CM}`);
    try {
      let existing: NodeScanRun[] = [];
      let exists = true;
      try {
        existing = readRuns(await client.get(`/api/v1/namespaces/${SCAN_NS}/configmaps/${RESULTS_CM}`));
      } catch (e) {
        if (statusOf(e) === 404) exists = false;
        else throw e;
      }
      let runs = existing;
      for (const r of collected) runs = addRun(runs, r);
      const cm = resultsConfigMap(runs);
      await writer.send(
        exists
          ? { method: 'PATCH', path: `/api/v1/namespaces/${SCAN_NS}/configmaps/${RESULTS_CM}`, contentType: 'application/merge-patch+json', body: { data: cm.data } }
          : { method: 'POST', path: `/api/v1/namespaces/${SCAN_NS}/configmaps`, contentType: 'application/json', body: cm },
        false
      );
      done('done');
    } catch (e) {
      done('failed', String((e as Error).message));
    }
  }

  // 5. Remove the Jobs (their pods go with them).
  done = step('Cleaning up the scan Jobs');
  for (const t of targets) {
    try {
      await writer.send({ method: 'DELETE', path: `/apis/batch/v1/namespaces/${SCAN_NS}/jobs/${names[t]}?propagationPolicy=Background` }, false);
    } catch {
      // ttlSecondsAfterFinished removes them within the hour anyway.
    }
  }
  done('done');
  const ok = collected.length === targets.length;
  return {
    ok,
    runs: collected,
    message: ok ? 'Scan complete.' : collected.length ? 'Partly complete: see the steps.' : 'The scan did not complete: see the steps.',
  };
}
