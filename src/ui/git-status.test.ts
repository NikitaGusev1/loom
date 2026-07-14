import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitStatus } from './git-status.js';

describe('parseGitStatus', () => {
  it('projects branch, dirty count, and divergence', () => {
    assert.deepEqual(parseGitStatus('## main...origin/main [ahead 9, behind 2]\n M src/a.ts\n?? src/b.ts\n'), {
      isRepository: true,
      branch: 'main',
      clean: false,
      changedFiles: 2,
      ahead: 9,
      behind: 2,
    });
  });

  it('projects a clean branch', () => {
    assert.deepEqual(parseGitStatus('## feature/ui\n'), {
      isRepository: true,
      branch: 'feature/ui',
      clean: true,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    });
  });
});
