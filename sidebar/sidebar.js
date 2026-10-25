// SideMind Chrome Extension - Sidebar Script
// Main application logic for the sidebar chat interface

// ========================================
// GLOBAL STATE MANAGEMENT
// ========================================

const state = {
  currentSessionId: null,
  sessions: {},
  drafts: {},
  config: {
    providers: [],
    selectedProvider: null,
    selectedModel: null,
    selectedSystemPrompt: 'default',
    temperature: null,
    max_completion_tokens: '',
    stream: true,
    reasoning_effort: '',
    reasoning_summary: 'off',
    reasoning_context: null,
    theme: 'system',
    systemPrompts: [
      {
        id: 'default',
        name: 'Default',
        content: 'You are a helpful assistant.',
        isDefault: true
      }
    ]
  },
  isStreaming: false,
  isPreparing: false,
  currentStreamingMessage: null,
  userScrolledUp: false,
  abortController: null,
  streamTicker: null,
  followOutput: false,
  readingResponse: false,
  generationDone: null,
  resolveGeneration: null
};

// ========================================
// SIMPLIFIED RENDERING SYSTEM
// ========================================

// Message element cache
const messageElementCache = new Map();
const elementMessages = new WeakMap();
const modelDividers = new WeakMap();
let latestAssistantElement = null;

// Simplified markdown cache with automatic size control
const markdownCache = new Map();
const MAX_MARKDOWN_CACHE_SIZE = 100;
const MAX_MARKDOWN_CACHE_CHARS = 1000000;
let markdownCacheChars = 0;
const renderedMarkdown = new WeakMap();
let generationStatusTimer = null;
const sessionSearchCache = new Map();
const MAX_SESSION_SEARCH_CACHE_SIZE = 500;
const MAX_SESSION_SEARCH_CACHE_CHARS = 1000000;
let sessionSearchCacheChars = 0;
let historySearchTimer = null;
const HISTORY_PAGE_SIZE = 50;
let historyVisibleCount = HISTORY_PAGE_SIZE;
let historyLastQuery = '';
let historyRenderVersion = 0;

// ----------------------------------------
// Throttled streaming updates
// ----------------------------------------
// A stream can deliver dozens of deltas per second and each repaint re-parses
// the whole message. Coalesce them into one repaint per interval instead.
const STREAM_RENDER_INTERVAL = 60;
const MAX_STREAM_RENDER_INTERVAL = 240;
const pendingDisplayUpdates = new Set();
let streamRenderTimer = null;
let streamRenderCost = 0;

function scheduleMessageDisplay(messageId) {
  invalidateSessionSearch(state.currentSessionId);
  pendingDisplayUpdates.add(messageId);
  if (streamRenderTimer !== null) return;

  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    flushMessageDisplays();
  }, Math.max(STREAM_RENDER_INTERVAL, Math.min(MAX_STREAM_RENDER_INTERVAL, streamRenderCost * 4)));
}

function flushMessageDisplays() {
  if (streamRenderTimer !== null) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }

  if (pendingDisplayUpdates.size === 0) return;

  const ids = [...pendingDisplayUpdates];
  pendingDisplayUpdates.clear();
  const started = performance.now();
  ids.forEach((id) => updateMessageDisplay(id));
  streamRenderCost = performance.now() - started;
}

// Simple cache cleanup
function clearOldCacheEntries() {
  // Clean message cache for non-current sessions
  if (state.currentSessionId && state.sessions[state.currentSessionId]) {
    const currentMessages = new Map(
      state.sessions[state.currentSessionId].messages.map((message) => [message.id, message])
    );

    for (const [messageId, element] of messageElementCache) {
      if (currentMessages.get(messageId) !== elementMessages.get(element)) {
        messageElementCache.delete(messageId);
        pendingDisplayUpdates.delete(messageId);
        deferredDisplays.delete(messageId);
      }
    }
  }
}

// ========================================
// DOM ELEMENT REFERENCES
// ========================================

const elements = {
  modelSelector: null,
  systemPromptSelector: null,
  chatHistoryBtn: null,
  newChatBtn: null,
  messageInput: null,
  sendBtn: null,
  optionsBtn: null,
  messagesList: null,
  welcomeMessage: null,
  chatHistoryDropdown: null,
  closeBtn: null,
  chatHistoryList: null,
  scrollBottomBtn: null,
  srStatus: null,
  undoBar: null,
  undoText: null,
  undoBtn: null
};

// ========================================
// APPLICATION INITIALIZATION
// ========================================

marked.use({ renderer: { html(token) {
  const html = typeof token === 'string' ? token : token.text;
  return html.replace(/<\/?think(?:ing)?>/g, (tag) => tag.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
} } });

// ui.js already applied the cached theme; fonts are this page's own setting.
try {
  applyFontSettings(cachedAppearance());
} catch {}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('SideMind initializing...');

  cacheElements();
  await loadFromStorage();
  setupEventListeners();
  initializeUI();
  await initializeSelectionImport();

  setTimeout(cleanupAttachments, 5000);
  console.log('SideMind initialized successfully');
});

// Cache DOM Elements
function cacheElements() {
  elements.modelSelector = document.getElementById('modelSelector');
  elements.systemPromptSelector = document.getElementById('systemPromptSelector');
  elements.chatHistoryBtn = document.getElementById('chatHistoryBtn');
  elements.newChatBtn = document.getElementById('newChatBtn');
  elements.messageInput = document.getElementById('messageInput');
  elements.sendBtn = document.getElementById('sendBtn');
  elements.optionsBtn = document.getElementById('optionsBtn');
  elements.messagesList = document.getElementById('messagesList');
  elements.welcomeMessage = document.getElementById('welcomeMessage');
  elements.chatHistoryDropdown = document.getElementById('chatHistoryDropdown');
  elements.closeBtn = document.querySelector('.close-btn');
  elements.chatHistoryList = document.getElementById('chatHistoryList');
  elements.scrollBottomBtn = document.getElementById('scrollBottomBtn');
  elements.srStatus = document.getElementById('srStatus');
  elements.undoBar = document.getElementById('undoBar');
  elements.undoText = document.getElementById('undoText');
  elements.undoBtn = document.getElementById('undoBtn');
  [
    'modelControl',
    'modelName',
    'modelProvider',
    'modelPickerPanel',
    'modelSearch',
    'modelOptions',
    'modelPickerEmpty',
    'manageModelsBtn',
    'generationStatus',
    'historySearch',
    'historyUndo',
    'historyUndoText',
    'historyUndoBtn',
    'notifications',
    'sessionTitle',
    'storageStatus',
    'storageStatusText',
    'retryStorageBtn',
    'composer',
    'attachBtn',
    'attachmentInput',
    'draftAttachments',
    'attachmentStatus',
    'cancelAttachmentsBtn'
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

// Setup Event Listeners
function setupEventListeners() {
  elements.modelSelector.addEventListener('click', toggleModelPicker);
  elements.modelSelector.addEventListener('keydown', handleModelTriggerKeydown);
  elements.modelSearch.addEventListener('input', renderModelOptions);
  elements.modelSearch.addEventListener('keydown', handleModelSearchKeydown);
  elements.modelOptions.addEventListener('click', handleModelOptionClick);
  elements.modelOptions.addEventListener('pointermove', handleModelOptionPointerMove);
  elements.modelControl.addEventListener('focusout', handleModelPickerFocusOut);
  elements.manageModelsBtn.addEventListener('click', manageModels);
  document.addEventListener('pointerdown', handleModelPickerOutsideClick);
  window.addEventListener('resize', positionModelPicker);
  elements.systemPromptSelector.addEventListener('change', handleSystemPromptChange);
  elements.newChatBtn.addEventListener('click', createNewSession);
  elements.sendBtn.addEventListener('click', handleSendOrStop);
  elements.optionsBtn.addEventListener('click', openOptions);

  elements.messageInput.addEventListener('input', handleInputChange);
  elements.messageInput.addEventListener('keydown', handleInputKeydown);
  setupAttachmentListeners();

  elements.chatHistoryBtn.addEventListener('click', openChatHistory);
  elements.closeBtn.addEventListener('click', closeChatHistory);
  elements.chatHistoryDropdown.addEventListener('click', handleHistoryBackdrop);
  elements.chatHistoryDropdown.addEventListener('cancel', handleHistoryCancel);
  elements.historySearch.addEventListener('input', scheduleHistorySearch);
  elements.retryStorageBtn.addEventListener('click', retryStorageSave);
  elements.historyUndoBtn.addEventListener('click', applyUndo);
  document.addEventListener('selectionchange', resumeSelectedDisplays);
  window.addEventListener('resize', autoResizeTextarea);
  window.addEventListener('pagehide', flushSidebarSaves);

  elements.messagesList.addEventListener('scroll', handleScroll);
  elements.scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));
  elements.undoBtn.addEventListener('click', applyUndo);

  document.addEventListener('keydown', handleGlobalKeydown);

  // Listen for config changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.config) {
      state.config = { ...state.config, ...GenerationSettings.migrate(changes.config.newValue), ...pendingConfigChanges };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
      renderWelcomeMessage();
      applyFontSettings();
      applyTheme();
    }
    if (areaName === 'local') {
      handleStoredChanges(changes);
    }
    if (areaName === 'session' && selectionStorageKey && changes[selectionStorageKey]?.newValue) {
      importSelectedText();
    }
  });

  window.addEventListener('offline', handleOffline);
}

// Initialize UI
function initializeUI() {
  applyTheme();
  applyFontSettings();
  updateModelSelector();
  updateSystemPromptSelector();
  restoreDraft();

  if (state.currentSessionId) {
    renderMessages();
  } else {
    showWelcomeMessage();
  }

  updateInputState();
}

// ========================================
// STORAGE MANAGEMENT
// ========================================

async function loadFromStorage() {
  try {
    const result = await chrome.storage.sync.get(['config']);

    if (!result.config) {
      const localResult = await chrome.storage.local.get(['config']);
      if (localResult.config) {
        result.config = localResult.config;
        try {
          assertConfigFitsSync(localResult.config);
          await chrome.storage.sync.set({ config: localResult.config });
        } catch (error) {
          showNotification(error.name === 'SyncQuotaError' ? error.message : 'Could not sync your settings. Your local settings are still available.');
        }
      }
    }

    if (result.config) {
      state.config = { ...state.config, ...GenerationSettings.migrate(result.config) };
      if (!sameValue(state.config, result.config)) {
        await GenerationSettings.withLock(async () => {
          const latest = await chrome.storage.sync.get(['config']);
          const migrated = GenerationSettings.migrate(latest.config || result.config);
          assertConfigFitsSync(migrated);
          if (!sameValue(migrated, latest.config)) await chrome.storage.sync.set({ config: migrated });
          state.config = { ...state.config, ...migrated };
        });
      }
      applyFontSettings();
      applyTheme();
    }
  } catch (error) {
    console.error('Configuration load error:', error);
    showNotification('Could not load settings. Reload SideMind to try again.');
  }
  try {
    const localResult = await withStorageLock(() => writeLocalChanges(true, { scanAll: true }));
    const revs = {};
    Object.entries(localResult).forEach(([key, entry]) => {
      if (!key.startsWith(SESSION_PREFIX)) return;
      const id = key.slice(SESSION_PREFIX.length);
      state.sessions[id] = entry.session;
      revs[id] = entry.rev;
    });

    if (localResult.drafts) {
      state.drafts = localResult.drafts;
    }

    if (localResult.currentSessionId) {
      state.currentSessionId = localResult.currentSessionId;
    }

    rememberSaved(state.sessions, revs, state.drafts, state.currentSessionId);
    storageReady = true;
    if (repairedChats) {
      showNotification(`Merged ${repairedChats} duplicate chat${repairedChats > 1 ? 's' : ''} left behind by a saving bug.`);
      repairedChats = 0;
    }
    if (!state.sessions[state.currentSessionId]) {
      await createNewSession();
    }
  } catch (error) {
    console.error('Storage load error:', error);
    storageLoadFailed = true;
    showStorageFailure();
    await createNewSession();
  }
}

let storageWriteQueue = Promise.resolve();
let storageLoadFailed = false;

function showStorageFailure() {
  elements.storageStatus.classList.remove('hidden');
  elements.storageStatusText.textContent = storageLoadFailed
    ? 'Could not load conversations. Reload before saving new messages.'
    : 'Changes are not saved. Retry, or export chats and free space in history.';
  elements.retryStorageBtn.textContent = storageLoadFailed ? 'Reload' : 'Retry save';
}

function retryStorageSave() {
  if (storageLoadFailed) {
    window.location.reload();
    return;
  }
  saveToStorage();
}

// Several side panels share one storage area, so a page may only write what it
// changed itself. Every chat is a key of its own, `session:<id>`, holding
// `{ rev, session }`; `rev` is an opaque token replaced by each write. A page
// remembers the rev it last read or wrote (`savedRevs`) and, inside a Web Lock,
// writes its chat straight over the stored one while the stored rev is still
// that rev. If it is not, another page wrote in between, and the two versions
// are merged three-way against the snapshot this page last saved.
//
// The rule that keeps this honest: content read back from storage is never
// compared with a string this page serialised itself. chrome.storage does not
// return objects as they were written (it reorders keys and drops undefined
// values), so such a comparison says nothing about content - it once made
// every save of a streaming reply look like a conflict with the page's own
// previous save. "Did this page change the chat?" is answered against the
// page's own snapshot (`savedSessions`); "did another page?" by the rev.
//
// Merge rules: messages are merged by id, so independent additions from
// several pages all survive. A message both pages changed differently takes
// the version of whoever saves last, as does every other chat field. A chat
// removed by one page is kept if another page changed it meanwhile. Pages also
// follow each other (`handleStoredChanges`), so such overlaps are rare. Drafts
// and the selected chat are last writer wins.
let savedSessions = {};
let savedSessionRefs = {};
const dirtySessionIds = new Set();
let savedRevs = {};
let savedDrafts = {};
let savedCurrentSessionId = null;
let storageReady = false;
let repairedChats = 0;
const pageId = crypto.randomUUID();
const SESSION_PREFIX = 'session:';
const PENDING_PREFIX = 'pending:';
// Older builds kept all chats in one `sessions` table and called their stashes
// `pendingSave:`; both are folded into the per-chat layout on first load.
const LEGACY_PENDING_PREFIX = 'pendingSave:';
const LEGACY_BACKUP_KEY = 'backup:sessions-v1';

function rememberSaved(sessions, revs, drafts, currentSessionId) {
  savedSessions = Object.fromEntries(Object.entries(sessions).map(([id, s]) => [id, JSON.stringify(s)]));
  savedSessionRefs = { ...sessions };
  dirtySessionIds.clear();
  savedRevs = { ...revs };
  savedDrafts = structuredClone(drafts);
  savedCurrentSessionId = currentSessionId;
}

function markSessionDirty(sessionId = state.currentSessionId) {
  if (!sessionId) return;
  dirtySessionIds.add(sessionId);
  invalidateSessionSearch(sessionId);
}

function withStorageLock(task) {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('sidemind-local-storage', task) : task();
}

// Synchronous snapshot of everything this page changed since its last save.
function collectChanges(includeSessions) {
  const changes = { sessions: {}, removed: {}, drafts: {} };
  const snapshots = {};
  const nextDrafts = structuredClone(state.drafts);
  if (includeSessions) {
    Object.entries(state.sessions).forEach(([id, session]) => {
      // Only the visible chat can be edited without an explicit mutation
      // marker. New/replaced chats and marked background edits are also read.
      // Before a chat is selected, retain the full diff used during recovery.
      if (state.currentSessionId && id !== state.currentSessionId &&
          !dirtySessionIds.has(id) && savedSessionRefs[id] === session) return;
      const json = JSON.stringify(session);
      if (savedSessions[id] === json) {
        dirtySessionIds.delete(id);
        return;
      }
      snapshots[id] = json;
      changes.sessions[id] = { base: savedSessions[id] ?? null, baseRev: savedRevs[id], mine: JSON.parse(json) };
    });
    Object.keys(savedSessions).forEach((id) => {
      if (!(id in state.sessions)) changes.removed[id] = { rev: savedRevs[id] };
    });
    if (state.currentSessionId !== savedCurrentSessionId) changes.currentSessionId = state.currentSessionId;
  }
  Object.keys(savedDrafts).forEach((id) => {
    if (!(id in state.drafts)) changes.drafts[id] = null;
  });
  Object.entries(state.drafts).forEach(([id, text]) => {
    if (!sameValue(savedDrafts[id], text)) changes.drafts[id] = structuredClone(text);
  });
  const commit = () => {
    savedDrafts = nextDrafts;
    if (changes.currentSessionId !== undefined) savedCurrentSessionId = changes.currentSessionId;
  };
  const empty =
    !Object.keys(changes.sessions).length &&
    !Object.keys(changes.removed).length &&
    !Object.keys(changes.drafts).length &&
    changes.currentSessionId === undefined;
  return { changes, snapshots, commit, empty };
}

// Three-way merge of one chat by message id. Whenever both sides changed a
// message (or one side removed what the other changed) this page's version
// wins: it is the later write.
function mergeSession(base, mine, theirs) {
  const index = (list) => new Map(list.map((message) => [message.id, message]));
  const [b, m, s] = [index(base.messages), index(mine.messages), index(theirs.messages)];
  const resolved = new Map();
  for (const id of new Set([...b.keys(), ...m.keys(), ...s.keys()])) {
    const [bv, mv, sv] = [b.get(id), m.get(id), s.get(id)];
    // Equal to ours: keep our object, the live message may be streaming.
    const pick = sameValue(mv, sv) ? mv : sameValue(mv, bv) ? sv : mv;
    if (pick) resolved.set(id, pick);
  }
  const order = theirs.messages.map((message) => message.id).filter((id) => resolved.has(id));
  mine.messages.forEach((message, i) => {
    if (s.has(message.id) || !resolved.has(message.id)) return;
    const previous = mine.messages.slice(0, i).reverse().find((candidate) => order.includes(candidate.id));
    let at = previous ? order.indexOf(previous.id) + 1 : order.length;
    // Skip messages another page added meanwhile: ours are the later ones.
    while (at < order.length && !b.has(order[at]) && !m.has(order[at])) at += 1;
    order.splice(at, 0, message.id);
  });
  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if (key === 'messages') continue;
    const value = sameValue(mine[key], base[key]) ? theirs[key] : mine[key];
    if (value !== undefined) merged[key] = value;
  }
  merged.messages = order.map((id) => resolved.get(id));
  return merged;
}

