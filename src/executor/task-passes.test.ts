import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BACKLOG_PAUSE_ABORT_REASON } from '../consts.js';
import { isBacklogPauseAbort } from './task-passes.js';

describe('isBacklogPauseAbort', () => {
  it('detects backlog pause cancellation signals', () => {
    const controller = new AbortController();
    controller.abort(BACKLOG_PAUSE_ABORT_REASON);

    assert.equal(isBacklogPauseAbort(controller.signal), true);
  });

  it('does not treat other abort reasons as backlog pause cancellations', () => {
    const controller = new AbortController();
    controller.abort('sigint');

    assert.equal(isBacklogPauseAbort(controller.signal), false);
  });
});
