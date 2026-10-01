/**
 * Applying a change made of several writes. Kubernetes writes aren't a transaction:
 * if a later step fails, earlier ones have already taken effect. Say exactly what.
 */
import { WriteRequest } from './api/client';

/** "PATCH clusters/checkout": the verb and the object a step touches. */
export function describeStep(r: WriteRequest): string {
  const parts = r.path.split('?')[0].split('/').filter(Boolean);
  return `${r.method} ${parts.slice(-2).join('/')}`;
}

export function partialMessage(requests: WriteRequest[], failedAt: number, causeText: string): string {
  const done = requests.slice(0, failedAt).map(describeStep);
  const notSent = requests.length - failedAt - 1;
  return [
    `Step ${failedAt + 1} of ${requests.length} failed (${describeStep(requests[failedAt])}): ${causeText}`,
    done.length ? `Already applied, and not undone: ${done.join('; ')}.` : 'Nothing was applied.',
    notSent > 0 ? `${notSent} later step${notSent === 1 ? ' was' : 's were'} not sent.` : '',
    'Check the object before trying again.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A multi-step change that failed partway. */
export class PartialApply extends Error {
  constructor(public requests: WriteRequest[], public failedAt: number, public reason: unknown, causeText: string) {
    super(partialMessage(requests, failedAt, causeText));
  }
}

/**
 * Send each request in order. A single request (or a dry run) fails as itself; a real
 * multi-step change that fails partway throws PartialApply, naming what took effect.
 */
export async function runSteps(requests: WriteRequest[], send: (r: WriteRequest) => Promise<unknown>, opts: { dryRun: boolean; explain: (err: unknown) => string }): Promise<void> {
  for (let i = 0; i < requests.length; i++) {
    try {
      await send(requests[i]);
    } catch (err) {
      if (opts.dryRun || requests.length === 1) throw err;
      throw new PartialApply(requests, i, err, opts.explain(err));
    }
  }
}
