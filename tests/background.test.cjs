const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function worker() {
  const listeners = {};
  const calls = [];
  const staged = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const context = vm.createContext({
    console,
    chrome: {
      action: { onClicked: event('action') },
      runtime: { onInstalled: event('install') },
      contextMenus: {
        onClicked: event('selection'),
        create: (menu, callback) => { calls.push({ menu }); callback(); }
      },
      sidePanel: { open: async (options) => { calls.push({ open: options }); } },
      storage: { session: { set: async (data) => { calls.push({ stored: true }); Object.assign(staged, data); } } }
    }
  });
  vm.runInContext(readFileSync(resolve(__dirname, '..', 'background.js'), 'utf8'), context);
  return { listeners, calls, staged };
}

test('the toolbar action opens the panel and install registers a selection-only menu', async () => {
  const { listeners, calls } = worker();
  listeners.action({ windowId: 7 });
  listeners.install();
  assert.equal(calls[0].open.windowId, 7);
  assert.equal(calls[1].menu.id, 'ask-sidemind');
  assert.deepEqual(Array.from(calls[1].menu.contexts), ['selection']);
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Alt+Shift+S');
  assert.equal(manifest.permissions.includes('contextMenus'), true);
});

test('selected text is staged per window while opening starts within the gesture', async () => {
  const { listeners, calls, staged } = worker();
  await listeners.selection({ menuItemId: 'ask-sidemind', selectionText: 'A passage', pageUrl: 'https://example.com' }, { windowId: 7, title: 'Article' });
  await listeners.selection({ menuItemId: 'ask-sidemind', selectionText: 'Other passage', frameUrl: 'https://example.org/frame' }, { windowId: 8 });
  assert.equal(calls[0].open.windowId, 7);
  assert.equal(calls[1].stored, true);
  assert.equal(staged['selection:7'].text, 'A passage');
  assert.equal(staged['selection:8'].url, 'https://example.org/frame');
});

test('large selections are bounded and non-web URLs are omitted', async () => {
  const { listeners, staged } = worker();
  await listeners.selection({ menuItemId: 'ask-sidemind', selectionText: 'x'.repeat(25000), pageUrl: 'javascript:alert(1)' }, { windowId: 1 });
  assert.equal(staged['selection:1'].text.length, 20000);
  assert.equal(staged['selection:1'].truncated, true);
  assert.equal(staged['selection:1'].url, '');
});

test('unrelated context menu events do not open or stage anything', async () => {
  const { listeners, calls } = worker();
  await listeners.selection({ menuItemId: 'other', selectionText: 'Ignore' }, { windowId: 1 });
  await listeners.selection({ menuItemId: 'ask-sidemind' }, { windowId: 1 });
  assert.equal(calls.length, 0);
});