// Pure: applies a changeset to copies of the stored tables. `tables.sessions`
// maps ids to stored `{ rev, session }` entries. Returns the new tables and the
// ids of the chats whose entry was written or removed.
function applyChanges(tables, changes) {
  const sessions = { ...tables.sessions };
  const drafts = { ...tables.drafts };
  const touched = new Set();
  Object.entries(changes.sessions || {}).forEach(([id, { base, baseRev, mine }]) => {
    const stored = sessions[id];
    // The stored chat is still the one this page last saw: nothing to merge.
    // (A changeset without a rev - an older build's - is always merged.)
    const untouched = !stored || (baseRev !== undefined && stored.rev === baseRev);
    const next = untouched ? mine : mergeSession(base ? JSON.parse(base) : { messages: [] }, mine, stored.session);
    if (stored && sameValue(next, stored.session)) return;
    sessions[id] = { rev: crypto.randomUUID(), session: next };
    touched.add(id);
  });
  Object.entries(changes.removed || {}).forEach(([id, { rev, base }]) => {
    const stored = sessions[id];
    // Only a chat nobody changed since this page saw it is removed.
    const unchanged = rev !== undefined ? stored?.rev === rev : stored && base && sameValue(stored.session, JSON.parse(base));
    if (!unchanged) return;
    delete sessions[id];
    touched.add(id);
  });
  Object.entries(changes.drafts || {}).forEach(([id, text]) => {
    if (text === null) delete drafts[id];
    else drafts[id] = text;
  });
  return { sessions, drafts, touched, currentSessionId: changes.currentSessionId };
}

// ----------------------------------------
// Older storage layouts
// ----------------------------------------
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// "conflict-<chat id>-<nonce>", nested when a copy conflicted again. Chat ids
// are timestamps or UUIDs, nonces always UUIDs.
const COPY_ID = new RegExp(`^(?:conflict-)+(${UUID}|\\d+)(?:-${UUID})+$`);
const COPY_SUFFIX = / \(conflicting copy\)/g;

// Does `newer` contain everything in `older`, the way a reply grows while it
// streams? Every message must be there with the same role and the older text
// must be the start of the newer one.
function growsInto(older, newer) {
  const byId = new Map(newer.messages.map((message) => [message.id, message]));
  const starts = (full, part) => String(full ?? '').startsWith(String(part ?? ''));
  return older.messages.every((message) => {
    const later = byId.get(message.id);
    return later && later.role === message.role && starts(later.content, message.content) && starts(later.reasoning, message.reasoning);
  });
}

// An earlier build saved a streaming reply over and over as "(conflicting
// copy)" chats, each a longer prefix of the same conversation. Folds every such
// family back into the chat it came from, but only when one member holds all
// the others; families that really diverge are left alone (their titles just
// lose the stacked suffixes). Works on, and returns, stored tables.
function mergeCopyFamilies(tables) {
  const families = new Map();
  Object.keys(tables.sessions).forEach((id) => {
    const root = COPY_ID.exec(id)?.[1];
    if (root) families.set(root, [...(families.get(root) || []), id]);
  });
  const sessions = { ...tables.sessions };
  const drafts = { ...tables.drafts };
  const touched = new Set();
  let currentSessionId;
  let folded = 0;
  families.forEach((copies, root) => {
    const members = [root, ...copies].filter((id) => sessions[id]);
    const heaviest = (id) => canonicalJSON(sessions[id].session).length;
    const keeper = members
      .filter((candidate) => members.every((other) => other === candidate || growsInto(sessions[other].session, sessions[candidate].session)))
      .sort((a, b) => heaviest(b) - heaviest(a))[0];
    if (!keeper) {
      copies.forEach((id) => {
        const title = sessions[id].session.title;
        if (typeof title === 'string' && (title.match(COPY_SUFFIX) || []).length > 1) {
          sessions[id] = { rev: crypto.randomUUID(), session: { ...sessions[id].session, title: title.replace(/( \(conflicting copy\))+$/, ' (conflicting copy)') } };
          touched.add(id);
        }
      });
      return;
    }
    const draft = [keeper, ...members].map((id) => drafts[id]).find(Boolean);
    const title = String(sessions[keeper].session.title ?? '').replace(/( \(conflicting copy\))+$/, '');
    const session = { ...sessions[keeper].session, title };
    members.forEach((id) => {
      delete sessions[id];
      delete drafts[id];
      touched.add(id);
      if (tables.currentSessionId === id) currentSessionId = root;
    });
    sessions[root] = { rev: crypto.randomUUID(), session };
    if (draft) drafts[root] = draft;
    folded += members.length - 1;
  });
  return { ...tables, sessions, drafts, touched, currentSessionId: currentSessionId ?? tables.currentSessionId, folded };
}

// Older stashes recorded a removal as the chat's JSON; they are otherwise the
// same shape as a current changeset and merge by their `base`.
function upgradeLegacyStash(change) {
  return {
    ...change,
    removed: Object.fromEntries(Object.entries(change.removed || {}).map(([id, base]) => [id, { base }]))
  };
}

// ----------------------------------------
// Keeping this page in step with storage
// ----------------------------------------

// Replaces a chat's content with another version in place: the live chat and
// its message objects stay the ones the rest of the page (a running stream, an
// open undo) holds.
function replaceSessionContent(live, next) {
  Object.keys(live).forEach((key) => {
    if (key !== 'messages' && !(key in next)) delete live[key];
  });
  Object.entries(next).forEach(([key, value]) => {
    if (key !== 'messages') live[key] = value;
  });
  const known = new Map(live.messages.map((message) => [message.id, message]));
  const messages = next.messages.map((message) => {
    const existing = known.get(message.id);
    if (!existing) return message;
    if (!sameValue(existing, message)) {
      const element = messageElementCache.get(message.id);
      if (element && elementMessages.get(element) === existing) messageElementCache.delete(message.id);
      Object.keys(existing).forEach((key) => delete existing[key]);
      Object.assign(existing, message);
    }
    return existing;
  });
  live.messages.splice(0, live.messages.length, ...messages);
}

// Takes a stored version of a chat into this page. False when the chat is busy
// (an answer is streaming into it) and it should be taken later.
function adoptStored(id, entry) {
  const current = id === state.currentSessionId;
  if (current && (state.isStreaming || state.generationDone || editingMessageId)) return false;
  const live = state.sessions[id];
  if (live) replaceSessionContent(live, entry.session);
  else state.sessions[id] = entry.session;
  savedSessions[id] = JSON.stringify(state.sessions[id]);
  savedSessionRefs[id] = state.sessions[id];
  savedRevs[id] = entry.rev;
  dirtySessionIds.delete(id);
  invalidateSessionSearch(id);
  if (current) renderMessages();
  if (elements.chatHistoryDropdown?.open) renderChatHistory();
  return true;
}

// After a write: the page's baseline for each chat it saved is what is now
// stored. If another page's messages were merged in, the page takes them over
// unless it changed the chat again while the write was in flight; then the
// baseline stays where it was, the chat stays "changed", and the next save
// merges once more.
function settleSaved(changes, snapshots, sessions) {
  let resave = false;
  Object.entries(changes.sessions).forEach(([id, { mine }]) => {
    const entry = sessions[id];
    if (!entry) return;
    const live = state.sessions[id];
    if (sameValue(entry.session, mine) || !live) {
      savedSessions[id] = snapshots[id];
      savedSessionRefs[id] = live;
      savedRevs[id] = entry.rev;
      if (!live || JSON.stringify(live) === snapshots[id]) dirtySessionIds.delete(id);
      else dirtySessionIds.add(id);
    } else if (JSON.stringify(live) !== snapshots[id] || !adoptStored(id, entry)) {
      resave = true;
    }
  });
  Object.keys(changes.removed).forEach((id) => {
    delete savedSessions[id];
    delete savedSessionRefs[id];
    delete savedRevs[id];
    dirtySessionIds.delete(id);
  });
  if (resave) debouncedSave();
}

// Brings one chat in step with what is stored (`entry`, or undefined once it
// was removed). Chats this page has unsaved changes in are left for the merge
// of its next save.
function followStoredSession(id, entry) {
  if (entry && entry.rev === savedRevs[id]) return;
  const live = state.sessions[id];
  const unsaved = live && JSON.stringify(live) !== savedSessions[id];
  if (!entry) {
    // Removed elsewhere; a chat this page is looking at or has changed stays.
    if (live && !unsaved && id !== state.currentSessionId) {
      delete state.sessions[id];
      delete savedSessions[id];
      delete savedSessionRefs[id];
      delete savedRevs[id];
      dirtySessionIds.delete(id);
      invalidateSessionSearch(id);
      if (elements.chatHistoryDropdown?.open) renderChatHistory();
    }
    return;
  }
  if (unsaved || (id in savedSessions && !live)) return; // merged when this page saves
  adoptStored(id, entry);
}

// Another page (or the folding of a closed page's stash) changed storage.
function handleStoredChanges(changes) {
  if (!storageReady) return;
  let fold = false;
  Object.entries(changes).forEach(([key, change]) => {
    if (key.startsWith(SESSION_PREFIX)) {
      followStoredSession(key.slice(SESSION_PREFIX.length), change.newValue);
    } else if (key.startsWith(PENDING_PREFIX) && change.newValue && !key.startsWith(`${PENDING_PREFIX}${pageId}:`)) {
      fold = true;
    }
  });
  if (fold) queueLocalSave(true, true);
}

// With `scanAll` (at load, and when another page left a stash) the whole
// storage is read: legacy layouts are converted and closed pages' stashes are
// folded in. Otherwise only the chats this page changed are read.
async function writeLocalChanges(includeSessions, { scanAll = false } = {}) {
  const { changes, snapshots, commit, empty } = collectChanges(includeSessions);
  if (empty && !scanAll) return;
  const ids = [...Object.keys(changes.sessions), ...Object.keys(changes.removed)];
  const stored = await chrome.storage.local.get(scanAll ? null : [...ids.map((id) => SESSION_PREFIX + id), 'drafts']);
  let tables = { sessions: {}, drafts: stored.drafts || {}, currentSessionId: stored.currentSessionId };
  Object.entries(stored).forEach(([key, entry]) => {
    if (key.startsWith(SESSION_PREFIX)) tables.sessions[key.slice(SESSION_PREFIX.length)] = entry;
  });
  const touched = new Set();
  const legacyTable = scanAll && stored.sessions && typeof stored.sessions === 'object' ? stored.sessions : null;
  Object.entries(legacyTable || {}).forEach(([id, session]) => {
    // Per-chat keys written by an interrupted conversion are the same chats.
    tables.sessions[id] = { rev: crypto.randomUUID(), session };
    touched.add(id);
  });
  // Stashes are folded oldest first: the key is random and the storage returns
  // keys in no meaningful order, so the version order travels in the payload.
  const pending = scanAll
    ? Object.keys(stored)
        .filter((key) => key.startsWith(PENDING_PREFIX) || key.startsWith(LEGACY_PENDING_PREFIX))
        .sort((a, b) => compareStashes(stored[a], stored[b]) || (a < b ? -1 : a > b ? 1 : 0))
    : [];
  // Replaying a stash is not idempotent (its drafts would overwrite newer ones),
  // so the set that folds a stash in also records its key. If removing the key
  // then fails, later saves see the marker and only retry the removal. A key is
  // never rewritten with different content (see stashChangesOnUnload), so the
  // key alone identifies the changeset.
  const applied = {};
  let legacy = Boolean(legacyTable);
  pending.forEach((key) => {
    applied[key] = true;
    if (stored.appliedPending?.[key]) return;
    const isLegacy = key.startsWith(LEGACY_PENDING_PREFIX);
    legacy ||= isLegacy;
    const folded = applyChanges(tables, isLegacy ? upgradeLegacyStash(stored[key]) : stored[key]);
    folded.touched.forEach((id) => touched.add(id));
    tables = { ...tables, ...folded, currentSessionId: folded.currentSessionId ?? tables.currentSessionId };
  });
  if (legacy) {
    const repaired = mergeCopyFamilies(tables);
    repaired.touched.forEach((id) => touched.add(id));
    repairedChats += repaired.folded;
    tables = repaired;
  }
  const own = applyChanges(tables, changes);
  own.touched.forEach((id) => touched.add(id));
  const staleMarks = Object.keys(stored.appliedPending || {}).length > 0;

  const data = {};
  const gone = [];
  touched.forEach((id) => {
    if (own.sessions[id]) data[SESSION_PREFIX + id] = own.sessions[id];
    else gone.push(SESSION_PREFIX + id);
  });
  if (legacyTable && !(LEGACY_BACKUP_KEY in stored)) data[LEGACY_BACKUP_KEY] = legacyTable;
  if (!sameValue(own.drafts, stored.drafts || {})) data.drafts = own.drafts;
  if (pending.length) data.appliedPending = applied;
  const selected = own.currentSessionId ?? tables.currentSessionId;
  if (selected !== undefined && selected !== stored.currentSessionId) data.currentSessionId = selected;
  // A removal that fails leaves nothing recorded, so a retry redoes it; a chat
  // still to be written is not lost either way.
  if (gone.length) await chrome.storage.local.remove(gone);
  if (Object.keys(data).length) await chrome.storage.local.set(data);
  // The tables are written: record that before anything else can fail, or a
  // retry would diff against a stale baseline and undo what other pages add.
  commit();
  lastStash = null;
  settleSaved(changes, snapshots, own.sessions);
  // Chats this write took over from stashes or conversions are new to this page.
  if (storageReady) {
    touched.forEach((id) => {
      if (!(id in changes.sessions) && !(id in changes.removed)) followStoredSession(id, own.sessions[id]);
    });
  }
  const leftovers = [...pending, ...(legacyTable ? ['sessions'] : [])];
  if (leftovers.length || staleMarks) await chrome.storage.local.remove([...leftovers, 'appliedPending']);
  // Reuse the recovered tables on startup instead of reading every transcript
  // (and the legacy backup) a second time while still holding the lock.
  if (scanAll) {
    return {
      drafts: own.drafts,
      currentSessionId: selected,
      ...Object.fromEntries(Object.entries(own.sessions).map(([id, entry]) => [SESSION_PREFIX + id, entry]))
    };
  }
}

// A closing page cannot wait for the lock or a read, and must not rewrite the
// shared tables from a stale view. It issues one write to a key of its own;
// the next page to load or save folds it in under the lock. Whether the browser
// finishes that single call during teardown cannot be guaranteed from here.
let lastStash = null;
let lastStashAt = 0;
let stashCounter = 0;

// Version order of stashes: wall clock (made strictly increasing within a page),
// then page id and a page-local counter. Stashes without an order (older builds)
// sort first, among themselves by key, which is the one case left ambiguous.
function compareStashes(a, b) {
  const [x, y] = [a?.order, b?.order];
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return x.at - y.at || (x.page < y.page ? -1 : x.page > y.page ? 1 : 0) || x.n - y.n;
}

function stashChangesOnUnload() {
  const { changes, empty } = collectChanges(true);
  if (empty) return;
  // Identical content (repeated pagehide, BFCache) reuses its key; anything
  // newer gets a key of its own so an older save cannot remove or be mistaken
  // for it.
  const json = JSON.stringify(changes);
  if (lastStash?.json !== json) {
    lastStashAt = Math.max(Date.now(), lastStashAt + 1);
    stashCounter += 1;
    lastStash = {
      json,
      key: `${PENDING_PREFIX}${pageId}:${crypto.randomUUID()}`,
      payload: { ...changes, order: { at: lastStashAt, page: pageId, n: stashCounter } }
    };
  }
  chrome.storage.local.set({ [lastStash.key]: lastStash.payload }).catch((error) => {
    console.error('Conversation save error:', error);
  });
}

// Draft and transcript writes share one queue, and each write takes the
// snapshot when it starts, so rapid switches and retries cannot write older
// drafts last. The lock serialises the read-merge-write across pages.
function queueLocalSave(includeSessions, scanAll = false) {
  if (storageLoadFailed) return Promise.resolve(false);
  storageWriteQueue = storageWriteQueue.then(async () => {
    elements.retryStorageBtn.disabled = true;
    try {
      await withStorageLock(() => writeLocalChanges(includeSessions, { scanAll }));
      if (includeSessions) elements.storageStatus.classList.add('hidden');
      const recoveredAttachments = attachmentSaveFailed;
      attachmentSaveFailed = false;
      if (recoveredAttachments && elements.attachBtn) updateInputState();
      return true;
    } catch (error) {
      console.error('Conversation save error:', error);
      showStorageFailure();
      return false;
    } finally {
      elements.retryStorageBtn.disabled = false;
    }
  });
  return storageWriteQueue;
}

function saveToStorage(sessionId = state.currentSessionId) {
  clearTimeout(saveTimeout);
  markSessionDirty(sessionId);
  return queueLocalSave(true);
}

// Debounced save
let saveTimeout = null;
function debouncedSave() {
  markSessionDirty();
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveToStorage(), 1000);
}

