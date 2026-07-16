import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UI_HTML } from './assets.js';

describe('Loom UI assets', () => {
  it('keeps project navigation, DAG lifecycle, runs, and clarification controls', () => {
    assert.match(UI_HTML, /<title>Loom<\/title>/);
    assert.match(UI_HTML, /All projects/);
    assert.match(UI_HTML, /Active/);
    assert.match(UI_HTML, /History/);
    assert.match(UI_HTML, /Archived/);
    assert.match(UI_HTML, /\/api\/projects\//);
    assert.match(UI_HTML, /project\.displayName/);
    assert.doesNotMatch(UI_HTML, /Not a valid DAG/);
    assert.match(UI_HTML, /Archive this completed DAG/);
    assert.match(UI_HTML, /legacyQuestion/);
    assert.match(UI_HTML, /conversationMessages/);
    assert.match(UI_HTML, /conversationDrafts/);
    assert.match(UI_HTML, /autoOpenedQuestions/);
    assert.match(UI_HTML, /View discussion/);
    assert.match(
      UI_HTML,
      /renderRuns\(\)\.then\(\(\) => state\.view === 'runs' && state\.selectedRun && selectRun\(state\.selectedRun\)\)/,
    );
    assert.match(UI_HTML, /event\.key === 'Enter' && !event\.shiftKey/);
    assert.match(UI_HTML, /event\.key === 'Escape'/);
    assert.match(UI_HTML, /el\('allProjects'\)\.onclick = \(\) => renderHome\(false\)/);
    assert.match(UI_HTML, /aria-labelledby="chatTitle"/);
  });

  it('contains syntactically valid embedded JavaScript', () => {
    const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  });
});
