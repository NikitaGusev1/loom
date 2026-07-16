import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindTodoComposer, UI_HTML, type TodoComposerOptions } from './assets.js';

const composer = (overrides: Partial<TodoComposerOptions> = {}) => {
  const input: TodoComposerOptions['input'] = { value: '', oninput: null, onkeydown: null };
  const button: TodoComposerOptions['button'] = { disabled: false, onclick: null };
  const submitted: string[] = [];
  const errors: string[] = [];
  let refreshes = 0;
  const options: TodoComposerOptions = {
    input,
    button,
    submit: async (body) => {
      submitted.push(body);
    },
    refresh: async () => {
      refreshes += 1;
    },
    reportError: (message) => errors.push(message),
    ...overrides,
  };
  const saveTodo = bindTodoComposer(options);
  return { input, button, submitted, errors, saveTodo, refreshes: () => refreshes };
};

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
    assert.match(UI_HTML, /bindTodoComposer\(\{/);
    assert.match(UI_HTML, /Enter to add · Shift\+Enter for newline/);
    assert.match(UI_HTML, /aria-describedby="todoHint todoError"/);
    assert.match(UI_HTML, /event\.key === 'Escape'/);
    assert.match(UI_HTML, /el\('allProjects'\)\.onclick = \(\) => renderHome\(false\)/);
    assert.match(UI_HTML, /aria-labelledby="chatTitle"/);
  });

  it('contains syntactically valid embedded JavaScript', () => {
    const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  });

  it('submits trimmed text on Enter but preserves Shift+Enter and IME composition', async () => {
    const value = composer();
    value.input.value = '  add keyboard support  ';
    let prevented = 0;
    value.input.onkeydown?.({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault: () => {
        prevented += 1;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prevented, 1);
    assert.deepEqual(value.submitted, ['add keyboard support']);
    assert.equal(value.input.value, '');
    assert.equal(value.refreshes(), 1);

    value.input.value = 'button submission';
    value.input.oninput?.();
    value.button.onclick?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(value.submitted, ['add keyboard support', 'button submission']);

    for (const event of [
      { key: 'Enter', shiftKey: true, isComposing: false },
      { key: 'Enter', shiftKey: false, isComposing: true },
      { key: 'a', shiftKey: false, isComposing: false },
    ]) {
      value.input.value = 'keep editing';
      value.input.onkeydown?.({ ...event, preventDefault: () => assert.fail('must preserve the native key action') });
    }
    assert.deepEqual(value.submitted, ['add keyboard support', 'button submission']);
    assert.equal(value.input.value, 'keep editing');
  });

  it('deduplicates an in-flight save and preserves text entered for the next todo', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted: string[] = [];
    const value = composer({
      submit: async (body) => {
        submitted.push(body);
        await pending;
      },
    });
    value.input.value = 'first todo';
    const first = value.saveTodo();
    const duplicate = value.saveTodo();
    value.input.value = 'second todo draft';
    value.input.oninput?.();
    assert.equal(value.button.disabled, true);
    assert.deepEqual(submitted, ['first todo']);
    release();
    await Promise.all([first, duplicate]);
    assert.equal(value.input.value, 'second todo draft');
    assert.equal(value.button.disabled, false);
  });

  it('keeps the draft, reports save failures, and restores submission', async () => {
    const errors: string[] = [];
    const value = composer({
      submit: async () => {
        throw new Error('network unavailable');
      },
      reportError: (message) => errors.push(message),
    });
    value.input.value = 'retry me';
    await value.saveTodo();
    assert.equal(value.input.value, 'retry me');
    assert.equal(value.button.disabled, false);
    assert.deepEqual(errors, ['', 'Could not add "retry me": network unavailable']);
    assert.equal(value.refreshes(), 0);
  });

  it('distinguishes a post-save refresh failure from a submission failure', async () => {
    const errors: string[] = [];
    const value = composer({
      refresh: async () => {
        throw new Error('refresh unavailable');
      },
      reportError: (message) => errors.push(message),
    });
    value.input.value = 'saved once';
    await value.saveTodo();
    assert.deepEqual(value.submitted, ['saved once']);
    assert.equal(value.input.value, '');
    assert.deepEqual(errors, ['', 'Todo added, but inbox refresh failed: refresh unavailable']);
    assert.equal(value.button.disabled, false);
  });

  it('keeps submission locked until the inbox refresh finishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = composer({ refresh: async () => pending });
    value.input.value = 'saved before refresh';
    const save = value.saveTodo();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(value.button.disabled, true);
    release();
    await save;
    assert.equal(value.button.disabled, false);
  });

  it('does not clear an edited draft that returns to identical text', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = composer({ submit: async () => pending });
    value.input.value = 'same text';
    const save = value.saveTodo();
    value.input.value = 'different text';
    value.input.oninput?.();
    value.input.value = 'same text';
    value.input.oninput?.();
    release();
    await save;
    assert.equal(value.input.value, 'same text');
  });
});