// Configuration writes are separate from transcript writes: a sync quota or
// connection failure must never prevent a local conversation from being saved.
let configSaveTimer = null;
let pendingConfigChanges = {};
let configWriteQueue = Promise.resolve();
function saveConfigSoon(changes) {
  pendingConfigChanges = { ...pendingConfigChanges, ...changes };
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(persistConfig, 450);
}

function persistConfig() {
  clearTimeout(configSaveTimer);
  configSaveTimer = null;
  const changes = { ...pendingConfigChanges };
  configWriteQueue = configWriteQueue.then(() => GenerationSettings.withLock(async () => {
    try {
      const result = await chrome.storage.sync.get(['config']);
      const config = { ...state.config, ...result.config, ...changes };
      assertConfigFitsSync(config);
      await chrome.storage.sync.set({ config });
      Object.keys(changes).forEach((key) => {
        if (pendingConfigChanges[key] === changes[key]) delete pendingConfigChanges[key];
      });
    } catch (error) {
      console.error('Configuration save error:', error);
      showNotification(error.name === 'SyncQuotaError' ? error.message : 'Could not save your selection. Select it again to retry.');
    }
  }));
}

function flushSidebarSaves() {
  clearTimeout(saveTimeout);
  if (configSaveTimer !== null) persistConfig();
  if (storageLoadFailed) return;
  stashChangesOnUnload();
}

// ----------------------------------------
// Drafts
// ----------------------------------------
// The side panel unloads the moment it is closed, so an unsent message is gone
// unless it has been written out. Kept on a short leash of its own rather than
// riding the 1s transcript debounce.
const DRAFT_SAVE_DELAY = 300;
let draftTimeout = null;

function normalizeDraft(value) {
  return typeof value === 'string' ? { text: value, attachments: [] }
    : { text: value?.text || '', attachments: value?.attachments || [] };
}

function draftHasContent(value) {
  const draft = normalizeDraft(value);
  return Boolean(draft.text.trim() || draft.attachments.length);
}

function saveDraftSoon() {
  const sessionId = state.currentSessionId;
  if (!sessionId) return;
  const previous = normalizeDraft(state.drafts[sessionId]);
  const draft = { text: elements.messageInput.value, attachments: previous.attachments.slice() };
  if (draftHasContent(draft)) state.drafts[sessionId] = draft;
  else delete state.drafts[sessionId];
  clearTimeout(draftTimeout);
  draftTimeout = setTimeout(persistDrafts, DRAFT_SAVE_DELAY);
}

function persistDrafts() {
  clearTimeout(draftTimeout);
  draftTimeout = null;
  return queueLocalSave(false);
}

function restoreDraft() {
  elements.messageInput.value = normalizeDraft(state.drafts[state.currentSessionId]).text;
  renderDraftAttachments();
  autoResizeTextarea();
}

function clearDraft() {
  delete state.drafts[state.currentSessionId];
  persistDrafts();
  renderDraftAttachments();
}

// ===== Attachment composer and local previews =====
const attachmentJobs = new Set();
let attachmentSaveFailed = false;
let editingAttachments = [];
const attachmentPreviewUrls = new Map();
let attachmentPreviewObserver;
const observedAttachmentImages = new Set();

function setupAttachmentListeners() {
  elements.attachmentInput.accept = Object.keys(AttachmentStore.TYPES).map((extension) => `.${extension}`).join(',');
  elements.attachBtn.addEventListener('click', () => elements.attachmentInput.click());
  elements.attachmentInput.addEventListener('change', handleAttachmentSelection);
  elements.messageInput.addEventListener('paste', handleAttachmentPaste);
  elements.composer.addEventListener('dragover', handleAttachmentDragOver);
  elements.composer.addEventListener('dragleave', handleAttachmentDragLeave);
  elements.composer.addEventListener('drop', handleAttachmentDrop);
  elements.cancelAttachmentsBtn.addEventListener('click', cancelAttachmentJobs);
}

function handleAttachmentSelection() {
  receiveAttachments([...elements.attachmentInput.files]);
  elements.attachmentInput.value = '';
}

function handleAttachmentPaste(event) {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  receiveAttachments(files);
}

function handleAttachmentDragOver(event) {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  elements.composer.classList.add('dragging-files');
}

function handleAttachmentDragLeave(event) {
  if (!elements.composer.contains(event.relatedTarget)) elements.composer.classList.remove('dragging-files');
}

function handleAttachmentDrop(event) {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  elements.composer.classList.remove('dragging-files');
  receiveAttachments([...event.dataTransfer.files]);
}

function cancelAttachmentJobs() {
  attachmentJobs.forEach((job) => { if (job.sessionId === state.currentSessionId) job.cancelled = true; });
}

async function receiveAttachments(files, editorId = null) {
  if (state.isPreparing || !files.length) return;
  const sessionId = state.currentSessionId;
  const job = { sessionId, editorId, cancelled: false };
  attachmentJobs.add(job);
  renderDraftAttachments();
  updateInputState();
  try {
    for (const file of files) {
      if (job.cancelled || !state.sessions[sessionId] || (editorId && editingMessageId !== editorId)) break;
      const refs = editorId ? editingAttachments : normalizeDraft(state.drafts[sessionId]).attachments;
      if (refs.length >= AttachmentStore.MAX_COUNT) throw new Error('A message can contain at most 10 attachments.');
      const ref = await AttachmentStore.validate(file);
      AttachmentStore.assertSupported([ref], getApiType(getCurrentProvider()));
      if (refs.reduce((size, entry) => size + entry.size, ref.size) > AttachmentStore.MAX_REQUEST_BYTES) throw new Error('Attachments must total no more than 20 MiB.');
      await withStorageLock(() => AttachmentStore.put(file, ref, pageId));
      if (job.cancelled || !state.sessions[sessionId] || (editorId && editingMessageId !== editorId)) break;
      const currentRefs = editorId ? editingAttachments : normalizeDraft(state.drafts[sessionId]).attachments;
      if (currentRefs.length >= AttachmentStore.MAX_COUNT || currentRefs.reduce((size, entry) => size + entry.size, ref.size) > AttachmentStore.MAX_REQUEST_BYTES) throw new Error('The attachment count or size limit was reached.');
      if (editorId) {
        editingAttachments = [...editingAttachments, ref];
        renderEditingAttachments();
      } else {
        const draft = normalizeDraft(state.drafts[sessionId]);
        state.drafts[sessionId] = { text: sessionId === state.currentSessionId ? elements.messageInput.value : draft.text, attachments: [...draft.attachments, ref] };
        if (!(await persistDrafts())) attachmentSaveFailed = true;
      }
      if (sessionId === state.currentSessionId) renderDraftAttachments();
    }
  } catch (error) {
    console.error('Attachment preparation:', error.name);
    showNotification(error.message || 'Could not save the attachment. Try again.');
  } finally {
    attachmentJobs.delete(job);
    renderDraftAttachments();
    updateInputState();
  }
}

function releaseAttachmentPreviews() {
  observedAttachmentImages.forEach((image) => {
    if (!image.isConnected) { attachmentPreviewObserver?.unobserve(image); observedAttachmentImages.delete(image); }
  });
  attachmentPreviewUrls.forEach((url, image) => {
    if (!image.isConnected) { URL.revokeObjectURL(url); attachmentPreviewUrls.delete(image); }
  });
}

async function loadAttachmentPreview(image, ref) {
  try {
    const original = await AttachmentStore.get(ref);
    let preview = original;
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      const bitmap = await createImageBitmap(original, { resizeWidth: 160, resizeQuality: 'medium' });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        preview = await canvas.convertToBlob({ type: 'image/png' });
      } finally { bitmap.close(); }
    }
    if (!image.isConnected) return;
    const url = URL.createObjectURL(preview);
    attachmentPreviewUrls.set(image, url);
    image.src = url;
  } catch (error) { image.alt = `Preview unavailable: ${ref.name}`; }
}

function renderAttachmentList(container, refs, remove = null) {
  container.replaceChildren();
  refs.forEach((ref, index) => {
    const row = document.createElement('div');
    row.className = 'attachment-card';
    if (ref.kind === 'image') {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'attachment-preview-btn';
      view.setAttribute('aria-label', `View ${ref.name}`);
      view.addEventListener('click', () => previewAttachment(ref));
      const image = document.createElement('img');
      image.alt = ref.name;
      image.className = 'attachment-thumbnail';
      image.loading = 'lazy';
      view.appendChild(image);
      row.appendChild(view);
      attachmentPreviewObserver ||= new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          observedAttachmentImages.delete(entry.target);
          loadAttachmentPreview(entry.target, entry.target.attachmentRef);
        });
      });
      image.attachmentRef = ref;
      observedAttachmentImages.add(image);
      attachmentPreviewObserver.observe(image);
    }
    const label = document.createElement('span');
    label.className = 'attachment-name';
    label.textContent = `${ref.name} · ${(ref.size / 1024).toFixed(ref.size < 10240 ? 1 : 0)} KB`;
    label.title = ref.name;
    row.appendChild(label);
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'undo-btn';
    download.textContent = 'Download';
    download.setAttribute('aria-label', `Download ${ref.name}`);
    download.addEventListener('click', () => downloadAttachment(ref));
    row.appendChild(download);
    if (remove) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'undo-btn';
      button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${ref.name}`);
      button.addEventListener('click', () => remove(index));
      row.appendChild(button);
    }
    container.appendChild(row);
  });
  queueMicrotask(releaseAttachmentPreviews);
}

function renderDraftAttachments() {
  if (!elements.draftAttachments) return;
  const refs = normalizeDraft(state.drafts[state.currentSessionId]).attachments;
  renderAttachmentList(elements.draftAttachments, refs, async (index) => {
    const draft = normalizeDraft(state.drafts[state.currentSessionId]);
    state.drafts[state.currentSessionId] = { ...draft, attachments: draft.attachments.filter((_, at) => at !== index) };
    if (!(await persistDrafts())) attachmentSaveFailed = true;
    renderDraftAttachments();
    updateInputState();
  });
  elements.attachmentStatus.hidden = ![...attachmentJobs].some((job) => job.sessionId === state.currentSessionId);
}

function renderEditingAttachments() {
  const container = messageElementCache.get(editingMessageId)?.querySelector('.editing-attachments');
  if (container) renderAttachmentList(container, editingAttachments, (index) => {
    editingAttachments = editingAttachments.filter((_, at) => at !== index);
    renderEditingAttachments();
  });
}

async function downloadAttachment(ref) {
  try {
    const url = URL.createObjectURL(await AttachmentStore.get(ref));
    const link = document.createElement('a');
    link.href = url;
    link.download = ref.name.replace(/[\\/\x00-\x1f]/g, '_');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { showNotification(error.message); }
}

let fullAttachmentPreviewUrl;
async function previewAttachment(ref) {
  try {
    const blob = await AttachmentStore.get(ref);
    const dialog = document.getElementById('attachmentPreviewDialog');
    if (dialog.open) return;
    fullAttachmentPreviewUrl = URL.createObjectURL(blob);
    const image = dialog.querySelector('img');
    image.alt = ref.name;
    image.src = fullAttachmentPreviewUrl;
    dialog.onclose = () => {
      URL.revokeObjectURL(fullAttachmentPreviewUrl);
      fullAttachmentPreviewUrl = null;
      image.removeAttribute('src');
    };
    dialog.showModal();
  } catch (error) { showNotification(error.message); }
}

async function retainUndoAttachments(value) {
  const refs = [...AttachmentStore.references(value)].map((id) => ({ id }));
  if (refs.length) await withStorageLock(() => AttachmentStore.pin(`${pageId}:undo`, refs, UNDO_TIMEOUT + 1000));
}

async function cleanupAttachments() {
  if (storageLoadFailed || !storageReady) return;
  try {
    await withStorageLock(async () => {
      await writeLocalChanges(true, { scanAll: true });
      const stored = await chrome.storage.local.get(null);
      const refs = AttachmentStore.references(stored);
      AttachmentStore.references(state.sessions, refs);
      AttachmentStore.references(state.drafts, refs);
      await AttachmentStore.collect(refs);
    });
  } catch (error) { console.warn('Attachment cleanup deferred:', error.name); }
}

// A selection is staged locally by the context menu. Import into the current
// draft only; the user reviews the source and explicitly sends the request.
let selectionStorageKey = null;
let selectionImportQueue = Promise.resolve();

async function initializeSelectionImport() {
  try {
    const window = await chrome.windows.getCurrent();
    selectionStorageKey = `selection:${window.id}`;
    await importSelectedText();
  } catch (error) {
    console.error('Selection import initialization:', error);
  }
}

function importSelectedText() {
  selectionImportQueue = selectionImportQueue.then(async () => {
    try {
      const result = await chrome.storage.session.get([selectionStorageKey]);
      const selection = result[selectionStorageKey];
      if (!selection?.text || storageLoadFailed) return;
      const quote = selection.text.split('\n').map((line) => `> ${line}`).join('\n');
      const source = selection.url ? `\n\nSource: ${selection.title || selection.url}\n${selection.url}` : '';
      const current = elements.messageInput.value;
      elements.messageInput.value = `${current}${current.trim() ? '\n\n' : ''}Help me understand this passage:\n\n${quote}${source}\n\n`;
      handleInputChange();
      // Consume once in this window. Failed disk saves remain visible with a
      // retry action, rather than appending the same quote a second time.
      await chrome.storage.session.remove([selectionStorageKey]);
      await persistDrafts();
      elements.messageInput.focus();
      showNotification(selection.truncated
        ? 'Selected text added to your draft (first 20,000 characters). Review it before sending.'
        : 'Selected text and source added to your draft. Review it before sending.');
    } catch (error) {
      console.error('Selection import:', error);
      showNotification('Could not import selected text. Try the context menu again.');
    }
  });
  return selectionImportQueue;
}

// ----------------------------------------
// Undo
// ----------------------------------------
// Truncating a conversation and deleting a chat are both one misplaced click
// away and neither used to be recoverable.
const UNDO_TIMEOUT = 10000;
let pendingUndo = null;

function offerUndo(text, restore) {
  clearUndo();

  pendingUndo = { restore, timer: setTimeout(clearUndo, UNDO_TIMEOUT) };
  elements.undoText.textContent = text;
  elements.undoBar.classList.remove('hidden');
  elements.historyUndoText.textContent = text;
  elements.historyUndo.classList.remove('hidden');
}

function clearUndo() {
  if (pendingUndo?.timer) clearTimeout(pendingUndo.timer);
  pendingUndo = null;
  elements.undoBar?.classList.add('hidden');
  elements.historyUndo?.classList.add('hidden');
}

async function applyUndo() {
  const undo = pendingUndo;
  clearUndo();
  if (!undo) return;

  await undo.restore();
  announce('Undone.');
}

// ========================================
// SESSION MANAGEMENT
// ========================================

// Anything that swaps the transcript out from under a running stream has to
// stop it first - otherwise the request keeps burning tokens into a session
// nobody is looking at, and cleanupStreaming can no longer find its message.
async function stopStreamingIfActive() {
  if (state.generationDone) await handleStopGeneration();
}

// A chat nobody wrote anything in is not worth keeping: New chat reuses it,
// and leaving it drops it, so history does not fill up with "New Chat" rows.
function isBlankSession(sessionId) {
  const session = state.sessions[sessionId];
  return Boolean(session && !session.messages.length && !draftHasContent(state.drafts[sessionId]));
}

// Makes `sessionId` the visible chat. Callers stop any running stream first.
function activateSession(sessionId) {
  markSessionDirty();
  if (sessionId !== state.currentSessionId && isBlankSession(state.currentSessionId)) {
    delete state.sessions[state.currentSessionId];
  }
  state.currentSessionId = sessionId;
  clearOldCacheEntries();
  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;

  saveToStorage();
  renderMessages();
  restoreDraft();
  updateInputState();
}

async function createNewSession() {
  closeModelPicker(false);
  await stopStreamingIfActive();

  if (isBlankSession(state.currentSessionId)) {
    elements.messageInput.focus();
    return;
  }

  const sessionId = crypto.randomUUID();
  state.sessions[sessionId] = {
    messages: [],
    title: 'New Chat',
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel,
    systemPromptId: state.config.selectedSystemPrompt
  };
  clearUndo();
  activateSession(sessionId);
}

async function switchSession(sessionId) {
  if (!state.sessions[sessionId]) return;

  if (sessionId !== state.currentSessionId) {
    await stopStreamingIfActive();
    clearUndo();
    activateSession(sessionId);
  }
  closeChatHistory();
}

async function deleteSession(sessionId) {
  if (!state.sessions[sessionId]) return;

  const wasCurrent = sessionId === state.currentSessionId;
  if (wasCurrent) {
    await stopStreamingIfActive();
  }

  const removed = state.sessions[sessionId];
  await retainUndoAttachments([removed, state.drafts[sessionId]]);
  const removedDraft = state.drafts[sessionId];

  removed.messages?.forEach((msg) => messageElementCache.delete(msg.id));
  delete state.sessions[sessionId];
  delete state.drafts[sessionId];
  invalidateSessionSearch(sessionId);

  // Switch to the most recent remaining chat, or start a new one
  if (wasCurrent) {
    const recent = Object.keys(state.sessions).sort(
      (a, b) => new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp)
    )[0];
    if (recent) activateSession(recent);
    else await createNewSession();
  } else {
    saveToStorage();
  }

  offerUndo(`Deleted "${removed.title}"`, () => {
    state.sessions[sessionId] = removed;
    if (removedDraft) state.drafts[sessionId] = removedDraft;
    // Deleting the open chat moved away from it; undoing moves back.
    if (wasCurrent) activateSession(sessionId);
    else saveToStorage(sessionId);
    if (elements.chatHistoryDropdown.open) renderChatHistory();
  });

  if (elements.chatHistoryDropdown.open) {
    renderChatHistory();
  }
}

// ========================================
// MESSAGE MANAGEMENT
// ========================================

// One line, cut on code points so an emoji or surrogate pair is never split
function titleFromContent(content) {
  const characters = Array.from(content.replace(/\s+/g, ' ').trim());
  return characters.length > 50 ? `${characters.slice(0, 50).join('')}…` : characters.join('');
}

function addMessage(role, content, reasoning = null, reasoningCollapsed = false, attachments = []) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  const message = {
    id: crypto.randomUUID(),
    role,
    content,
    reasoning,
    reasoningCollapsed,
    ...(attachments.length ? { attachments: structuredClone(attachments) } : {}),
    timestamp: new Date().toISOString()
  };

  session.messages.push(message);

  session.timestamp = new Date().toISOString();
  session.modelUsed = state.config.selectedModel;
  session.systemPromptId = state.config.selectedSystemPrompt;

  // Auto-generate title from first user message
  if (role === 'user' && session.messages.length === 1) {
    session.title = titleFromContent(content || attachments[0]?.name || 'Attachment');
  }

  debouncedSave();
  renderMessages();
}

// ========================================
// UI RENDERING
// ========================================

function renderMessages() {
  Promise.resolve().then(releaseAttachmentPreviews);
  updateSessionTitle();
  // Every caller either replaces the transcript or appends to it; neither is a
  // state an open editor should survive
  cancelEditing(false);
  clearOldCacheEntries();

  const session = state.sessions[state.currentSessionId];
  if (!session || session.messages.length === 0) {
    elements.messagesList.replaceChildren();
    latestAssistantElement = null;
    showWelcomeMessage();
    return;
  }

  hideWelcomeMessage();

  const previousScroll = elements.messagesList.scrollTop;
  const children = [];
  let lastModel = null;
  const latestAssistant = session.messages.findLast((message) => message.role === 'assistant');

  session.messages.forEach((message) => {
    let messageElement = messageElementCache.get(message.id);

    // Ids are only unique within a chat (another chat can hold a message with
    // the same id), so a cached node must belong to this message.
    if (!messageElement || elementMessages.get(messageElement) !== message) {
      messageElement = createMessageElement(message);
      elementMessages.set(messageElement, message);
      messageElementCache.set(message.id, messageElement);
    }

    // Keep unchanged messages and model dividers attached. Moving the entire
    // transcript through a fragment invalidates layout even when it is cached.
    if (message.role === 'assistant' && message.modelUsed) {
      if (lastModel && message.modelUsed !== lastModel) {
        let divider = modelDividers.get(messageElement);
        if (!divider) {
          divider = createModelDivider(message.modelUsed);
          if (divider) modelDividers.set(messageElement, divider);
        }
        if (divider) children.push(divider);
      }
      lastModel = message.modelUsed;
    }
    children.push(messageElement);
  });

  const latest = messageElementCache.get(latestAssistant?.id) || null;
  if (latest !== latestAssistantElement) {
    latestAssistantElement?.classList.remove('latest');
    latest?.classList.add('latest');
    latestAssistantElement = latest;
  }

  if (reconcileChildren(elements.messagesList, children)) {
    elements.messagesList.scrollTop = previousScroll;
    scrollToBottom();
  }
}

// Preserve attached nodes wherever possible, including when only the tail of
// a streamed Markdown document changes. New trailing nodes attach in one batch.
function reconcileChildren(container, children) {
  let cursor = container.firstChild;
  let changed = false;
  const retained = new Set(children);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    // Remove obsolete siblings before inserting a replacement. Otherwise all
    // later retained blocks would be moved ahead of the obsolete node, which
    // resets scroll positions and focus even though their identity survives.
    while (cursor && cursor !== child && !retained.has(cursor)) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
      changed = true;
    }
    if (child === cursor) {
      cursor = cursor.nextSibling;
    } else if (cursor) {
      container.insertBefore(child, cursor);
      changed = true;
    } else {
      const fragment = document.createDocumentFragment();
      children.slice(i).forEach((node) => fragment.appendChild(node));
      container.appendChild(fragment);
      changed = true;
      break;
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
    changed = true;
  }
  return changed;
}

// `system` is how failures are surfaced in the transcript - it used to borrow
// the assistant's robot avatar and name, which made an API error look like
// something the model said
const MESSAGE_ICONS = { user: 'user', assistant: 'robot', system: 'triangle-exclamation' };
const MESSAGE_LABELS = { user: 'You', assistant: 'Assistant', system: 'Error' };

function createModelDivider(modelUsed) {
  const [providerName, modelName] = describeModel(modelUsed);
  if (!modelName) return null;

  const divider = document.createElement('div');
  divider.className = 'model-divider';

  const label = document.createElement('span');
  label.textContent = `${modelName} · ${providerName}`;
  divider.appendChild(label);

  return divider;
}

function createMessageElement(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${message.role}`;
  messageDiv.setAttribute('data-message-id', message.id);

  // Header
  const header = document.createElement('div');
  header.className = 'message-header';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.appendChild(createIcon(MESSAGE_ICONS[message.role] || 'robot'));

  const senderName = document.createElement('span');
  senderName.className = 'sender-name';
  senderName.textContent =
    message.role === 'assistant'
      ? describeModel(message.modelUsed)[1] || 'Assistant'
      : MESSAGE_LABELS[message.role] || 'Assistant';

  header.appendChild(avatar);
  header.appendChild(senderName);

  // Wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble reading-content';

  const parts = displayParts(message);

  // Reasoning section (if exists)
  if (parts.reasoning.trim()) {
    bubble.appendChild(createReasoningSection(message));
  }

  // Content
  const content = document.createElement('div');
  content.className = 'message-content';

  if (message.role === 'user') {
    content.textContent = message.content;
  } else {
    renderMessageMarkdown(content, parts.content, !isStreamingMessage(message.id));
  }

  bubble.appendChild(content);
  if (message.attachments?.length) {
    const list = document.createElement('div');
    list.className = 'attachment-list message-attachments';
    renderAttachmentList(list, message.attachments);
    bubble.appendChild(list);
  }
  const status = document.createElement('span');
  status.className = 'response-status';
  bubble.appendChild(status);
  updateResponseStatus(messageDiv, message, status);

  // Waiting indicator - the only feedback between "sent" and the first token,
  // which with reasoning models can be half a minute away
  if (message.role === 'assistant') {
    bubble.appendChild(createTypingIndicator(message));
  }

  // Actions
  const actions = createMessageActions(message);

  wrapper.appendChild(bubble);
  wrapper.appendChild(actions);
  messageDiv.appendChild(header);
  messageDiv.appendChild(wrapper);

  return messageDiv;
}

