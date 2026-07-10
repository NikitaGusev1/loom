import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWriterLane, landWorktree, type LandWorktreeDeps } from './writer-lane.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeLandDeps = (overrides: Partial<LandWorktreeDeps> = {}): LandWorktreeDeps => ({
  verifyBaseUnchanged: async () => true,
  mergeWorktrees: async (ids, onMerged) => {
    ids.forEach(onMerged);
    return { success: true };
  },
  currentHeadSha: async () => 'sha-after',
  ...overrides,
});

describe('createWriterLane', () => {
  it('serializes: a second land does not start until the first settles', async () => {
    const lane = createWriterLane();
    const events: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => (release1 = resolve));

    const p1 = lane.enqueue(async () => {
      events.push('start1');
      await gate1;
      events.push('end1');
    });
    const p2 = lane.enqueue(async () => {
      events.push('start2');
    });

    await tick();
    assert.deepEqual(events, ['start1']);

    release1();
    await Promise.all([p1, p2]);
    assert.deepEqual(events, ['start1', 'end1', 'start2']);
  });

  it('a rejecting land does not poison the lane', async () => {
    const lane = createWriterLane();
    await assert.rejects(
      lane.enqueue(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await lane.enqueue(async () => 42), 42);
  });
});

describe('landWorktree', () => {
  it('merged: base-check passes, merge succeeds, returns new sha and fires onMerged', async () => {
    const merged: string[] = [];
    const result = await landWorktree({
      taskId: 'A',
      baseBranch: 'main',
      baseCommitSha: 'sha0',
      onMerged: (id) => merged.push(id),
      deps: makeLandDeps(),
    });
    assert.equal(result.status, 'merged');
    assert.equal(result.newSha, 'sha-after');
    assert.deepEqual(merged, ['A']);
  });

  it('base-moved: skips the merge entirely and never fires onMerged', async () => {
    const merged: string[] = [];
    let mergeCalled = false;
    const result = await landWorktree({
      taskId: 'A',
      baseBranch: 'main',
      baseCommitSha: 'sha0',
      onMerged: (id) => merged.push(id),
      deps: makeLandDeps({
        verifyBaseUnchanged: async () => false,
        mergeWorktrees: async () => {
          mergeCalled = true;
          return { success: true };
        },
      }),
    });
    assert.equal(result.status, 'base-moved');
    assert.equal(mergeCalled, false);
    assert.deepEqual(merged, []);
  });

  it('conflict: propagates the conflict message and leaves base unadvanced', async () => {
    const result = await landWorktree({
      taskId: 'A',
      baseBranch: 'main',
      baseCommitSha: 'sha0',
      onMerged: () => {},
      deps: makeLandDeps({
        mergeWorktrees: async () => ({ success: false, failedAt: 'A', conflict: 'CONFLICT in foo.ts' }),
      }),
    });
    assert.equal(result.status, 'conflict');
    assert.match(result.conflict ?? '', /CONFLICT/);
    assert.equal(result.newSha, undefined);
  });

  it('through the lane: a later conflict does not orphan an earlier landed task', async () => {
    const lane = createWriterLane();
    const merged: string[] = [];
    const land = (taskId: string, deps: LandWorktreeDeps) =>
      lane.enqueue(() =>
        landWorktree({ taskId, baseBranch: 'main', baseCommitSha: 's', onMerged: (id) => merged.push(id), deps }),
      );

    const [a, b] = await Promise.all([
      land('A', makeLandDeps()),
      land('B', makeLandDeps({ mergeWorktrees: async () => ({ success: false, conflict: 'x' }) })),
    ]);

    assert.equal(a.status, 'merged');
    assert.equal(b.status, 'conflict');
    assert.deepEqual(merged, ['A']);
  });
});
