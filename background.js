// Register listeners synchronously so MV3 can wake this worker for gestures.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId })
    .catch((error) => console.error('Opening SideMind:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ask-sidemind',
    title: 'Ask SideMind about selected text',
    contexts: ['selection']
  }, () => {
    if (chrome.runtime.lastError) console.error('Creating selection menu:', chrome.runtime.lastError.message);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ask-sidemind' || !info.selectionText || !tab) return;
  // Start opening before awaiting storage: Chrome requires the original user
  // gesture. Session storage also covers panels that haven't loaded yet.
  try {
    const opening = chrome.sidePanel.open({ windowId: tab.windowId });
    const text = info.selectionText;
    const url = info.frameUrl || info.pageUrl || '';
    await Promise.all([
      opening,
      chrome.storage.session.set({
        [`selection:${tab.windowId}`]: {
          text: text.slice(0, 20000),
          truncated: text.length > 20000,
          title: (tab.title || '').replace(/\s+/g, ' '),
          url: /^https?:\/\//i.test(url) ? url : ''
        }
      })
    ]);
  } catch (error) {
    console.error('Opening selected text in SideMind:', error);
  }
});

// Navigation only: requests and attachment bytes stay in the originating page.
const navigationPages = new Map();
const navigationWaiters = new Set();
const navigationReplies = new Map();
const navigationQueues = new Map();
const NAVIGATION_TIMEOUT = 15000;

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'sidemind-page') return;
  port.onMessage.addListener((message) => {
    if (message.type === 'ready' && ['workspace', 'sidebar'].includes(message.view)) {
      const page = { port, view: message.view, windowId: port.sender.tab?.windowId ?? message.windowId, tabId: port.sender.tab?.id };
      navigationPages.set(port, page);
      navigationWaiters.forEach((wake) => wake());
    } else if (message.type === 'navigated') {
      const waiting = navigationReplies.get(message.requestId);
      if (waiting?.port === port) waiting.finish(message);
    }
  });
  port.onDisconnect.addListener(() => {
    navigationPages.delete(port);
    navigationReplies.forEach((waiting) => {
      if (waiting.port === port) waiting.finish({ error: 'The target page closed before it was ready. Please try again.' });
    });
  });
});

chrome.runtime.onMessage?.addListener((message, sender, respond) => {
  if (message.namespace !== 'sidemind-navigation' || message.type !== 'switch') return;
  const windowId = sender.tab?.windowId ?? message.windowId;
  if (!Number.isInteger(windowId) || !['workspace', 'sidebar'].includes(message.view) || typeof message.sessionId !== 'string' || message.sessionId.length > 200) {
    respond({ ok: false, error: 'Invalid navigation target.' });
    return;
  }
  // Serialize only navigation within a window, never generation or storage.
  const previous = navigationQueues.get(windowId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => navigateView({ ...message, windowId }, sender));
  navigationQueues.set(windowId, next);
  next.then(respond, (error) => respond({ ok: false, error: error.message })).finally(() => {
    if (navigationQueues.get(windowId) === next) navigationQueues.delete(windowId);
  });
  return true;
});

function waitForNavigationPage(matches) {
  const find = () => [...navigationPages.values()].find(matches);
  const present = find();
  if (present) return Promise.resolve(present);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); navigationWaiters.delete(wake); };
    const wake = () => { const page = find(); if (page) { cleanup(); resolve(page); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The target page did not load. Your conversation is still available in the original view.')); }, NAVIGATION_TIMEOUT);
    navigationWaiters.add(wake);
  });
}

function deliverNavigation(page, message) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => finish({ error: 'The target page did not become ready. Please try again.' }), NAVIGATION_TIMEOUT);
    const finish = (reply) => {
      clearTimeout(timer);
      navigationReplies.delete(requestId);
      if (reply.error) reject(new Error(reply.error));
      else resolve();
    };
    navigationReplies.set(requestId, { port: page.port, finish });
    try { page.port.postMessage({ type: 'navigate', requestId, sessionId: message.sessionId, anchor: message.anchor }); }
    catch (error) { finish({ error: error.message }); }
  });
}

async function navigateView(message, sender) {
  const { windowId } = message;
  if (message.view === 'workspace') {
    const base = chrome.runtime.getURL('sidebar/sidebar.html');
    const tabs = await chrome.tabs.query({ windowId });
    const isWorkspace = (tab) => {
      try { const url = new URL(tab.url || tab.pendingUrl); return url.href.split('?')[0].split('#')[0] === base && url.searchParams.get('view') === 'workspace'; }
      catch { return false; }
    };
    const existing = tabs.find(isWorkspace);
    const active = tabs.find((tab) => tab.active && !isWorkspace(tab));
    const returnKey = `workspace-return:${windowId}`;
    if (active) await chrome.storage.session.set({ [returnKey]: active.id });
    const target = existing || await chrome.tabs.create({ windowId, url: `${base}?view=workspace#session=${encodeURIComponent(message.sessionId)}`, active: false });
    const page = await waitForNavigationPage((candidate) => candidate.view === 'workspace' && candidate.tabId === target.id);
    await deliverNavigation(page, message);
    await chrome.tabs.update(target.id, { active: true });
    let closed = false;
    if (chrome.sidePanel.close) {
      try { await chrome.sidePanel.close({ windowId }); closed = true; }
      catch (error) { console.warn('Closing SideMind sidebar:', error.message); }
    }
    return { ok: true, closed, tabId: target.id };
  }
  // sidePanel.open() has already run in the workspace's original button click.
  const page = await waitForNavigationPage((candidate) => candidate.view === 'sidebar' && candidate.windowId === windowId && candidate.port.sender.documentId !== sender.documentId);
  await deliverNavigation(page, message);
  const key = `workspace-return:${windowId}`;
  const stored = await chrome.storage.session.get([key]);
  if (Number.isInteger(stored[key])) {
    try {
      const tab = await chrome.tabs.get(stored[key]);
      if (tab.windowId === windowId) await chrome.tabs.update(tab.id, { active: true });
    } catch { /* The original web tab may have been closed. Keep this tab open. */ }
  }
  return { ok: true };
}