function createReasoningSection(message) {
  const section = document.createElement('div');
  section.className = message.reasoningCollapsed
    ? 'reasoning-section'
    : 'reasoning-section expanded';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'reasoning-header';
  header.setAttribute('aria-expanded', String(!message.reasoningCollapsed));
  header.setAttribute('aria-controls', `reasoning-${message.id}`);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('reasoning-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.innerHTML = '<polyline points="9,18 15,12 9,6"></polyline>';

  const title = document.createElement('span');
  title.className = 'reasoning-title';
  title.textContent = reasoningTitle(message);

  header.appendChild(icon);
  header.appendChild(title);
  header.addEventListener('click', () => {
    section.classList.toggle('expanded');
    message.reasoningCollapsed = !section.classList.contains('expanded');
    header.setAttribute('aria-expanded', String(!message.reasoningCollapsed));
    // Once opened or closed by hand, stop auto-folding this one
    message.reasoningTouched = true;
    content.hidden = message.reasoningCollapsed;
    if (!message.reasoningCollapsed) {
      const streaming = isStreamingMessage(message.id);
      renderMessageMarkdown(content, displayParts(message).reasoning, !streaming);
      // Opened mid-stream: show where the thinking is now, and follow it
      if (streaming) content.scrollTop = content.scrollHeight;
    }
    debouncedSave();
  });

  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.id = `reasoning-${message.id}`;
  content.hidden = Boolean(message.reasoningCollapsed);
  if (!message.reasoningCollapsed) {
    renderMessageMarkdown(content, displayParts(message).reasoning, !isStreamingMessage(message.id));
  }

  section.appendChild(header);
  section.appendChild(content);

  return section;
}

function announce(text) {
  if (elements.srStatus) elements.srStatus.textContent = text;
}

function createTypingIndicator(message) {
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span>' +
    '<span class="typing-dot"></span><span class="typing-label">Waiting for a response</span><span class="typing-elapsed"></span>';
  indicator.hidden = !isAwaitingFirstToken(message);
  return indicator;
}

function isStreamingMessage(messageId) {
  return state.currentStreamingMessage?.id === messageId;
}

function isAwaitingFirstToken(message) {
  if (!isStreamingMessage(message.id)) return false;
  const { content, reasoning } = displayParts(message);
  return !content.trim() && !reasoning.trim();
}

// Some models stream their reasoning inline, as <think>…</think> ahead of the
// answer. processThinkTags() moves it out once the reply is finished; until
// then this view shows it as reasoning, rather than as an unknown tag that the
// sanitizer would drop together with all the text inside it.
function displayParts(message) {
  const content = message.content || '';
  const reasoning = message.reasoning || '';
  if (message.role !== 'assistant' || !isStreamingMessage(message.id)) return { content, reasoning };

  if (message.reasoningFormat === 'structured' || (message.protocol && message.reasoningFormat !== 'think-tags')) return { content, reasoning };
  const head = content.trimStart();
  // The opening tag itself can arrive split over several deltas
  if (head && '<thinking>'.startsWith(head)) return { content: '', reasoning };
  const open = head.match(/^<think(?:ing)?>/);
  if (!open) return { content, reasoning };

  const rest = head.slice(open[0].length);
  const close = rest.match(/<\/think(?:ing)?>/);
  const thought = (close ? rest.slice(0, close.index) : rest).trim();
  return {
    content: close ? rest.slice(close.index + close[0].length).trimStart() : '',
    reasoning: [reasoning, thought].filter(Boolean).join('\n\n')
  };
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function reasoningTitle(message) {
  if (message.thinkingMs != null) {
    return `Reasoning · ${formatDuration(message.thinkingMs)}`;
  }

  if (isStreamingMessage(message.id) && message.startedAt) {
    return `Reasoning… ${formatDuration(Date.now() - message.startedAt)}`;
  }

  return 'Reasoning / summary';
}

// Reasoning is considered finished the moment the first visible token lands
function markStreamProgress(message) {
  if (!message.startedAt || message.thinkingMs != null) return;
  const { content, reasoning } = displayParts(message);
  if (!content || !reasoning) return;

  message.thinkingMs = Date.now() - message.startedAt;

  // Fold the chain of thought away so the answer is not pushed off screen
  if (!message.reasoningTouched && !state.userScrolledUp && !state.readingResponse) {
    message.reasoningCollapsed = true;
  }
}

// Refresh just the elapsed-time labels - no markdown re-render
function updateStreamTimers() {
  const message = state.currentStreamingMessage;
  if (!message) {
    stopStreamTicker();
    return;
  }

  const element = messageElementCache.get(message.id);
  if (!element) return;

  const title = element.querySelector('.reasoning-title');
  if (title) title.textContent = reasoningTitle(message);

  const elapsed = element.querySelector('.typing-elapsed');
  if (elapsed && message.startedAt) {
    const waited = Date.now() - message.startedAt;
    // Stay quiet for short waits, speak up when the model is taking its time
    elapsed.textContent = waited >= 3000 ? formatDuration(waited) : '';
  }
}

function startStreamTicker() {
  stopStreamTicker();
  state.streamTicker = setInterval(updateStreamTimers, 1000);
}

function stopStreamTicker() {
  if (state.streamTicker) {
    clearInterval(state.streamTicker);
    state.streamTicker = null;
  }
}

// Syntax highlighting, a language label and a copy button. Only ever called on
// a finished message - mid-stream the whole subtree is replaced on the next
// repaint, so any of this would be thrown away immediately.
function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement.classList.contains('code-block')) return;

    const code = pre.querySelector('code');
    if (!code) return;
    const language = highlightCode(code);
    const card = document.createElement('div');
    card.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const label = document.createElement('span');
    label.className = 'code-language';
    label.textContent = language || 'Code';
    toolbar.appendChild(label);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-btn';
    button.setAttribute('aria-label', 'Copy code');
    button.replaceChildren(createIcon('copy'));
    button.addEventListener('click', () => copyCode(pre, button));

    toolbar.appendChild(button);
    pre.replaceWith(card);
    card.append(toolbar, pre);

    const lines = code.textContent.trimEnd().split('\n').length;
    if (lines > 24) {
      pre.id = `code-${crypto.randomUUID()}`;
      card.classList.add('collapsed');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'code-expand-btn';
      toggle.setAttribute('aria-controls', pre.id);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = `Show all ${lines} lines`;
      toggle.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = collapsed ? `Show all ${lines} lines` : 'Show fewer lines';
      });
      card.appendChild(toggle);
    }
  });
}

