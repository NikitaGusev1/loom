import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideStale } from './self-host-guard.js';

describe('decideStale', () => {
  const REPO = '/repo';

  it('not self-host when toplevels differ → never stale', () => {
    assert.deepEqual(decideStale('/repo-a', '/repo-b', true, true), { stale: false });
  });

  it('not self-host when build dir is outside any git repo → never stale', () => {
    assert.deepEqual(decideStale(null, REPO, true, true), { stale: false });
  });

  it('not self-host when cwd is outside any git repo → never stale', () => {
    assert.deepEqual(decideStale(REPO, null, true, true), { stale: false });
  });

  it('self-host + clean (no signals) → not stale', () => {
    assert.deepEqual(decideStale(REPO, REPO, false, false), { stale: false });
  });

  it('self-host + dirty src → stale, reason names the dirty signal', () => {
    const v = decideStale(REPO, REPO, true, false);
    assert.equal(v.stale, true);
    assert.match(v.reason!, /uncommitted changes under src\//);
  });

  it('self-host + src newer than build → stale, reason names the mtime signal', () => {
    const v = decideStale(REPO, REPO, false, true);
    assert.equal(v.stale, true);
    assert.match(v.reason!, /src\/\*\.ts newer than build\/\*\.js/);
  });

  it('self-host + both signals → stale, reason names both', () => {
    const v = decideStale(REPO, REPO, true, true);
    assert.equal(v.stale, true);
    assert.match(v.reason!, /uncommitted changes under src\/ and src\/\*\.ts newer than build/);
  });
});
