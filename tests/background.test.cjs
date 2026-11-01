const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function worker({ tabs = [], close = true, timeout = 15000 } = {}) {
  const listeners = {};
  const calls = [];
  const staged = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const context = vm.createContext({
    console, URL, crypto: require('node:crypto'), setTimeout, clearTimeout,
    chrome: {
      action: { onClicked: event('action') },
      runtime: { onInstalled: event('install'), onConnect: event('connect'), onMessage: event('message'), getURL: (path) => 'chrome-extension://fixture/' + path },
      contextMenus: {
        onClicked: event('selection'),
        create: (menu, callback) => { calls.push({ menu }); callback(); }
      },
      sidePanel: { open: async (options) => { calls.push({ open: options }); }, ...(close ? { close: async (options) => { calls.push({ close: options }); } } : {}) },
      tabs: {
        query: async ({ windowId }) => tabs.filter((tab) => tab.windowId === windowId),
        create: async (options) => { const tab = { id: 100, ...options }; tabs.push(tab); calls.push({ create: options }); return tab; },
        update: async (id, options) => { calls.push({ update: id, ...options }); return tabs.find((tab) => tab.id === id); },
        get: async (id) => { const tab = tabs.find((tab) => tab.id === id); if (!tab) throw new Error('Tab removed'); return tab; }
      },
      storage: { session: { set: async (data) => { calls.push({ stored: true }); Object.assign(staged, data); }, get: async () => staged } }
    }
  });
  vm.runInContext(readFileSync(resolve(__dirname, '..', 'background.js'), 'utf8').replace('const NAVIGATION_TIMEOUT = 15000;', `const NAVIGATION_TIMEOUT = ${timeout};`), context);
  const page = (view, windowId, tabId, reply = () => ({})) => {
    const handlers = {};
    const port = {
      name: 'sidemind-page', sender: { documentId: `${view}-${tabId}`, ...(tabId ? { tab: { id: tabId, windowId } } : {}) },
      onMessage: { addListener: (fn) => { handlers.message = fn; } },
      onDisconnect: { addListener: (fn) => { handlers.disconnect = fn; } },
      postMessage: (message) => { calls.push({ delivered: message }); const response = reply(message); if (response) queueMicrotask(() => handlers.message({ type: 'navigated', requestId: message.requestId, ...response })); }
    };
    listeners.connect(port);
    handlers.message({ type: 'ready', view, windowId });
    return handlers;
  };
  const navigate = (view, sessionId = 'chat', windowId = 7, sender = {}) => new Promise((resolve) => listeners.message({ namespace: 'sidemind-navigation', type: 'switch', view, sessionId, windowId, anchor: { messageId: 'q', offset: 0.4 } }, sender, resolve));
  return { listeners, calls, staged, page, navigate };
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

test('navigation reuses only this window’s workspace and closes the sidebar after target acknowledgement', async () => {
  const tabs = [
    { id: 5, windowId: 7, active: true, url: 'https://example.com/article' },
    { id: 10, windowId: 7, url: 'chrome-extension://fixture/sidebar/sidebar.html?view=workspace#session=old' },
    { id: 11, windowId: 8, url: 'chrome-extension://fixture/sidebar/sidebar.html?view=workspace' }
  ];
  const fixture = worker({ tabs });
  const port = fixture.page('workspace', 7, 10, () => null);
  const navigating = fixture.navigate('workspace');
  await new Promise(setImmediate);
  assert.equal(fixture.calls.some((call) => call.close || call.update), false);
  const delivered = fixture.calls.find((call) => call.delivered).delivered;
  assert.equal(delivered.sessionId, 'chat');
  assert.equal(delivered.anchor.messageId, 'q');
  port.message({ type: 'navigated', requestId: delivered.requestId });
  assert.equal((await navigating).ok, true);
  assert.equal(fixture.calls.some((call) => call.create), false);
  assert.equal(fixture.calls.find((call) => call.update).update, 10);
  assert.equal(fixture.calls.at(-1).close.windowId, 7);
  assert.equal(fixture.staged['workspace-return:7'], 5);
});

test('a busy workspace is left on its conversation and the source sidebar remains open', async () => {
  const fixture = worker({ tabs: [{ id: 10, windowId: 7, url: 'chrome-extension://fixture/sidebar/sidebar.html?view=workspace' }] });
  fixture.page('workspace', 7, 10, () => ({ error: 'Generating a response. Stop it before switching views.' }));
  const result = await fixture.navigate('workspace');
  assert.equal(result.ok, false);
  assert.match(result.error, /Generating/);
  assert.equal(fixture.calls.some((call) => call.close || call.update || call.create), false);
});

test('new workspaces carry only the session in the URL and older Chrome keeps the sidebar open', async () => {
  const fixture = worker({ tabs: [{ id: 5, windowId: 7, active: true }], close: false });
  const navigating = fixture.navigate('workspace', 'chat with space');
  await new Promise(setImmediate);
  assert.equal(fixture.calls.find((call) => call.create).create.url, 'chrome-extension://fixture/sidebar/sidebar.html?view=workspace#session=chat%20with%20space');
  fixture.page('workspace', 7, 100);
  const result = await navigating;
  assert.equal(result.ok, true);
  assert.equal(result.closed, false);
});

test('returning to the sidebar waits for readiness and restores the original web tab', async () => {
  const fixture = worker({ tabs: [{ id: 5, windowId: 7 }, { id: 10, windowId: 7 }] });
  fixture.staged['workspace-return:7'] = 5;
  const navigating = fixture.navigate('sidebar', 'chat', 7, { documentId: 'workspace-10', tab: { id: 10, windowId: 7 } });
  await new Promise(setImmediate);
  assert.equal(fixture.calls.some((call) => call.update), false);
  fixture.page('sidebar', 7);
  assert.equal((await navigating).ok, true);
  assert.equal(fixture.calls.find((call) => call.update).update, 5);
});

test('a target load timeout reports failure without closing or navigating the source', async () => {
  const fixture = worker({ timeout: 20 });
  const result = await fixture.navigate('workspace');
  assert.equal(result.ok, false);
  assert.match(result.error, /did not load/);
  assert.equal(fixture.calls.some((call) => call.close || call.update), false);
});