// Returns the language actually used, or '' when the block was left alone
function highlightCode(code) {
  if (!code || typeof hljs === 'undefined') return '';

  const declared = (code.className.match(/language-([\w+#-]+)/) || [])[1];
  if (!declared || declared === 'plaintext') return declared === 'plaintext' ? 'text' : '';

  // An unknown language would make hljs throw; leave those as plain text
  if (!hljs.getLanguage(declared)) return declared;

  try {
    const result = hljs.highlight(code.textContent, { language: declared, ignoreIllegals: true });
    code.innerHTML = result.value;
    code.classList.add('hljs');
    return declared;
  } catch (error) {
    console.warn('Highlight failed (ignored):', error.message);
    return declared;
  }
}

function copyCode(pre, button) {
  const code = pre.querySelector('code');
  return copyText(code ? code.textContent : pre.textContent, button, 'Copy code');
}

async function copyText(text, button, label) {
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    button.setAttribute('aria-label', 'Copied');
    button.replaceChildren(createIcon('check'));
    announce('Copied to clipboard.');

    setTimeout(() => {
      button.classList.remove('copied');
      button.setAttribute('aria-label', label);
      button.replaceChildren(createIcon('copy'));
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
    showNotification('Could not copy. Please select and copy the text manually.');
  }
}

function createMessageActions(message) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.title = 'Copy message';
  copyBtn.replaceChildren(createIcon('copy'));
  copyBtn.addEventListener('click', () => copyMessage(message, copyBtn));
  actions.appendChild(copyBtn);

  // Edit button - user messages only. Rewriting an assistant reply would be
  // putting words in the model's mouth, which is a different feature.
  if (message.role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-btn';
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.setAttribute('title', 'Edit message');
    editBtn.replaceChildren(createIcon('pen'));
    editBtn.addEventListener('click', () => startEditing(message));
    actions.appendChild(editBtn);
  }

  // Regenerate button
  const regenBtn = document.createElement('button');
  regenBtn.className = 'regenerate-btn';
  regenBtn.setAttribute('aria-label', message.role === 'system' ? 'Retry' : 'Regenerate response');
  regenBtn.setAttribute('title', message.role === 'system' ? 'Retry' : 'Regenerate response');
  regenBtn.replaceChildren(createIcon('redo'));
  regenBtn.addEventListener('click', () => regenerateMessage(message, regenBtn));

  // Cost of the turn: how long it took and what it burned
  const stats = document.createElement('span');
  stats.className = 'message-stats';
  applyMessageStats(stats, message);

  // Time
  const time = document.createElement('span');
  time.className = 'time-display';
  time.textContent = formatTime(message.timestamp);
  if (message.timestamp) time.title = new Date(message.timestamp).toLocaleString();

  if (message.role !== 'user') actions.appendChild(regenBtn);
  actions.appendChild(stats);
  actions.appendChild(time);

  return actions;
}

function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function applyMessageStats(element, message) {
  if (message.role !== 'assistant') {
    element.textContent = '';
    return;
  }

  const parts = [];
  if (message.durationMs) parts.push(formatDuration(message.durationMs));
  if (message.usage) parts.push(`${formatTokens(message.usage.total)} tok`);

  element.textContent = parts.join(' · ');

  if (message.usage) {
    const detail = [`${message.usage.input} in`, `${message.usage.output} out`];
    if (message.usage.reasoning != null) detail.push(`${message.usage.reasoning} reasoning`);
    element.title = detail.join(', ');
  }
}

function copyMessage(message, button) {
  return copyText(message.content, button, 'Copy message');
}

// ----------------------------------------
// Editing a user message
// ----------------------------------------
// Editing rewrites the turn and replays the conversation from there, which
// means discarding everything that followed - so it goes through the same undo
// bar as regenerating.
let editingMessageId = null;

function startEditing(message) {
  if (state.isStreaming || editingMessageId) return;

  const element = messageElementCache.get(message.id);
  const bubble = element?.querySelector('.message-bubble');
  const content = bubble?.querySelector('.message-content');
  if (!content) return;

  editingMessageId = message.id;
  editingAttachments = structuredClone(message.attachments || []);
  const savedAttachments = bubble.querySelector('.message-attachments');
  if (savedAttachments) savedAttachments.hidden = true;
  element.classList.add('editing');
  content.hidden = true;

  const editor = document.createElement('div');
  editor.className = 'message-editor';

  const input = document.createElement('textarea');
  input.className = 'message-edit-input';
  input.rows = 1;
  input.value = message.content;
  input.setAttribute('aria-label', 'Edit message');
  input.addEventListener('input', () => resizeEditor(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitEdit(message, input.value);
    }
  });

  const remaining = state.sessions[state.currentSessionId].messages;
  const laterCount = remaining.length - remaining.findIndex((item) => item.id === message.id) - 1;
  if (laterCount > 0) {
    const warning = document.createElement('p');
    warning.className = 'edit-warning';
    warning.textContent = `Sending this edit replaces ${laterCount} later message${laterCount === 1 ? '' : 's'}. You can undo it.`;
    editor.appendChild(warning);
  }

  const controls = document.createElement('div');
  controls.className = 'message-edit-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-small edit-cancel-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cancelEditing);

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary btn-small edit-submit-btn';
  submit.textContent = 'Send';
  submit.addEventListener('click', () => submitEdit(message, input.value));

  controls.appendChild(cancel);
  controls.appendChild(submit);
  const attached = document.createElement('div');
  attached.className = 'attachment-list editing-attachments';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.accept = elements.attachmentInput.accept;
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'btn btn-small';
  attach.textContent = 'Attach files';
  attach.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    receiveAttachments([...fileInput.files], message.id);
    fileInput.value = '';
  });
  controls.prepend(attach);
  editor.append(input, attached, fileInput, controls);
  bubble.appendChild(editor);
  renderEditingAttachments();

  resizeEditor(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function resizeEditor(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(Math.max(input.scrollHeight, 24), 240) + 'px';
}

function cancelEditing(restoreFocus = true) {
  if (!editingMessageId) return;

  const element = messageElementCache.get(editingMessageId);
  editingMessageId = null;
  if (!element) return;

  element.classList.remove('editing');
  element.querySelector('.message-editor')?.remove();

  const content = element.querySelector('.message-content');
  if (content) content.hidden = false;
  const attachments = element.querySelector('.message-attachments');
  if (attachments) attachments.hidden = false;
  editingAttachments = [];
  releaseAttachmentPreviews();
  if (restoreFocus) element.querySelector('.edit-btn')?.focus({ preventScroll: true });
}

async function submitEdit(message, rawText) {
  if (state.isStreaming || [...attachmentJobs].some((job) => job.editorId === message.id)) return;
  const text = rawText.trim();
  const attachments = structuredClone(editingMessageId === message.id ? editingAttachments : message.attachments || []);
  const session = state.sessions[state.currentSessionId];
  const index = session?.messages.findIndex((m) => m.id === message.id) ?? -1;
  if ((!text && !attachments.length) || index === -1) return;
  if (text === message.content && sameValue(attachments, message.attachments || [])) { cancelEditing(); return; }
  if (!ensureReadyToSend()) return;
  const previous = structuredClone(message);
  const previousTitle = session.title;
  const removed = session.messages.slice(index + 1);
  const edited = { ...message, content: text, attachments, timestamp: new Date().toISOString() };
  await sendMessageToAPI(null, {
    messages: [...session.messages.slice(0, index), edited],
    async commit() {
      await retainUndoAttachments([previous, ...removed]);
      if (state.abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      cancelEditing(false);
      Object.assign(message, edited);
      session.messages = session.messages.slice(0, index + 1);
      session.timestamp = new Date().toISOString();
      if (index === 0) session.title = titleFromContent(text || attachments[0].name);
      messageElementCache.delete(message.id);
      saveToStorage();
      offerUndo(describeEditUndo(removed.length), async () => {
        await stopStreamingIfActive();
        if (!Object.values(state.sessions).includes(session)) return;
        Object.assign(message, previous);
        if (!previous.attachments) delete message.attachments;
        session.title = previousTitle;
        session.messages = session.messages.slice(0, index + 1).concat(removed);
        messageElementCache.delete(message.id);
        saveToStorage();
        renderMessages();
      });
    }
  });
}

function describeEditUndo(removedCount) {
  if (removedCount === 0) return 'Edited message';
  return `Edited, removed ${removedCount} message${removedCount > 1 ? 's' : ''}`;
}

async function regenerateMessage(message, button) {
  if (state.isStreaming || state.generationDone || !ensureReadyToSend()) return;
  const session = state.sessions[state.currentSessionId];
  const index = session?.messages.findIndex((m) => m.id === message.id) ?? -1;
  if (index === -1) return;
  const cutFrom = message.role === 'user' ? index + 1 : index;
  const messages = session.messages.slice(0, cutFrom);
  if (!messages.some((item) => item.role === 'user')) return;
  const removed = session.messages.slice(cutFrom);
  button.classList.add('regenerating');
  button.replaceChildren(createIcon('spinner', 'spinning'));
  try {
    await sendMessageToAPI(null, {
      messages,
      async commit() {
        await retainUndoAttachments(removed);
        if (state.abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        session.messages = messages;
        session.timestamp = new Date().toISOString();
        saveToStorage();
        if (removed.length) offerUndo(`Removed ${removed.length} message${removed.length === 1 ? '' : 's'}`, async () => {
          await stopStreamingIfActive();
          if (!Object.values(state.sessions).includes(session)) return;
          session.messages = session.messages.slice(0, cutFrom).concat(removed);
          saveToStorage();
          renderMessages();
        });
      }
    });
  } finally {
    button.classList.remove('regenerating');
    button.replaceChildren(createIcon('redo'));
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// `cache` is false while streaming - otherwise every intermediate prefix of the
// growing message would be stored, filling the cache with entries that are
// never read again and evicting the finished messages that are.
function renderMarkdown(text, cache = true) {
  if (!text) return '';

  if (markdownCache.has(text)) {
    return markdownCache.get(text);
  }

  try {
    const html = sanitizeMarkdown(marked.parse(text));

    const chars = text.length + html.length;
    if (cache && text.length > 20 && chars <= MAX_MARKDOWN_CACHE_CHARS / 4) {
      while (markdownCache.size >= MAX_MARKDOWN_CACHE_SIZE || markdownCacheChars + chars > MAX_MARKDOWN_CACHE_CHARS) {
        const oldest = markdownCache.keys().next().value;
        markdownCacheChars -= oldest.length + markdownCache.get(oldest).length;
        markdownCache.delete(oldest);
      }
      markdownCache.set(text, html);
      markdownCacheChars += chars;
    }

    return html;
  } catch (error) {
    console.error('Markdown error:', error);
    return text.replace(
      /[&<>]/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]
    );
  }
}

// Keep provider-generated markup inside the transcript: no forms, autofocus,
// style overrides or executable URLs can become part of the surrounding UI.
function sanitizeMarkdown(html, asFragment = false) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowedTags = new Set([
    'P',
    'BR',
    'STRONG',
    'B',
    'EM',
    'I',
    'DEL',
    'S',
    'BLOCKQUOTE',
    'UL',
    'OL',
    'LI',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'PRE',
    'CODE',
    'A',
    'HR',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
    'TH',
    'TD',
    'IMG',
    'SUP',
    'SUB',
    'SPAN',
    'DETAILS',
    'SUMMARY'
  ]);
  template.content.querySelectorAll('*').forEach((node) => {
    // GFM task lists: keep the state as a glyph, never as a form control.
    // In a loose list the box sits in a paragraph inside the item.
    const taskItem = node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox' && node.closest('li');
    if (taskItem) {
      const box = document.createElement('span');
      box.className = 'task-checkbox';
      box.textContent = node.hasAttribute('checked') ? '☑' : '☐';
      taskItem.classList.add('task-item');
      node.replaceWith(box);
      return;
    }
    if (!allowedTags.has(node.tagName)) {
      node.remove();
      return;
    }
    Array.from(node.attributes).forEach((attribute) => {
      const { name, value } = attribute;
      const isText = name === 'title' || (node.tagName === 'IMG' && name === 'alt');
      const isLanguage =
        node.tagName === 'CODE' && name === 'class' && /^language-[\w+#-]+$/.test(value);
      const isNumber = ['colspan', 'rowspan', 'start'].includes(name) && /^\d{1,3}$/.test(value);
      const isAlign = ['TH', 'TD'].includes(node.tagName) && name === 'align' && /^(left|center|right)$/.test(value);
      const isTask = node.tagName === 'LI' && name === 'class' && value === 'task-item';
      let isUrl = false;
      if ((node.tagName === 'A' && name === 'href') || (node.tagName === 'IMG' && name === 'src')) {
        try {
          const url = new URL(value, location.href);
          isUrl =
            ['https:', 'http:'].includes(url.protocol) ||
            (node.tagName === 'A' && url.protocol === 'mailto:');
        } catch {}
      }
      if (!isText && !isLanguage && !isNumber && !isAlign && !isTask && !isUrl) node.removeAttribute(name);
    });
    // A remote image is a request to a third party that can carry anything the
    // model wrote into the URL, so it is never loaded until the user asks.
    if (node.tagName === 'IMG' && node.hasAttribute('src')) {
      node.setAttribute('data-remote-src', node.getAttribute('src'));
      node.removeAttribute('src');
    }
  });
  return asFragment ? template.content : template.innerHTML;
}

const deferredDisplays = new Set();

// Preserve finished subtrees (including expanded code) and avoid parsing an
// unchanged answer while only reasoning deltas are arriving.
function renderMessageMarkdown(container, text, finished) {
  const previous = renderedMarkdown.get(container);
  if (previous?.text === text && previous.finished === finished) return;
  if (previous?.text === text && finished) {
    // The last streamed frame is already sanitized. Add final controls without
    // parsing it again or resetting table scroll positions and loaded images.
    decorateMarkdown(container, true);
    renderedMarkdown.set(container, { text, finished });
    return;
  }
  if (!finished) {
    try {
      // Parse the complete source so references, lists and incomplete fences
      // keep standard Markdown semantics. Only replace changed top-level
      // blocks, and avoid serializing/reparsing the sanitized DOM every frame.
      const fragment = sanitizeMarkdown(marked.parse(text), true);
      const blocks = Array.from(fragment.childNodes, (node) => node.nodeType === 1 ? node.outerHTML : node.textContent);
      decorateMarkdown(fragment, false);
      const children = Array.from(fragment.childNodes);
      const existing = container.childNodes;
      blocks.forEach((block, index) => {
        if (previous?.blocks?.[index] === block && existing[index]) children[index] = existing[index];
      });
      reconcileChildren(container, children);
      renderedMarkdown.set(container, { text, finished, blocks });
      return;
    } catch (error) {
      console.error('Streaming markdown error:', error);
    }
  }
  container.innerHTML = renderMarkdown(text, finished);
  decorateMarkdown(container, finished);
  renderedMarkdown.set(container, { text, finished });
}

function resumeSelectedDisplays() {
  if (!document.getSelection()?.isCollapsed) return;
  deferredDisplays.forEach(scheduleMessageDisplay);
  deferredDisplays.clear();
}

function decorateMarkdown(container, finished = true) {
  container.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('table-scroll')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });
  container.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  container.querySelectorAll('img[data-remote-src]').forEach(createRemoteImageButton);
  if (finished) decorateCodeBlocks(container);
}

function createRemoteImageButton(image) {
  const url = new URL(image.dataset.remoteSrc, location.href);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remote-image-btn';
  button.textContent = `Load image from ${url.hostname}`;
  button.title = image.getAttribute('alt') || url.href;
  button.addEventListener('click', () => {
    const loaded = document.createElement('img');
    loaded.alt = image.getAttribute('alt') || '';
    loaded.referrerPolicy = 'no-referrer';
    loaded.src = url.href;
    button.replaceWith(loaded);
  });
  image.replaceWith(button);
}

function updateResponseStatus(
  element,
  message,
  status = element.querySelector('.response-status')
) {
  element.classList.toggle('streaming', isStreamingMessage(message.id));
  if (!status) return;
  status.textContent = message.error || responseCompletionNotice(message);
  status.classList.toggle('error', Boolean(message.error));
  status.hidden = !status.textContent;
  const actionName = message.error
    ? message.errorAction
    : message.incompleteReason === 'max_output_tokens' && 'settings';
  if (ERROR_ACTIONS[actionName]) {
    const [label, run] = ERROR_ACTIONS[actionName];
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'undo-btn';
    action.textContent = label;
    action.addEventListener('click', () => run(message, element));
    status.appendChild(action);
  }
  const retry = element.querySelector('.regenerate-btn');
  if (retry) {
    const label = message.error || message.incompleteReason || message.completionUnconfirmed ? 'Retry response' : 'Regenerate response';
    retry.setAttribute('aria-label', label);
    retry.title = label;
  }
  let details = element.querySelector('.response-details');
  if (message.errorDetail) {
    if (!details) {
      details = document.createElement('details');
      details.className = 'response-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Technical details';
      details.append(summary, document.createElement('pre'));
      status.after(details);
    }
    details.querySelector('pre').textContent = message.errorDetail;
  } else {
    details?.remove();
  }
}

const ERROR_ACTIONS = {
  'new-chat': ['Start new chat', () => createNewSession()],
  settings: ['Open settings', () => openOptions()],
  permission: ['Allow access', grantAccessAndRetry]
};

// The click is the user gesture Chrome requires to show its permission prompt
async function grantAccessAndRetry(message, element) {
  const provider = providerForModel(message.modelUsed) || getCurrentProvider();
  if (!provider || !(await requestProviderAccess([provider.baseUrl]))) {
    showNotification('Chrome did not grant access. You can allow it later from Settings.');
    return;
  }
  const retry = element.querySelector('.regenerate-btn');
  if (retry) await regenerateMessage(message, retry);
}

function responseCompletionNotice(message) {
  if (message.stopped) return 'Generation stopped · partial response';
  if (message.incompleteReason === 'max_output_tokens') {
    return 'Output limit reached · partial response. Increase Max Completion Tokens in Settings to retry.';
  }
  if (message.incompleteReason === 'content_filter') return 'The provider filtered this response · it may be incomplete.';
  if (message.incompleteReason) return 'The provider returned an incomplete response. You can retry.';
  if (message.unsupportedOutput?.length) return `The provider returned unsupported output: ${message.unsupportedOutput.join(', ')}. Tool execution is not supported.`;
  if (message.outcome === 'completed' && !message.content?.trim()) return message.reasoning?.trim()
    ? 'The provider returned reasoning but no answer text.' : 'The provider returned no displayable text.';
  if (message.completionUnconfirmed) return 'Completion not confirmed by the provider · this response may be incomplete.';
  return '';
}

function updateMessageDisplay(messageId) {
  const messageElement = messageElementCache.get(messageId);
  if (!messageElement) return;

  const message = state.sessions[state.currentSessionId]?.messages.find((m) => m.id === messageId);
  if (!message) return;

  const streaming = isStreamingMessage(messageId);
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && messageElement.contains(selection.anchorNode)) {
    deferredDisplays.add(messageId);
    return;
  }
  markStreamProgress(message);
  const scrollBefore = elements.messagesList.scrollTop;
  const parts = displayParts(message);

  // Update content
  const contentEl = messageElement.querySelector('.message-content');
  if (contentEl) {
    if (message.role === 'user') {
      contentEl.textContent = message.content;
    } else {
      renderMessageMarkdown(contentEl, parts.content, !streaming);
    }
  }

  // Update reasoning
  const bubble = messageElement.querySelector('.message-bubble');
  let reasoningSection = messageElement.querySelector('.reasoning-section');

  if (parts.reasoning.trim()) {
    if (!reasoningSection) {
      reasoningSection = createReasoningSection(message);
      bubble.insertBefore(reasoningSection, bubble.firstChild);
    } else {
      const reasoningContent = reasoningSection.querySelector('.reasoning-content');
      if (reasoningContent && !message.reasoningCollapsed) {
        // The panel scrolls on its own; keep the newest thinking in view
        // unless the reader scrolled up inside it.
        const pinned =
          reasoningContent.scrollHeight - reasoningContent.scrollTop - reasoningContent.clientHeight < 24;
        renderMessageMarkdown(reasoningContent, parts.reasoning, !streaming);
        if (streaming && pinned) reasoningContent.scrollTop = reasoningContent.scrollHeight;
      }

      const title = reasoningSection.querySelector('.reasoning-title');
      if (title) title.textContent = reasoningTitle(message);
    }

    reasoningSection.classList.toggle('expanded', !message.reasoningCollapsed);
    reasoningSection.querySelector('.reasoning-content').hidden = Boolean(message.reasoningCollapsed);
    reasoningSection
      .querySelector('.reasoning-header')
      .setAttribute('aria-expanded', String(!message.reasoningCollapsed));
  } else if (reasoningSection) {
    reasoningSection.remove();
  }

  // Waiting indicator
  const indicator = messageElement.querySelector('.typing-indicator');
  if (indicator) {
    indicator.hidden = !isAwaitingFirstToken(message);
  }

  const stats = messageElement.querySelector('.message-stats');
  if (stats && !streaming) {
    applyMessageStats(stats, message);
  }

  updateResponseStatus(messageElement, message);
  if (state.userScrolledUp || state.readingResponse) elements.messagesList.scrollTop = scrollBefore;
  scrollToBottom();
}

// ========================================
// UI HELPERS
// ========================================

// The empty state used to tell everyone to "select a model and start chatting"
// even when there was no provider to select one from, and nothing on screen was
// clickable.
function showWelcomeMessage() {
  elements.welcomeMessage?.classList.remove('hidden');
  elements.messagesList?.classList.add('hidden');
  renderWelcomeMessage();
}

function renderWelcomeMessage() {
  const container = elements.welcomeMessage;
  if (!container) return;
  const hasProviders = state.config.providers.some((provider) => provider.models?.length);
  const provider = getCurrentProvider();
  const needsKey = provider && !provider.apiKey?.trim();
  const hasModel = Boolean(provider && state.config.selectedModel && !needsKey);
  const mark = document.createElement('div');
  mark.className = 'welcome-mark';
  mark.appendChild(createIcon('comment'));
  const heading = document.createElement('h2');
  heading.textContent = hasProviders ? 'A little space to think.' : 'Make room for your next idea.';
  const body = document.createElement('p');
  body.textContent = !hasProviders
    ? 'Connect an AI provider to start your first conversation.'
    : hasModel
      ? 'Ask, explore, or work through something together.'
      : 'Choose a model above to get started.';
  container.replaceChildren(mark, heading, body);
  if (!hasProviders || needsKey) {
    if (needsKey)
      body.textContent = 'Add an API key for this provider in Settings to start chatting.';
    const action = document.createElement('button');
    action.className = 'btn btn-primary welcome-action';
    action.textContent = needsKey ? 'Open settings' : 'Connect a provider';
    action.addEventListener('click', openOptions);
    container.appendChild(action);
    return;
  }
  const suggestions = document.createElement('div');
  suggestions.className = 'prompt-suggestions';
  [
    [
      'Polish a piece of writing',
      'Please help me polish this text, keeping its original meaning:\n\n'
    ],
    ['Translate a passage', 'Please translate this passage and explain any important nuances:\n\n'],
    ['Explain some code', 'Please explain what this code does and suggest improvements:\n\n']
  ].forEach(([label, prompt]) => {
    const button = document.createElement('button');
    button.className = 'prompt-suggestion';
    button.textContent = label;
    button.disabled = !hasModel;
    button.addEventListener('click', () => {
      // Never replace what the user already typed; append like a selection import.
      const current = elements.messageInput.value;
      elements.messageInput.value = `${current}${current.trim() ? '\n\n' : ''}${prompt}`;
      handleInputChange();
      elements.messageInput.focus();
    });
    suggestions.appendChild(button);
  });
  container.appendChild(suggestions);
}

function hideWelcomeMessage() {
  elements.welcomeMessage?.classList.add('hidden');
  elements.messagesList?.classList.remove('hidden');
}

function scrollToBottom(force = false) {
  const list = elements.messagesList;
  if (!list) return;
  if (force) {
    state.userScrolledUp = false;
    state.readingResponse = false;
    state.followOutput = state.isStreaming;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: state.isStreaming || reduceMotion ? 'instant' : 'smooth'
    });
  } else {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && list.contains(selection.anchorNode)) {
      state.readingResponse = true;
    }
    const answer = messageElementCache.get(state.currentStreamingMessage?.id);
    // Let the beginning of a long answer stay in view instead of chasing tokens.
    if (
      state.isStreaming &&
      !state.followOutput &&
      answer &&
      answer.offsetHeight > list.clientHeight - 48
    ) {
      state.readingResponse = true;
    }
    if (!state.userScrolledUp && !state.readingResponse) list.scrollTop = list.scrollHeight;
  }
  updateScrollButton();
}

