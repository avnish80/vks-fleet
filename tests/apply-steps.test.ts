/** v1.34.0: a multi-step change that fails partway says what took effect. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PartialApply, runSteps } from '../src/applySteps';

const req = (method: any, path: string) => ({ method, path });
const steps = [
  req('PATCH', '/apis/cluster.x-k8s.io/v1beta1/namespaces/ns/clusters/checkout'),
  req('PATCH', '/apis/cluster.x-k8s.io/v1beta1/namespaces/ns/machinedeployments/checkout-np-1'),
  req('DELETE', '/apis/cluster.x-k8s.io/v1beta1/namespaces/ns/machines/checkout-np-1-abc'),
];
const failOn = (n: number) => async (r: any) => {
  if (r === steps[n]) throw new Error('admission webhook denied the request');
};

describe('applying several writes', () => {
  test('a failure partway names what was applied, what failed and what was not sent', async () => {
    await assert.rejects(runSteps(steps, failOn(1), { dryRun: false, explain: e => (e as Error).message }), (e: unknown) => {
      assert.ok(e instanceof PartialApply);
      assert.equal(
        (e as Error).message,
        'Step 2 of 3 failed (PATCH machinedeployments/checkout-np-1): admission webhook denied the request Already applied, and not undone: PATCH clusters/checkout. 1 later step was not sent. Check the object before trying again.'
      );
      return true;
    });
  });
  test('a dry run, or a single write, fails as itself', async () => {
    await assert.rejects(runSteps(steps, failOn(1), { dryRun: true, explain: String }), (e: unknown) => !(e instanceof PartialApply));
    await assert.rejects(runSteps([steps[0]], failOn(0), { dryRun: false, explain: String }), (e: unknown) => !(e instanceof PartialApply));
  });
  test('when the first of several fails, nothing was applied', async () => {
    await assert.rejects(runSteps(steps, failOn(0), { dryRun: false, explain: () => 'no' }), /Nothing was applied\. 2 later steps were not sent/);
  });
});
