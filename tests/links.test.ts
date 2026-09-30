/** v1.33.1: links on a page never point uselessly at that same page. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { leadsSomewhere } from '../src/links';

describe('links', () => {
  const here = '/vks-fleet/clusters/wld/ns/kubernetes-cluster-mnet';
  test('the same page with nothing to jump to: dropped', () => {
    assert.equal(leadsSomewhere(here, here), false);
  });
  test('a section or an action on the same page: kept (the page scrolls or opens it)', () => {
    assert.equal(leadsSomewhere(`${here}#inside`, here), true);
    assert.equal(leadsSomewhere(`${here}?action=upgrade`, here), true);
  });
  test('another page: kept', () => {
    assert.equal(leadsSomewhere('/vks-fleet/clusters/wld/ns/kubernetes-cluster-a1b2', here), true);
    assert.equal(leadsSomewhere(here, '/vks-fleet'), true);
  });
});