function updateScrollButton() {
  const button = elements.scrollBottomBtn;
  if (!button) return;

  const session = state.sessions[state.currentSessionId];
  const show = (state.userScrolledUp || state.readingResponse) && session?.messages.length > 0;

  button.classList.toggle('hidden', !show);
  button.classList.toggle('has-new', show && state.isStreaming);
  button.querySelector('span').textContent = state.isStreaming ? 'Follow response' : 'View latest';
}

let textareaResizeFrame = null;

function autoResizeTextarea() {
  const textarea = elements.messageInput;
  if (!textarea || textareaResizeFrame !== null) return;

  textareaResizeFrame = requestAnimationFrame(() => {
    textareaResizeFrame = null;
    textarea.style.height = 'auto';
    const newHeight = Math.min(
      Math.max(textarea.scrollHeight + 2, 62),
      Math.min(240, window.innerHeight * 0.3)
    );
    textarea.style.height = newHeight + 'px';
  });
}

function updateInputState() {
  const provider = getCurrentProvider();
  const hasConfig = Boolean(getReadyProvider());
  const hasMessage = elements.messageInput.value.trim().length > 0 || normalizeDraft(state.drafts[state.currentSessionId]).attachments.length > 0;
  const hasJobs = [...attachmentJobs].some((job) => job.sessionId === state.currentSessionId);
  const canSend = hasConfig && hasMessage && !state.isStreaming && !hasJobs && !attachmentSaveFailed;
  if (elements.attachBtn) elements.attachBtn.disabled = state.isPreparing;
  elements.draftAttachments?.querySelectorAll('button').forEach((button) => { button.disabled = state.isPreparing; });
  elements.messageInput.disabled = state.isPreparing;

  elements.sendBtn.disabled = !canSend;

  if (state.isStreaming) {
    elements.sendBtn.setAttribute('data-state', 'stop');
    elements.sendBtn.setAttribute('aria-label', 'Stop generation');
    elements.sendBtn.title = 'Stop generation (Esc)';
    elements.sendBtn.disabled = false;
  } else {
    elements.sendBtn.setAttribute('data-state', 'send');
    elements.sendBtn.setAttribute('aria-label', 'Send message');
    elements.sendBtn.title = 'Send message';
  }
  elements.modelSelector.disabled = state.isStreaming;
  if (state.isStreaming) closeModelPicker(false);
  elements.systemPromptSelector.disabled = state.isStreaming;
  elements.messageInput.placeholder = state.isStreaming
    ? 'Write your next message…'
    : hasConfig
      ? 'Ask a question…'
      : 'Connect a provider and choose a model…';
  clearTimeout(generationStatusTimer);
  elements.generationStatus.dataset.state = state.isStreaming ? 'active' : hasConfig ? 'idle' : 'setup';
  elements.generationStatus.textContent = state.isStreaming
    ? state.isPreparing ? 'Preparing message…' : 'Generating · you can draft your next message'
    : hasConfig
      ? 'Ready when you are'
      : provider && !provider.apiKey?.trim()
        ? 'Add this provider’s API key in Settings'
        : 'Choose a model to start chatting';
}

function applyFontSettings(appearance = state.config) {
  document.documentElement.style.setProperty('--reading-font-size', appearance.fontSize || '14px');
  if (appearance.fontFamily) {
    document.documentElement.style.setProperty('--reading-font-family', appearance.fontFamily);
  } else {
    document.documentElement.style.removeProperty('--reading-font-family');
  }
}

function applyTheme() {
  applyThemeClass(state.config.theme);
  cacheAppearance(state.config);
}

// ===== Model picker =====
function updateModelSelector() {
  const [providerName, modelName] = describeModel(state.config.selectedModel);
  const provider = providerForModel(state.config.selectedModel);
  const hasModels = state.config.providers.some((item) => item.models.length);
  elements.modelName.textContent = modelName || 'Choose a model';
  elements.modelProvider.textContent = providerName
    ? `${providerName}${getApiType(provider) === 'responses' ? ' · Responses' : ''}`
    : hasModels ? 'Select a model to start chatting' : 'Connect a provider in Settings';
  elements.modelSelector.title = modelName ? `${modelName} · ${providerName}` : 'Choose a model';
  if (!elements.modelPickerPanel.hidden) {
    positionModelPicker();
    renderModelOptions();
  }
}

function toggleModelPicker() {
  if (elements.modelPickerPanel.hidden) openModelPicker();
  else closeModelPicker(true);
}

function openModelPicker() {
  if (state.isStreaming) return;
  elements.modelSearch.value = '';
  elements.modelPickerPanel.hidden = false;
  elements.modelSelector.setAttribute('aria-expanded', 'true');
  elements.modelSearch.setAttribute('aria-expanded', 'true');
  positionModelPicker();
  renderModelOptions();
  elements.modelSearch.focus({ preventScroll: true });
}

function closeModelPicker(restoreFocus = false) {
  if (!elements.modelPickerPanel || elements.modelPickerPanel.hidden) return;
  elements.modelPickerPanel.hidden = true;
  elements.modelSelector.setAttribute('aria-expanded', 'false');
  elements.modelSearch.setAttribute('aria-expanded', 'false');
  elements.modelSearch.removeAttribute('aria-activedescendant');
  if (restoreFocus) elements.modelSelector.focus({ preventScroll: true });
}

function positionModelPicker() {
  if (elements.modelPickerPanel.hidden) return;
  const available = innerHeight - elements.modelSelector.getBoundingClientRect().bottom - 20;
  elements.modelPickerPanel.style.maxHeight = `${Math.max(0, Math.min(420, available))}px`;
}

function renderModelOptions() {
  const query = elements.modelSearch.value.trim().toLocaleLowerCase();
  const activeKey = elements.modelOptions.querySelector('.active')?.dataset.modelKey;
  const fragment = document.createDocumentFragment();
  const options = [];
  state.config.providers.forEach((provider, providerIndex) => {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    const label = document.createElement('div');
    label.className = 'model-option-group-label';
    label.id = `model-group-${providerIndex}`;
    label.textContent = `${provider.name}${getApiType(provider) === 'responses' ? ' · Responses' : ''}`;
    group.setAttribute('aria-labelledby', label.id);
    group.appendChild(label);
    provider.models.forEach((model, modelIndex) => {
      if (!`${provider.name} ${model.name} ${model.id}`.toLocaleLowerCase().includes(query)) return;
      const key = `${model.id} - ${provider.id}`;
      const selected = key === state.config.selectedModel;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option';
      option.id = `model-option-${providerIndex}-${modelIndex}`;
      option.dataset.modelKey = key;
      option.tabIndex = -1;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(selected));
      const text = document.createElement('span');
      text.className = 'model-option-text';
      const name = document.createElement('span');
      name.className = 'model-option-name';
      name.textContent = model.name;
      const id = document.createElement('span');
      id.className = 'model-option-id';
      id.textContent = model.id;
      text.append(name, id);
      option.appendChild(text);
      if (selected) option.appendChild(createIcon('check'));
      group.appendChild(option);
      options.push(option);
    });
    if (group.children.length > 1) fragment.appendChild(group);
  });
  elements.modelSearch.removeAttribute('aria-activedescendant');
  elements.modelOptions.replaceChildren(fragment);
  elements.modelOptions.hidden = options.length === 0;
  elements.modelPickerEmpty.hidden = options.length > 0;
  elements.modelPickerEmpty.textContent = query
    ? 'No matching models. Try a model ID or provider name.'
    : 'Add a provider in Settings to see your models here.';
  const active = options.find((option) => option.dataset.modelKey === activeKey)
    || options.find((option) => option.getAttribute('aria-selected') === 'true') || options[0];
  setActiveModelOption(active);
}

function setActiveModelOption(option, scroll = true) {
  elements.modelOptions.querySelector('.active')?.classList.remove('active');
  if (!option) {
    elements.modelSearch.removeAttribute('aria-activedescendant');
    return;
  }
  option.classList.add('active');
  elements.modelSearch.setAttribute('aria-activedescendant', option.id);
  if (scroll) option.scrollIntoView({ block: 'nearest' });
}

function handleModelTriggerKeydown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openModelPicker();
  }
}

function handleModelSearchKeydown(event) {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const options = Array.from(elements.modelOptions.querySelectorAll('[role="option"]'));
    const index = options.findIndex((option) => option.classList.contains('active'));
    const next = Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    setActiveModelOption(options[next]);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const option = elements.modelOptions.querySelector('.active');
    if (option) handleModelChange(option.dataset.modelKey);
  }
}

function handleModelOptionClick(event) {
  const option = event.target.closest('[role="option"]');
  if (option) handleModelChange(option.dataset.modelKey);
}

function handleModelOptionPointerMove(event) {
  const option = event.target.closest('[role="option"]');
  if (option && !option.classList.contains('active')) setActiveModelOption(option, false);
}

function handleModelPickerOutsideClick(event) {
  if (!elements.modelControl.contains(event.target)) closeModelPicker(false);
}

function handleModelPickerFocusOut(event) {
  if (!elements.modelControl.contains(event.relatedTarget)) closeModelPicker(false);
}

function manageModels() {
  closeModelPicker(true);
  openOptions();
}

function updateSystemPromptSelector() {
  elements.systemPromptSelector.innerHTML = '';

  state.config.systemPrompts.forEach((prompt) => {
    const option = document.createElement('option');
    option.value = prompt.id;
    option.textContent = prompt.name;

    if (state.config.selectedSystemPrompt === prompt.id) {
      option.selected = true;
    }

    elements.systemPromptSelector.appendChild(option);
  });
}

// ========================================
// EVENT HANDLERS
// ========================================

function handleModelChange(selectedValue) {
  if (state.isStreaming) return;
  const [modelId, providerId] = parseModelKey(selectedValue);
  const provider = state.config.providers.find((item) => item.id === providerId);
  if (!provider?.models.some((model) => model.id === modelId)) return;
  state.config.selectedModel = selectedValue;
  state.config.selectedProvider = providerId;
  saveConfigSoon({ selectedModel: selectedValue, selectedProvider: providerId });
  updateModelSelector();
  updateInputState();
  renderWelcomeMessage();
  closeModelPicker(true);
}

function handleSystemPromptChange(event) {
  state.config.selectedSystemPrompt = event.target.value;
  saveConfigSoon({ selectedSystemPrompt: state.config.selectedSystemPrompt });
}

function handleInputChange() {
  updateInputState();
  autoResizeTextarea();
  saveDraftSoon();
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.isStreaming && !elements.sendBtn.disabled) {
      handleSendMessage();
    }
  }
}

// Escape dismisses the active surface first, then stops generation.
function handleGlobalKeydown(event) {
  if (event.isComposing || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && !event.shiftKey && !elements.modelPickerPanel.hidden) {
    event.preventDefault();
    closeModelPicker(true);
    return;
  }
  const shortcut = event.ctrlKey || event.metaKey;
  if (shortcut && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    createNewSession();
    return;
  }
  if (event.shiftKey && !shortcut && !event.altKey && event.key === 'Escape') {
    event.preventDefault();
    closeModelPicker(false);
    elements.messageInput.focus();
    return;
  }
  if (event.key !== 'Escape') return;

  if (elements.chatHistoryDropdown.open) return;
  if (editingMessageId) {
    event.preventDefault();
    cancelEditing();
    return;
  }

  if (state.isStreaming) {
    event.preventDefault();
    handleStopGeneration();
  }
}

function handleScroll() {
  if (!elements.messagesList) return;

  const { scrollTop, scrollHeight, clientHeight } = elements.messagesList;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

  state.userScrolledUp = distanceFromBottom > 50;
  if (state.userScrolledUp) state.followOutput = false;
  updateScrollButton();
}

async function handleSendMessage() {
  const content = elements.messageInput.value.trim();
  const attachments = normalizeDraft(state.drafts[state.currentSessionId]).attachments;
  if ((!content && !attachments.length) || state.isStreaming || state.generationDone || elements.sendBtn.disabled) return;
  await sendMessageToAPI({ content, attachments: structuredClone(attachments) });
}

async function handleStopGeneration() {
  if (!state.abortController) return;
  const done = state.generationDone;
  state.abortController.abort();
  elements.sendBtn.disabled = true;
  elements.generationStatus.textContent = 'Stopping…';
  if (done) await done;
}

async function handleSendOrStop() {
  if (state.isStreaming) {
    await handleStopGeneration();
  } else {
    await handleSendMessage();
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function openChatHistory() {
  closeModelPicker(false);
  clearTimeout(historySearchTimer);
  elements.historySearch.value = '';
  historyVisibleCount = HISTORY_PAGE_SIZE;
  renderChatHistory();
  elements.chatHistoryDropdown.showModal();
  elements.historySearch.focus();
}

function closeChatHistory() {
  clearTimeout(historySearchTimer);
  historyRenderVersion += 1;
  elements.chatHistoryList.setAttribute('aria-busy', 'false');
  elements.chatHistoryDropdown.close();
}

function handleHistoryCancel(event) {
  event.preventDefault();
  closeChatHistory();
}

function handleHistoryBackdrop(event) {
  if (event.target !== elements.chatHistoryDropdown) return;
  const bounds = elements.chatHistoryDropdown.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    closeChatHistory();
}

async function handleOffline() {
  const message = state.currentStreamingMessage;
  if (!message) return;
  message.error =
    'Connection lost. This response may be incomplete. Check your connection and retry.';
  await handleStopGeneration();
}

function showNotification(text) {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = text;
  elements.notifications.replaceChildren(notification);
  setTimeout(() => notification.remove(), 5000);
}

function providerForModel(modelUsed) {
  if (!modelUsed) return null;
  const [modelId, providerId] = parseModelKey(modelUsed);
  return providerId
    ? state.config.providers.find((p) => p.id === providerId)
    : // Sessions written before the composite key stored a bare model id
      state.config.providers.find((p) => p.models.some((m) => m.id === modelId));
}

function describeModel(modelUsed) {
  const provider = providerForModel(modelUsed);
  const model = provider?.models.find((m) => m.id === parseModelKey(modelUsed)[0]);
  return provider && model ? [provider.name, model.name] : [];
}

function updateSessionTitle() {
  const session = state.sessions[state.currentSessionId];
  const title = session?.title || 'New Chat';
  const visibleTitle = session?.messages.length ? title : 'SideMind';
  if (elements.sessionTitle.textContent !== visibleTitle) elements.sessionTitle.textContent = visibleTitle;
  elements.sessionTitle.title = title;
  const pageTitle = `${title} · SideMind`;
  if (document.title !== pageTitle) document.title = pageTitle;
}

function scheduleHistorySearch() {
  clearTimeout(historySearchTimer);
  historyRenderVersion += 1;
  historySearchTimer = setTimeout(renderChatHistory, 150);
}

function invalidateSessionSearch(id) {
  const text = sessionSearchCache.get(id);
  if (text !== undefined) sessionSearchCacheChars -= text.length;
  sessionSearchCache.delete(id);
}

function sessionSearchText(id) {
  if (sessionSearchCache.has(id)) return sessionSearchCache.get(id);
  const session = state.sessions[id];
  const text = `${session.title} ${session.messages.map((message) => message.content).join(' ')}`.toLocaleLowerCase();
  if (text.length <= MAX_SESSION_SEARCH_CACHE_CHARS / 4) {
    while (sessionSearchCache.size >= MAX_SESSION_SEARCH_CACHE_SIZE || sessionSearchCacheChars + text.length > MAX_SESSION_SEARCH_CACHE_CHARS) {
      invalidateSessionSearch(sessionSearchCache.keys().next().value);
    }
    sessionSearchCache.set(id, text);
    sessionSearchCacheChars += text.length;
  }
  return text;
}

async function renderChatHistory() {
  const version = ++historyRenderVersion;
  const query = elements.historySearch.value.trim().toLocaleLowerCase();
  if (query !== historyLastQuery) historyVisibleCount = HISTORY_PAGE_SIZE;
  historyLastQuery = query;
  const sessionIds = [];
  const candidates = Object.keys(state.sessions);
  elements.chatHistoryList.setAttribute('aria-busy', 'true');
  let sliceStarted = performance.now();
  for (const id of candidates) {
    if (query && performance.now() - sliceStarted >= 8) {
      // Large body searches yield to typing, scrolling and stream consumption.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (version !== historyRenderVersion) return;
      sliceStarted = performance.now();
    }
    if (!state.sessions[id] || (id !== state.currentSessionId && isBlankSession(id))) continue;
    if (!query || sessionSearchText(id).includes(query)) sessionIds.push(id);
  }
  const timestamps = new Map(sessionIds.map((id) => [id, Date.parse(state.sessions[id].timestamp)]));
  sessionIds.sort((a, b) => timestamps.get(b) - timestamps.get(a));
  const fragment = document.createDocumentFragment();
  if (!sessionIds.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-history-empty';
    empty.textContent = query
      ? 'No matching conversations. Try another search.'
      : 'Your conversations will appear here.';
    elements.chatHistoryList.replaceChildren(empty);
    elements.chatHistoryList.setAttribute('aria-busy', 'false');
    return;
  }
  let lastGroup = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  sessionIds.slice(0, historyVisibleCount).forEach((sessionId) => {
    const session = state.sessions[sessionId];
    const date = new Date(session.timestamp);
    const days = Math.floor((today - date) / 86400000);
    const group =
      date >= today ? 'Today' : days < 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : 'Earlier';
    if (group !== lastGroup) {
      const heading = document.createElement('h4');
      heading.className = 'history-group';
      heading.textContent = group;
      fragment.appendChild(heading);
      lastGroup = group;
    }
    const item = document.createElement('div');
    item.className = `chat-history-item${sessionId === state.currentSessionId ? ' active' : ''}`;
    const content = document.createElement('button');
    content.className = 'chat-history-content';
    if (sessionId === state.currentSessionId) content.setAttribute('aria-current', 'true');
    const title = document.createElement('div');
    title.className = 'chat-history-title';
    title.textContent = session.title;
    const meta = document.createElement('div');
    meta.className = 'chat-history-meta';
    const when = group === 'Today' ? formatTime(session.timestamp) : date.toLocaleDateString();
    meta.textContent = `${when} · ${describeModel(session.modelUsed).join(' / ') || 'No model'}`;
    content.append(title, meta);
    content.addEventListener('click', () => switchSession(sessionId));
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    [
      ['Rename chat', 'pen', () => renameSession(sessionId, item)],
      ['Export chat', 'download', () => exportSession(sessionId)],
      ['Delete chat', 'trash-alt', () => deleteSession(sessionId)]
    ].forEach(([label, icon, handler]) => {
      const button = document.createElement('button');
      button.className = `icon-btn${icon === 'trash-alt' ? ' delete-chat-btn' : ''}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.appendChild(createIcon(icon));
      button.addEventListener('click', handler);
      actions.appendChild(button);
    });
    item.append(content, actions);
    fragment.appendChild(item);
  });
  if (sessionIds.length > historyVisibleCount) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'history-load-more btn btn-secondary';
    more.textContent = 'Show more conversations';
    more.addEventListener('click', loadMoreChatHistory);
    fragment.appendChild(more);
  }
  elements.chatHistoryList.replaceChildren(fragment);
  elements.chatHistoryList.setAttribute('aria-busy', 'false');
}

async function loadMoreChatHistory() {
  const previousCount = historyVisibleCount;
  historyVisibleCount += HISTORY_PAGE_SIZE;
  await renderChatHistory();
  elements.chatHistoryList.querySelectorAll('.chat-history-content')[previousCount]?.focus({ preventScroll: true });
}

function renameSession(sessionId, item) {
  const session = state.sessions[sessionId];
  const input = document.createElement('input');
  input.className = 'history-rename-input';
  input.setAttribute('aria-label', 'Conversation title');
  input.value = session.title;
  input.maxLength = 100;
  let cancelled = false;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelled = true;
      input.blur();
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      input.blur();
    }
  });
  input.addEventListener(
    'blur',
    () => {
      if (!cancelled && input.value.trim()) {
        session.title = input.value.trim();
        updateSessionTitle();
        saveToStorage(sessionId);
      }
      renderChatHistory();
      elements.historySearch.focus();
    },
    { once: true }
  );
  item.replaceChildren(input);
  input.focus();
  input.select();
}

function sessionMarkdown(session) {
  const title = session.title.replace(/\s+/g, ' ');
  const parts = [`# ${title}`, `Updated: ${session.timestamp}`];
  session.messages.forEach((message) => {
    const model = describeModel(message.modelUsed).join(' / ') || message.modelUsed || '';
    parts.push(`## ${MESSAGE_LABELS[message.role] || message.role}${model ? ` · ${model}` : ''}`, message.timestamp || '');
    if (message.reasoning?.trim()) parts.push('### Reasoning / summary', message.reasoning);
    if (message.content) parts.push(message.content);
    (message.attachments || []).forEach((ref) => parts.push(`Attachment: ${ref.name} · ${ref.mime} · ${ref.size} bytes (download the original in SideMind)`));
    const notice = message.error || responseCompletionNotice(message);
    if (notice) parts.push(`Status: ${notice}`);
    if (isStreamingMessage(message.id)) parts.push('Status: Generation still in progress · partial response');
  });
  return parts.join('\n\n') + '\n';
}

function exportSession(sessionId) {
  const session = state.sessions[sessionId];
  if (!session) return;
  const blob = new Blob([sessionMarkdown(session)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = session.title.replace(/[\x00-\x1f<>:"/\\|?*]/g, '').trim().slice(0, 80) || 'conversation';
  link.href = url;
  link.download = `${filename}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotification('Conversation exported as Markdown.');
}

async function sendMessageToAPI(draft = null, revision = null) {
  const provider = structuredClone(getReadyProvider());
  if (!provider) {
    showNotification('Choose a model with an API key in Settings, then retry.');
    return;
  }
  if (state.isStreaming || state.generationDone) return;
  state.generationDone = new Promise((resolve) => { state.resolveGeneration = resolve; });
  state.userScrolledUp = false;
  state.abortController = new AbortController();
  state.isStreaming = true;
  state.isPreparing = true;
  streamRenderCost = 0;
  updateInputState();
  let assistantMessage;
  let preparationError;
  try {
    const context = createRequestContext(provider);
    context.signal = state.abortController.signal;
    if (revision) context.messages = structuredClone(revision.messages);
    if (draft) context.messages.push({ role: 'user', content: draft.content, attachments: draft.attachments });
    context.body = await getAdapter(provider).buildRequestBody(context);
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (revision) await revision.commit();
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (draft) {
      clearUndo();
      addMessage('user', draft.content, null, false, draft.attachments);
      // A context-menu import can append text while Blob preparation awaits.
      // Clear only the draft that was actually captured by this request.
      const unchanged = elements.messageInput.value.trim() === draft.content &&
        sameValue(normalizeDraft(state.drafts[state.currentSessionId]).attachments, draft.attachments);
      if (unchanged) {
        elements.messageInput.value = '';
        clearDraft();
      } else saveDraftSoon();
      autoResizeTextarea();
    }
    state.isPreparing = false;
    assistantMessage = {
      reasoningFormat: provider.reasoningFormat || (getApiType(provider) === 'responses' ? 'structured' : 'think-tags'),
      id: crypto.randomUUID(), role: 'assistant', content: '', reasoning: '', reasoningCollapsed: true,
      startedAt: Date.now(), modelUsed: `${context.modelId} - ${provider.id}`, timestamp: new Date().toISOString()
    };
    assistantMessage.parameterOrigins = context.parameterOrigins;
    state.sessions[state.currentSessionId].messages.push(assistantMessage);
    state.currentStreamingMessage = assistantMessage;
    renderMessages();
    updateInputState();
    startStreamTicker();
    announce('Waiting for the assistant…');
    await streamResponse(provider, assistantMessage, context.signal, context);
  } catch (error) {
    preparationError = error;
    if (error.name !== 'AbortError') {
      console.error('Message failed:', error.name);
      if (assistantMessage) await handleApiError(error, provider);
      else showNotification(error.message);
    }
  } finally {
    try {
      state.isPreparing = false;
      cleanupStreaming(assistantMessage?.id, preparationError);
    } finally {
      state.resolveGeneration?.();
      state.resolveGeneration = null;
      state.generationDone = null;
    }
  }
}

function getCurrentProvider() {
  if (!state.config.selectedProvider) return null;
  return state.config.providers.find((p) => p.id === state.config.selectedProvider);
}

// The selected provider, only if a request to it can actually be made: the
// selected model still exists there and the provider has a key.
function getReadyProvider() {
  const provider = getCurrentProvider();
  const ready =
    provider?.apiKey?.trim() &&
    provider.models.some((model) => `${model.id} - ${provider.id}` === state.config.selectedModel);
  return ready ? provider : null;
}

// Regenerating and editing discard later turns before sending, so check first
// rather than leave the user with a truncated chat and an error.
function ensureReadyToSend() {
  if (getReadyProvider()) return true;
  showNotification(
    getCurrentProvider()
      ? 'Add an API key for this provider in Settings, then try again.'
      : 'Choose a model first, then try again.'
  );
  return false;
}

// ========================================
// API ADAPTERS
// ========================================

// Two request/response shapes are supported, selected per provider:
//   chat      -> POST /chat/completions  (legacy OpenAI Chat Completions)
//   responses -> POST /responses         (OpenAI Responses API)
// Each adapter owns its endpoint, request body, streaming events and
// non-streaming payload, so the rest of the app stays API-agnostic.
const API_ADAPTERS = {
  chat: {
    label: 'Chat Completions',
    endpoint: '/chat/completions',
    buildRequestBody: buildChatRequestBody,
    applyStreamEvent: applyChatStreamEvent,
    applyResponse: applyChatResponse,
    endStream(message) { message.streamComplete = true; message.streamEnded = true; message.outcome ||= message.incompleteReason ? 'incomplete' : 'completed'; }
  },
  responses: {
    label: 'Responses',
    endpoint: '/responses',
    buildRequestBody: buildResponsesRequestBody,
    applyStreamEvent: applyResponsesStreamEvent,
    applyResponse: applyResponsesBody,
    endStream(message) {
      message.streamEnded = true;
      if (!message.streamComplete) { message.completionUnconfirmed = true; message.outcome = 'unconfirmed'; }
    }
  }
};

function getApiType(provider) {
  return provider?.apiType === 'responses' ? 'responses' : 'chat';
}

function getAdapter(provider) {
  return API_ADAPTERS[getApiType(provider)];
}

// SIMPLIFIED STREAMING - Core streaming logic
async function streamResponse(provider, assistantMessage, signal, preparedContext = null) {
  provider = structuredClone(provider);
  const context = preparedContext || createRequestContext(provider);
  assistantMessage.reasoningFormat ||= provider.reasoningFormat || (getApiType(provider) === 'responses' ? 'structured' : 'think-tags');
  const adapter = getAdapter(provider);
  if (getApiType(provider) === 'responses') {
    assistantMessage.protocol = { version: 1, apiType: 'responses', source: context.source, output: [] };
  }
  context.signal = signal;
  const pendingBody = context.body || adapter.buildRequestBody(context);
  const body = pendingBody?.then ? await pendingBody : pendingBody;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  // Without streaming, the headers only arrive once the whole answer is ready
  const watchdog = createRequestWatchdog(
    signal,
    body.stream ? REQUEST_TIMEOUT_MS : COMPLETE_RESPONSE_TIMEOUT_MS
  );
  try {
    const response = await makeApiRequest(provider, adapter.endpoint, body, watchdog.signal);
    if (!response) return;
    assistantMessage.requestId = response.headers.get('x-request-id') || undefined;
    watchdog.touch();
    if (body.stream) {
      await processStream(response, assistantMessage, watchdog.signal, adapter, watchdog.touch);
    } else {
      await processNonStream(response, assistantMessage, watchdog.signal, adapter);
    }
    if (watchdog.signal.aborted) throw watchdog.signal.reason;
  } catch (error) {
    if (watchdog.signal.reason?.name === 'TimeoutError') throw watchdog.signal.reason;
    throw error;
  } finally {
    watchdog.dispose();
  }

  // cleanupStreaming finalizes both successful and interrupted responses once.
}

const REQUEST_TIMEOUT_MS = 120000;
const COMPLETE_RESPONSE_TIMEOUT_MS = 600000;
const STREAM_IDLE_TIMEOUT_MS = 180000;

// The watchdog lasts through body consumption, not just the response headers.
// A local controller preserves the distinction between timeout and user stop.
function createRequestWatchdog(signal, requestTimeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer = null;
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const arm = (delay, message) => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      const error = new Error(message);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, delay);
  };
  arm(requestTimeout, 'The provider did not respond in time. Check your connection and retry.');
  return {
    signal: controller.signal,
    touch: () => arm(STREAM_IDLE_TIMEOUT_MS, 'The response stopped arriving. Your partial answer is kept; you can retry.'),
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  };
}

// SSE events end at a blank line. Network chunks can split an event anywhere,
// and a single event can contain multiple data lines.
async function processStream(response, message, signal, adapter, onProgress = () => {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (done) {
        buffer += decoder.decode();
        // Tolerate providers that omit the final blank line.
        if (buffer.trim()) {
          processStreamEvent(buffer, message, adapter);
        }
        if (!message.streamComplete) { message.completionUnconfirmed = true; message.outcome = 'unconfirmed'; }
        break;
      }
      onProgress();

      const events = (buffer + decoder.decode(value, { stream: true })).split(/\r?\n\r?\n/);

      buffer = events.pop() || '';

      for (const event of events) {
        if (signal.aborted) {
          await reader.cancel();
          throw new DOMException('Aborted', 'AbortError');
        }
        processStreamEvent(event, message, adapter);
        if (message.streamEnded) break;
      }
      // [DONE] and Responses terminal events end the request even if a proxy
      // leaves the HTTP connection open. Chat finish_reason can precede usage.
      if (message.streamEnded) {
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function processStreamEvent(event, message, adapter) {
  const dataLines = [];
  let eventType = '';
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    } else if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    }
  }

  const data = dataLines.join('\n').trim();
  if (!data) return;
  if (data === '[DONE]') {
    adapter.endStream(message);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    message.streamParseErrors = (message.streamParseErrors || 0) + 1;
    console.warn('Malformed streaming event ignored.');
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    message.streamParseErrors = (message.streamParseErrors || 0) + 1;
    return;
  }

  if (!parsed.type && eventType) parsed.type = eventType;

  if (adapter.applyStreamEvent(parsed, message)) {
    scheduleMessageDisplay(message.id);
  }
}

// Compatible servers disagree on the field: DeepSeek, LM Studio and older
// vLLM use `reasoning_content`; OpenRouter, Ollama and newer vLLM `reasoning`.
// Some send both with the same text, so only one is read.
function readReasoningField(source) {
  const text = source.reasoning_content || source.reasoning;
  return typeof text === 'string' ? text : '';
}

// Chat Completions: deltas arrive under choices[0].delta
function applyChatStreamEvent(parsed, message) {
  if (parsed.error) {
    throw new Error(`API Error: ${parsed.error.message || 'Unknown streaming error'}`);
  }

  // Many providers volunteer usage on the final chunk; OpenAI only does when
  // asked via stream_options, which compatible servers often reject - so read
  // it when offered rather than requesting it.
  if (parsed.usage) {
    message.usage = readUsage(parsed.usage);
  }

  const choice = parsed.choices?.[0];
  if (choice?.finish_reason) {
    message.streamComplete = true;
    if (choice.finish_reason === 'length') message.incompleteReason = 'max_output_tokens';
    else if (choice.finish_reason === 'content_filter') message.incompleteReason = 'content_filter';
  }

  const delta = parsed.choices?.[0]?.delta;
  if (!delta) return false;

  let updated = false;

  const reasoning = readReasoningField(delta);
  if (reasoning) {
    message.reasoning = (message.reasoning || '') + reasoning;
    updated = true;
  }

  if (delta.content) {
    message.content = (message.content || '') + delta.content;
    updated = true;
  }

  return updated;
}

// Responses API: semantic events, each payload carries its own `type`.
// Only text/reasoning deltas and terminal events are meaningful here.
function applyResponsesStreamEvent(parsed, message) {
  try {
    return ResponsesProtocol.applyEvent(parsed, message);
  } finally {
    if (message.protocol?.usage) message.usage = readUsage(message.protocol.usage);
  }
}

// Process non-streaming response
async function processNonStream(response, message, signal, adapter) {
  if (signal.aborted) return;

  const data = await response.json();
  if (signal.aborted) return;

  adapter.applyResponse(data, message);
}

// Chat Completions: a single choices[0].message object
function applyChatResponse(data, message) {
  message.usage = readUsage(data.usage);

  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('The provider returned no answer. Check the API type in Settings and retry.');
  const reason = data.choices[0].finish_reason;
  if (reason === 'length') message.incompleteReason = 'max_output_tokens';
  else if (reason === 'content_filter') message.incompleteReason = 'content_filter';

  const reasoning = readReasoningField(msg);
  if (reasoning) {
    message.reasoning = reasoning;
  }

  if (msg.content) {
    message.content = msg.content;
  }
}

// A complete non-streaming body must look like a Responses object; `{}` or a
// Chat Completions payload would otherwise be reported as an empty success.
function applyResponsesBody(data, message) {
  return applyResponsesResponse(data, message);
}

function applyResponsesResponse(data, message) {
  try {
    ResponsesProtocol.applyBody(data, message);
  } finally {
    if (message.protocol?.usage) message.usage = readUsage(message.protocol.usage);
  }
}

// Chat Completions reports prompt/completion tokens, Responses reports
// input/output tokens. Normalise to one shape, or null when absent.
function readUsage(usage) {
  if (!usage) return null;

  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (input == null && output == null) return null;

  const reasoning =
    usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens ??
    null;

  return {
    input: input ?? 0,
    output: output ?? 0,
    total: usage.total_tokens ?? (input ?? 0) + (output ?? 0),
    reasoning
  };
}

// Process think tags. Code is located with the same Markdown lexer that
// renders the answer and masked first: a tag shown as an example in code is
// answer text, not reasoning. Token `raw` strings are verified against the
// source position by position. Fenced/indented blocks and code spans in plain
// paragraphs are masked exactly; a blockquote, list or table that contains
// code is masked whole (its children's raw text omits the quote/indent
// prefixes, so exact positions are not recoverable), which means a think tag
// elsewhere in that same quote, list or table is kept as answer text too. If
// the lexer output cannot be matched to the source, nothing is extracted.
// Tags are paired in the original text and skipped when they sit inside code.
function codeRanges(source) {
  // The lexer reads \r\n and \r as \n, so work on that form and map the
  // offsets back to the original text.
  const offsets = [];
  let text = '';
  for (let i = 0; i < source.length; i += 1) {
    offsets.push(i);
    if (source[i] === '\r') {
      text += '\n';
      if (source[i + 1] === '\n') i += 1;
    } else {
      text += source[i];
    }
  }
  offsets.push(source.length);
  const ranges = lexCodeRanges(text);
  return ranges && ranges.map(([start, end]) => [offsets[start], offsets[end]]);
}

function lexCodeRanges(text) {
  const hasCode = (token) =>
    token.type === 'code' ||
    token.type === 'codespan' ||
    [token.tokens, ...(token.items || []).map((item) => item.tokens), token.header?.map((cell) => cell.tokens), ...(token.rows || []).map((row) => row.map((cell) => cell.tokens))]
      .flat()
      .some((child) => child && (Array.isArray(child) ? child.some(hasCode) : hasCode(child)));
  const ranges = [];
  const walk = (tokens, start) => {
    let at = start;
    for (const token of tokens) {
      if (!text.startsWith(token.raw, at)) return false;
      const end = at + token.raw.length;
      if (token.type === 'code' || token.type === 'codespan') ranges.push([at, end]);
      else if (hasCode(token)) {
        const inline = token.tokens && !['blockquote', 'list', 'table'].includes(token.type);
        const mark = ranges.length;
        if (!inline || !walk(token.tokens, at)) {
          ranges.length = mark;
          ranges.push([at, end]);
        }
      }
      at = end;
    }
    return true;
  };
  return walk(marked.lexer(text), 0) ? ranges : null;
}

function processThinkTags(message) {
  if (message.reasoningFormat === 'structured' || (message.protocol && message.reasoningFormat !== 'think-tags')) return;
  if (!message.content || !/<think(?:ing)?>/.test(message.content)) return;

  const text = message.content;
  let ranges;
  try {
    ranges = codeRanges(text);
  } catch {
    ranges = null;
  }
  if (!ranges) return;
  const inCode = (at) => ranges.some(([start, end]) => at >= start && at < end);

  // Pair tags found in the original text and rebuild from its offsets, so
  // nothing is ever substituted into or back out of the answer.
  let kept = '';
  let from = 0;
  let open = null;
  const inner = [];
  for (const tag of text.matchAll(/<(\/?)think(?:ing)?>/g)) {
    if (inCode(tag.index)) continue;
    if (!tag[1]) {
      open ??= tag;
    } else if (open) {
      inner.push(text.slice(open.index + open[0].length, tag.index));
      kept += text.slice(from, open.index);
      from = tag.index + tag[0].length;
      open = null;
    }
  }
  // A reply that opened with a tag and never closed it (stopped or cut off
  // mid-thought) is all reasoning.
  if (inner.length === 0 && open && !text.slice(0, open.index).trim()) {
    inner.push(text.slice(open.index + open[0].length));
    from = text.length;
  }
  if (inner.length === 0) return;
  kept += text.slice(from);

  const extracted = inner.join('\n\n');
  if (extracted.trim()) {
    message.reasoning = message.reasoning ? `${message.reasoning}\n\n${extracted}` : extracted;
  }
  message.content = kept.trim();
}

// ========================================
// REQUEST BUILDING
// ========================================

function getSystemPromptContent() {
  const prompt = state.config.systemPrompts.find((p) => p.id === state.config.selectedSystemPrompt);
  return prompt?.content || '';
}

// Model selection uses a composite "modelId - providerId" key. It is split at
// the last separator: provider ids are generated, a model id can contain
// anything. Keys written before providers had ids are a bare model id.
function parseModelKey(key) {
  const text = String(key ?? '');
  const at = text.lastIndexOf(' - ');
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 3)];
}

function getSelectedModelId() {
  const selected = state.config.selectedModel;
  return selected ? parseModelKey(selected)[0] : selected;
}

function createRequestContext(provider = getCurrentProvider() || {}) {
  const modelId = getSelectedModelId();
  const instructions = getSystemPromptContent();
  const messages = structuredClone((state.sessions[state.currentSessionId]?.messages || [])
    .filter((message) => message.id !== state.currentStreamingMessage?.id));
  const { values: parameters, origins: parameterOrigins } = GenerationSettings.resolve(state.config, provider, modelId);
  return {
    provider: structuredClone(provider), modelId, instructions, messages,
    parameters, parameterOrigins,
    source: { providerId: provider.id || '', baseUrl: buildEndpointUrl(provider, ''), modelId, instructions }
  };
}

function requestParameters(context, responses = false) {
  const p = context.parameters;
  const fields = { model: context.modelId, stream: p.stream };
  if (p.temperature != null) fields.temperature = p.temperature;
  if (p.max_completion_tokens != null) fields[responses ? 'max_output_tokens' : 'max_completion_tokens'] = Number(p.max_completion_tokens);
  if (responses) {
    const reasoning = {};
    if (p.reasoning_effort != null) reasoning.effort = p.reasoning_effort;
    if (p.reasoning_summary != null) reasoning.summary = p.reasoning_summary;
    if (p.reasoning_context != null) reasoning.context = p.reasoning_context;
    if (Object.keys(reasoning).length) fields.reasoning = reasoning;
  } else if (p.reasoning_effort != null) fields.reasoning_effort = p.reasoning_effort;
  return fields;
}

// Attach originals only to the user turn being answered. Older attachment
// references stay local; a text record also preserves attachment-only turns.
function requestHistory(messages) {
  const currentTurn = messages.findLastIndex((message) => message.role === 'user');
  return messages.map((message, index) => {
    if (message.role !== 'user' || index === currentTurn || !message.attachments?.length) return message;
    const { attachments, ...previous } = message;
    const names = attachments.map((ref) => JSON.stringify(ref.name)).join(', ');
    const record = `[Earlier attachments; originals not included in this request: ${names}]`;
    return { ...previous, content: [message.content, record].filter(Boolean).join('\n\n') };
  });
}

function chatHistory(context) {
  return requestHistory(context.messages).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content?.trim()))
    .map((m) => ({ role: m.role, content: m.content || '', ...(m.attachments?.length ? { attachments: m.attachments } : {}) }));
}

function buildChatRequestBody(context = createRequestContext()) {
  const messages = chatHistory(context);
  if (context.instructions) messages.unshift({ role: 'system', content: context.instructions });
  const body = { ...requestParameters(context), messages };
  return hydrateRequest(body, 'messages', 'chat', context.signal);
}

function buildResponsesRequestBody(context = createRequestContext()) {
  const body = {
    ...requestParameters(context, true),
    input: ResponsesProtocol.history(requestHistory(context.messages), context.source),
    store: true
  };
  if (context.instructions) body.instructions = context.instructions;
  return hydrateRequest(body, 'input', 'responses', context.signal);
}

// Text-only requests stay synchronous; Blob hydration is needed only for attachments.
function hydrateRequest(body, key, apiType, signal) {
  if (!body[key].some((message) => message.attachments?.length)) return body;
  return AttachmentStore.hydrate(body, key, apiType, signal);
}

// Tolerate base URLs that already include the endpoint (e.g. .../v1/responses)
function buildEndpointUrl(provider, endpoint) {
  const base = (provider.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses)$/, '');

  return `${base}${endpoint}`;
}

async function makeApiRequest(provider, endpoint, body, signal) {
  const url = buildEndpointUrl(provider, endpoint);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail = String(payload?.error?.message || response.statusText || 'Request failed');
      const error = new Error(`API Error (${response.status}): ${detail}`);
      error.status = response.status;
      error.code = payload?.error?.code || null;
      error.param = payload?.error?.param || null;
      error.requestId = response.headers.get('x-request-id');
      // Provider errors occasionally echo credentials. Never store that key in
      // a transcript or its Markdown export.
      error.details = provider.apiKey ? error.message.split(provider.apiKey).join('[redacted]') : error.message;
      error.message = error.details;
      throw error;
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    return response;
  } catch (error) {
    if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason;
    if (error.name === 'AbortError') {
      return null;
    }
    throw error;
  }
}

function cleanupStreaming(messageId, preparationError = null) {
  const wasAborted = state.abortController?.signal.aborted;
  const session = state.sessions[state.currentSessionId];
  const message = session?.messages.find((item) => item.id === messageId);

  stopStreamTicker();
  pendingDisplayUpdates.delete(messageId);
  flushMessageDisplays();
  // Also after a stop, timeout or error, which skip the end of streamResponse
  if (message) processThinkTags(message);
  finalizeTiming(messageId);

  if (message) {
    message.outcome = message.error ? 'failed' : wasAborted ? 'stopped' : message.outcome || (message.incompleteReason ? 'incomplete' : message.completionUnconfirmed ? 'unconfirmed' : 'completed');
  }
  if (wasAborted && message) {
    const hasContent = message.content?.trim() || message.reasoning?.trim();

    if (hasContent) {
      message.timestamp = new Date().toISOString();
      message.stopped = !message.error;
    } else if (!message.error) {
      session.messages = session.messages.filter((m) => m.id !== messageId);
      messageElementCache.get(messageId)?.remove();
      messageElementCache.delete(messageId);
    }
  }

  state.isStreaming = false;
  state.currentStreamingMessage = null;
  state.abortController = null;

  if (!message && preparationError) {
    saveToStorage();
    updateInputState();
    elements.generationStatus.textContent = preparationError.name === 'AbortError'
      ? 'Preparation cancelled · draft kept' : 'Message could not be prepared · draft kept';
    elements.generationStatus.dataset.state = 'notice';
    announce(elements.generationStatus.textContent);
    return;
  }

  announce(
    message?.error
      ? 'Response failed. You can retry.'
      : wasAborted
        ? 'Generation stopped.'
        : responseCompletionNotice(message || {}) || 'Response complete.'
  );

  saveToStorage();
  // Repaint once more now that the message counts as finished: final markdown
  // goes into the cache, code blocks get their copy buttons, the reasoning
  // header settles on its final duration.
  updateMessageDisplay(messageId);
  updateInputState();
  elements.generationStatus.textContent = message?.error
    ? 'Response interrupted · retry is available'
    : wasAborted
      ? 'Generation stopped'
      : message?.incompleteReason
        ? 'Response incomplete · partial answer kept'
        : message?.completionUnconfirmed
          ? 'Response received · completion unconfirmed'
          : 'Response complete';
  const hasNotice = message?.error || wasAborted || message?.incompleteReason || message?.completionUnconfirmed;
  elements.generationStatus.dataset.state = hasNotice ? 'notice' : 'complete';
  if (!hasNotice) {
    generationStatusTimer = setTimeout(() => {
      elements.generationStatus.dataset.state = 'idle';
    }, 3000);
  }
}

function finalizeTiming(messageId) {
  const message = state.sessions[state.currentSessionId]?.messages.find((m) => m.id === messageId);
  if (!message?.startedAt) return;

  message.durationMs = Date.now() - message.startedAt;

  // A reply that was nothing but reasoning still deserves a duration
  if (message.thinkingMs == null && message.reasoning?.trim()) {
    message.thinkingMs = message.durationMs;
    if (!message.reasoningTouched && !state.userScrolledUp && !state.readingResponse) {
      message.reasoningCollapsed = true;
    }
  }
}

async function handleApiError(error, provider = getCurrentProvider()) {
  const key = provider?.apiKey;
  const redact = (text) => key ? text.split(key).join('[redacted]') : text;
  const safeError = {
    name: error.name,
    status: error.status,
    message: redact(error.message),
    code: error.code ? redact(String(error.code)) : null,
    param: error.param ? redact(String(error.param)).slice(0, 500) : null
  };
  const message = state.currentStreamingMessage;
  if (message) {
    message.error = getErrorMessage(safeError);
    message.errorDetail = redact(error.details || error.message).slice(0, 2000);
    message.outcome = 'failed';
    const safeField = (value) => value == null ? null : redact(String(value)).slice(0, 500);
    message.apiError = { code: safeField(error.code), param: safeField(error.param), requestId: safeField(error.requestId || message.requestId), status: error.status || null };
    if (message.protocol?.error) message.protocol.error = { ...message.apiError, message: safeError.message };
    const parameterKey = { 'reasoning.effort': 'reasoning_effort', 'reasoning.summary': 'reasoning_summary', 'reasoning.context': 'reasoning_context', max_output_tokens: 'max_completion_tokens' }[message.apiError.param] || message.apiError.param;
    if (message.apiError.param) {
      const origin = message.parameterOrigins?.[parameterKey];
      message.errorDetail += `\nParameter: ${message.apiError.param}${origin ? ` (from ${origin})` : ''}`;
    }
    if (message.apiError.requestId) message.errorDetail += `\nRequest ID: ${message.apiError.requestId}`;
    message.errorAction = isContextLimitError(safeError)
      ? 'new-chat'
      : [400, 401, 403, 404].includes(error.status) ? 'settings' : null;
    // fetch() rejects with a bare TypeError when CORS blocks the request.
    // Settings only sync, host permissions do not: on another device (or after
    // an import) a provider can be configured but not yet allowed here.
    if (error instanceof TypeError && provider && !(await hasProviderAccess(provider.baseUrl))) {
      message.error = `SideMind needs your permission to connect to ${new URL(provider.baseUrl).host}.`;
      message.errorAction = 'permission';
    }
    updateMessageDisplay(message.id);
    announce(`Error: ${message.error}`);
  } else {
    showError(getErrorMessage(safeError));
  }
}

const ERROR_HANDLERS = [
  {
    patterns: [
      'unsupported parameter',
      'unsupported value',
      'unknown parameter',
      'unrecognized request argument'
    ],
    message:
      'The provider rejected a request parameter. Check the API type, temperature and reasoning settings in options.'
  },
  { patterns: ['401', 'authentication'], message: 'Authentication failed. Check your API key.' },
  { patterns: ['404'], message: 'Model not found. Check your configuration.' },
  { patterns: ['429', 'rate limit'], message: 'Rate limit exceeded. Try again later.' },
  {
    patterns: ['cors', 'blocked'],
    message: () => {
      const provider = getCurrentProvider();
      return `CORS error. Need permission to access ${provider?.baseUrl}. Reconfigure in options.`;
    }
  },
  { patterns: ['network', 'fetch'], message: 'Network error. Check your connection.' }
];

function isContextLimitError(error) {
  if (error.code === 'context_length_exceeded') return true;
  return /context_length_exceeded|maximum context length|prompt is too long|input token limit/i.test(error.message);
}

function getErrorMessage(error) {
  if (error.name === 'TimeoutError') return error.message;
  if (isContextLimitError(error)) return 'This conversation exceeds the model’s context limit. Start a new chat or shorten your messages before retrying.';
  if (error.param && (error.status === 400 || /unsupported|invalid_parameter/.test(error.code || ''))) return `The provider rejected “${error.param}”. Review this model’s parameters in Settings.`;
  if (error.status === 400) return 'The provider rejected this request. Check the model, API type and parameters in Settings.';
  if (error.status === 401 || error.status === 403) return 'Access denied. Check your API key and model access in Settings.';
  if (error.status === 404) return 'Endpoint or model not found. Check the Base URL, API type and model in Settings.';
  if (error.status === 429) return 'The provider is limiting requests or your quota is exhausted. Check your quota, or wait before retrying.';
  if (error.status >= 500) return 'The provider is temporarily unavailable. Wait a moment and retry.';
  if (error.code === 'rate_limit_exceeded' || error.code === 'insufficient_quota') return 'The provider is limiting requests or your quota is exhausted. Check your quota, or wait before retrying.';
  const msg = error.message.toLowerCase();

  for (const { patterns, message } of ERROR_HANDLERS) {
    if (patterns.some((pattern) => msg.includes(pattern))) {
      return typeof message === 'function' ? message() : message;
    }
  }

  // Surface the provider's own message - far more useful than a generic string
  return error.message.startsWith('API Error')
    ? error.message
    : 'An error occurred. Please try again.';
}

function showError(message) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  const errorMsg = {
    id: crypto.randomUUID(),
    role: 'system',
    content: message,
    timestamp: new Date().toISOString()
  };

  session.messages.push(errorMsg);
  announce(`Error: ${message}`);
  renderMessages();
  saveToStorage();
}

console.log('SideMind loaded');
