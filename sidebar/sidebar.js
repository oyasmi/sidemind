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
    temperature: 0.7,
    max_completion_tokens: '',
    stream: true,
    reasoning_effort: '',
    reasoning_summary: 'off',
    theme: 'light',
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

// Simplified markdown cache with automatic size control
const markdownCache = new Map();
const MAX_MARKDOWN_CACHE_SIZE = 100;
const MAX_MARKDOWN_CACHE_CHARS = 1000000;
let markdownCacheChars = 0;
const renderedMarkdown = new WeakMap();
const sessionSearchCache = new Map();
let historySearchTimer = null;

// ----------------------------------------
// Throttled streaming updates
// ----------------------------------------
// A stream can deliver dozens of deltas per second and each repaint re-parses
// the whole message. Coalesce them into one repaint per interval instead.
const STREAM_RENDER_INTERVAL = 60;
const pendingDisplayUpdates = new Set();
let streamRenderTimer = null;

function scheduleMessageDisplay(messageId) {
  sessionSearchCache.delete(state.currentSessionId);
  pendingDisplayUpdates.add(messageId);
  if (streamRenderTimer !== null) return;

  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    flushMessageDisplays();
  }, STREAM_RENDER_INTERVAL);
}

function flushMessageDisplays() {
  if (streamRenderTimer !== null) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }

  if (pendingDisplayUpdates.size === 0) return;

  const ids = [...pendingDisplayUpdates];
  pendingDisplayUpdates.clear();
  ids.forEach((id) => updateMessageDisplay(id));
}

// Simple cache cleanup
function clearOldCacheEntries() {
  // Clean message cache for non-current sessions
  if (state.currentSessionId && state.sessions[state.currentSessionId]) {
    const currentMessages = new Set(
      state.sessions[state.currentSessionId].messages.map((m) => m.id)
    );

    for (const [messageId] of messageElementCache) {
      if (!currentMessages.has(messageId)) {
        messageElementCache.delete(messageId);
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

document.addEventListener('DOMContentLoaded', async () => {
  console.log('SideMind initializing...');

  cacheElements();
  await loadFromStorage();
  setupEventListeners();
  initializeUI();
  await initializeSelectionImport();

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
    'generationStatus',
    'historySearch',
    'historyUndo',
    'historyUndoText',
    'historyUndoBtn',
    'notifications',
    'sessionTitle',
    'storageStatus',
    'storageStatusText',
    'retryStorageBtn'
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

// Setup Event Listeners
function setupEventListeners() {
  elements.modelSelector.addEventListener('change', handleModelChange);
  elements.systemPromptSelector.addEventListener('change', handleSystemPromptChange);
  elements.newChatBtn.addEventListener('click', createNewSession);
  elements.sendBtn.addEventListener('click', handleSendOrStop);
  elements.optionsBtn.addEventListener('click', openOptions);

  elements.messageInput.addEventListener('input', handleInputChange);
  elements.messageInput.addEventListener('keydown', handleInputKeydown);

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
      state.config = { ...state.config, ...changes.config.newValue, ...pendingConfigChanges };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
      renderWelcomeMessage();
      applyFontSettings();
      applyTheme();
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
      state.config = { ...state.config, ...result.config };
      applyFontSettings();
      applyTheme();
    }
  } catch (error) {
    console.error('Configuration load error:', error);
    showNotification('Could not load settings. Reload SideMind to try again.');
  }
  try {
    const localResult = await chrome.storage.local.get(['sessions', 'currentSessionId', 'drafts']);

    if (localResult.sessions) {
      state.sessions = localResult.sessions;
    }

    if (localResult.drafts) {
      state.drafts = localResult.drafts;
    }

    if (localResult.currentSessionId) {
      state.currentSessionId = localResult.currentSessionId;
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

// Draft and transcript writes share one queue. Take the snapshot when each
// write starts, so rapid switches and retries cannot write older drafts last.
function queueLocalSave(includeSessions) {
  if (storageLoadFailed) return Promise.resolve(false);
  storageWriteQueue = storageWriteQueue.then(async () => {
    elements.retryStorageBtn.disabled = true;
    try {
      const data = { drafts: structuredClone(state.drafts) };
      if (includeSessions) {
        data.sessions = structuredClone(state.sessions);
        data.currentSessionId = state.currentSessionId;
      }
      await chrome.storage.local.set(data);
      if (includeSessions) elements.storageStatus.classList.add('hidden');
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

function saveToStorage() {
  clearTimeout(saveTimeout);
  sessionSearchCache.clear();
  return queueLocalSave(true);
}

// Debounced save
let saveTimeout = null;
function debouncedSave() {
  sessionSearchCache.clear();
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
  configWriteQueue = configWriteQueue.then(async () => {
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
  });
}

function flushSidebarSaves() {
  clearTimeout(saveTimeout);
  if (configSaveTimer !== null) persistConfig();
  saveToStorage();
}

// ----------------------------------------
// Drafts
// ----------------------------------------
// The side panel unloads the moment it is closed, so an unsent message is gone
// unless it has been written out. Kept on a short leash of its own rather than
// riding the 1s transcript debounce.
const DRAFT_SAVE_DELAY = 300;
let draftTimeout = null;

function saveDraftSoon() {
  const sessionId = state.currentSessionId;
  if (!sessionId) return;

  const text = elements.messageInput.value;
  if (text.trim()) {
    state.drafts[sessionId] = text;
  } else {
    delete state.drafts[sessionId];
  }

  if (draftTimeout) clearTimeout(draftTimeout);
  draftTimeout = setTimeout(persistDrafts, DRAFT_SAVE_DELAY);
}

function persistDrafts() {
  if (draftTimeout) {
    clearTimeout(draftTimeout);
    draftTimeout = null;
  }

  return queueLocalSave(false);
}

function restoreDraft() {
  elements.messageInput.value = state.drafts[state.currentSessionId] || '';
  autoResizeTextarea();
}

function clearDraft() {
  delete state.drafts[state.currentSessionId];
  persistDrafts();
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

async function createNewSession() {
  await stopStreamingIfActive();

  const sessionId = crypto.randomUUID();
  state.sessions[sessionId] = {
    messages: [],
    title: 'New Chat',
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel,
    systemPromptId: state.config.selectedSystemPrompt
  };
  state.currentSessionId = sessionId;
  clearOldCacheEntries();
  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;
  clearUndo();

  saveToStorage();
  renderMessages();
  restoreDraft();
  updateInputState();
}

async function switchSession(sessionId) {
  if (!state.sessions[sessionId]) return;

  await stopStreamingIfActive();

  state.currentSessionId = sessionId;
  clearOldCacheEntries();
  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;
  clearUndo();
  saveToStorage();
  renderMessages();
  restoreDraft();
  updateInputState();
  closeChatHistory();
}

async function deleteSession(sessionId) {
  if (!state.sessions[sessionId]) return;

  if (sessionId === state.currentSessionId) {
    await stopStreamingIfActive();
  }

  const removed = state.sessions[sessionId];
  const removedDraft = state.drafts[sessionId];

  // Clear cache for this session
  if (state.sessions[sessionId].messages) {
    state.sessions[sessionId].messages.forEach((msg) => {
      messageElementCache.delete(msg.id);
    });
  }

  delete state.sessions[sessionId];
  delete state.drafts[sessionId];

  // Switch to another session or create new
  if (state.currentSessionId === sessionId) {
    const remaining = Object.keys(state.sessions);
    if (remaining.length > 0) {
      const recent = remaining.sort(
        (a, b) => new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp)
      )[0];
      state.currentSessionId = recent;
      restoreDraft();
    } else {
      await createNewSession();
    }
  }

  saveToStorage();
  renderMessages();
  updateInputState();

  offerUndo(`Deleted "${removed.title}"`, () => {
    state.sessions[sessionId] = removed;
    if (removedDraft) state.drafts[sessionId] = removedDraft;
    saveToStorage();
    renderChatHistory();
  });

  if (elements.chatHistoryDropdown.open) {
    renderChatHistory();
  }
}

// ========================================
// MESSAGE MANAGEMENT
// ========================================

function titleFromContent(content) {
  return content.length > 50 ? content.substring(0, 50) + '...' : content;
}

function addMessage(role, content, reasoning = null, reasoningCollapsed = false) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  const message = {
    id: crypto.randomUUID(),
    role,
    content,
    reasoning,
    reasoningCollapsed,
    timestamp: new Date().toISOString()
  };

  session.messages.push(message);

  session.timestamp = new Date().toISOString();
  session.modelUsed = state.config.selectedModel;
  session.systemPromptId = state.config.selectedSystemPrompt;

  // Auto-generate title from first user message
  if (role === 'user' && session.messages.length === 1) {
    session.title = titleFromContent(content);
  }

  debouncedSave();
  renderMessages();
}

// ========================================
// UI RENDERING
// ========================================

function renderMessages() {
  updateSessionTitle();
  // Every caller either replaces the transcript or appends to it; neither is a
  // state an open editor should survive
  cancelEditing(false);

  const session = state.sessions[state.currentSessionId];
  if (!session || session.messages.length === 0) {
    showWelcomeMessage();
    return;
  }

  hideWelcomeMessage();

  const previousScroll = elements.messagesList.scrollTop;
  const fragment = document.createDocumentFragment();
  let lastModel = null;
  const latestAssistant = session.messages.findLast((message) => message.role === 'assistant');

  session.messages.forEach((message) => {
    // Mark where the conversation changed model, so a mixed transcript can be
    // read for what it is
    if (message.role === 'assistant' && message.modelUsed) {
      if (lastModel && message.modelUsed !== lastModel) {
        const divider = createModelDivider(message.modelUsed);
        if (divider) fragment.appendChild(divider);
      }
      lastModel = message.modelUsed;
    }

    let messageElement = messageElementCache.get(message.id);

    if (!messageElement) {
      messageElement = createMessageElement(message);
      messageElementCache.set(message.id, messageElement);
    }

    messageElement.classList.toggle('latest', message.id === latestAssistant?.id);
    fragment.appendChild(messageElement);
  });

  elements.messagesList.replaceChildren(fragment);
  elements.messagesList.scrollTop = previousScroll;
  scrollToBottom();
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
  avatar.innerHTML = `<i class="fas fa-${MESSAGE_ICONS[message.role] || 'robot'}"></i>`;

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
  bubble.className = 'message-bubble';

  // Reasoning section (if exists)
  if (message.reasoning && message.reasoning.trim()) {
    bubble.appendChild(createReasoningSection(message));
  }

  // Content
  const content = document.createElement('div');
  content.className = 'message-content';

  if (message.role === 'user') {
    content.textContent = message.content;
  } else {
    renderMessageMarkdown(content, message.content, !isStreamingMessage(message.id));
  }

  bubble.appendChild(content);
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
      renderMessageMarkdown(content, message.reasoning, !isStreamingMessage(message.id));
    }
    debouncedSave();
  });

  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.id = `reasoning-${message.id}`;
  content.hidden = Boolean(message.reasoningCollapsed);
  if (!message.reasoningCollapsed) {
    renderMessageMarkdown(content, message.reasoning, !isStreamingMessage(message.id));
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
  return isStreamingMessage(message.id) && !message.content?.trim() && !message.reasoning?.trim();
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
  if (!message.content || !message.reasoning) return;

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
    button.innerHTML = '<i class="fas fa-copy"></i>';
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

async function copyCode(pre, button) {
  const code = pre.querySelector('code');
  const text = code ? code.textContent : pre.textContent;

  try {
    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    button.setAttribute('aria-label', 'Copied');
    button.innerHTML = '<i class="fas fa-check"></i>';
    announce('Copied to clipboard.');

    setTimeout(() => {
      button.classList.remove('copied');
      button.setAttribute(
        'aria-label',
        button.classList.contains('code-copy-btn') ? 'Copy code' : 'Copy message'
      );
      button.innerHTML = '<i class="fas fa-copy"></i>';
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
  copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
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
    editBtn.innerHTML = '<i class="fas fa-pen"></i>';
    editBtn.addEventListener('click', () => startEditing(message));
    actions.appendChild(editBtn);
  }

  // Regenerate button
  const regenBtn = document.createElement('button');
  regenBtn.className = 'regenerate-btn';
  regenBtn.setAttribute('aria-label', message.role === 'system' ? 'Retry' : 'Regenerate response');
  regenBtn.setAttribute('title', message.role === 'system' ? 'Retry' : 'Regenerate response');
  regenBtn.innerHTML = '<i class="fas fa-redo"></i>';
  regenBtn.addEventListener('click', () => regenerateMessage(message, regenBtn));

  // Cost of the turn: how long it took and what it burned
  const stats = document.createElement('span');
  stats.className = 'message-stats';
  applyMessageStats(stats, message);

  // Time
  const time = document.createElement('span');
  time.className = 'time-display';
  time.textContent = formatTime(message.timestamp);

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

async function copyMessage(message, button) {
  try {
    const text = message.content;

    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    button.setAttribute('aria-label', 'Copied');
    button.innerHTML = '<i class="fas fa-check"></i>';
    announce('Copied to clipboard.');

    setTimeout(() => {
      button.classList.remove('copied');
      button.setAttribute(
        'aria-label',
        button.classList.contains('code-copy-btn') ? 'Copy code' : 'Copy message'
      );
      button.innerHTML = '<i class="fas fa-copy"></i>';
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
    showNotification('Could not copy. Please select and copy the text manually.');
  }
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
  editor.appendChild(input);
  editor.appendChild(controls);
  bubble.appendChild(editor);

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
  if (restoreFocus) element.querySelector('.edit-btn')?.focus({ preventScroll: true });
}

async function submitEdit(message, rawText) {
  const text = rawText.trim();
  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;
  const session = state.sessions[state.currentSessionId];
  const index = session ? session.messages.findIndex((m) => m.id === message.id) : -1;

  if (!text || index === -1) {
    cancelEditing();
    return;
  }

  const previousText = message.content;
  const previousTitle = session.title;
  const removed = session.messages.slice(index + 1);

  cancelEditing(false);

  if (text === previousText) return;

  message.content = text;
  message.timestamp = new Date().toISOString();
  session.messages = session.messages.slice(0, index + 1);
  session.timestamp = new Date().toISOString();

  // The first user message is what names the chat
  if (index === 0) session.title = titleFromContent(text);

  saveToStorage();
  renderMessages();
  updateMessageDisplay(message.id);

  const sessionId = state.currentSessionId;
  offerUndo(describeEditUndo(removed.length), async () => {
    await stopStreamingIfActive();

    const target = state.sessions[sessionId];
    if (!target) return;

    message.content = previousText;
    target.title = previousTitle;
    target.messages = target.messages.slice(0, index + 1).concat(removed);

    saveToStorage();
    renderMessages();
    updateMessageDisplay(message.id);
  });

  elements.messageInput.focus({ preventScroll: true });
  await sendMessageToAPI(text);
}

function describeEditUndo(removedCount) {
  if (removedCount === 0) return 'Edited message';
  return `Edited, removed ${removedCount} message${removedCount > 1 ? 's' : ''}`;
}

async function regenerateMessage(message, button) {
  if (state.isStreaming || state.generationDone) return;
  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;

  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  button.classList.add('regenerating');
  button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    const index = session.messages.findIndex((m) => m.id === message.id);
    if (index === -1) return;

    // Regenerating from a user message replays it; from an assistant or error
    // message it replaces that message onwards
    const cutFrom = message.role === 'user' ? index + 1 : index;
    const removed = session.messages.slice(cutFrom);

    session.messages = session.messages.slice(0, cutFrom);
    session.timestamp = new Date().toISOString();

    saveToStorage();
    renderMessages();

    if (removed.length > 0) {
      const sessionId = state.currentSessionId;
      const count = removed.length;

      offerUndo(`Removed ${count} message${count > 1 ? 's' : ''}`, async () => {
        await stopStreamingIfActive();

        const target = state.sessions[sessionId];
        if (!target) return;

        // Drop whatever the regeneration produced, then put the originals back
        target.messages = target.messages.slice(0, cutFrom).concat(removed);
        saveToStorage();
        renderMessages();
      });
    }

    if (message.role === 'user') {
      await sendMessageToAPI(message.content);
    } else {
      const lastUser = session.messages
        .slice()
        .reverse()
        .find((m) => m.role === 'user');
      if (lastUser) {
        await sendMessageToAPI(lastUser.content);
      }
    }
  } finally {
    button.classList.remove('regenerating');
    button.innerHTML = '<i class="fas fa-redo"></i>';
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
function sanitizeMarkdown(html) {
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
      let isUrl = false;
      if ((node.tagName === 'A' && name === 'href') || (node.tagName === 'IMG' && name === 'src')) {
        try {
          const url = new URL(value, location.href);
          isUrl =
            ['https:', 'http:'].includes(url.protocol) ||
            (node.tagName === 'A' && url.protocol === 'mailto:');
        } catch {}
      }
      if (!isText && !isLanguage && !isNumber && !isUrl) node.removeAttribute(name);
    });
  });
  return template.innerHTML;
}

const deferredDisplays = new Set();

// Preserve finished subtrees (including expanded code) and avoid parsing an
// unchanged answer while only reasoning deltas are arriving.
function renderMessageMarkdown(container, text, finished) {
  const previous = renderedMarkdown.get(container);
  if (previous?.text === text && previous.finished === finished) return;
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
    if (table.parentElement.classList.contains('table-scroll')) return;
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
  if (finished) decorateCodeBlocks(container);
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
  if ((message.error && message.errorAction) || message.incompleteReason === 'max_output_tokens') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'undo-btn';
    const needsNewChat = message.errorAction === 'new-chat';
    action.textContent = needsNewChat ? 'Start new chat' : 'Open settings';
    action.addEventListener('click', needsNewChat ? createNewSession : openOptions);
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

function responseCompletionNotice(message) {
  if (message.stopped) return 'Generation stopped · partial response';
  if (message.incompleteReason === 'max_output_tokens') {
    return 'Output limit reached · partial response. Increase Max Completion Tokens in Settings to retry.';
  }
  if (message.incompleteReason === 'content_filter') return 'The provider filtered this response · it may be incomplete.';
  if (message.incompleteReason) return 'The provider returned an incomplete response. You can retry.';
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

  // Update content
  const contentEl = messageElement.querySelector('.message-content');
  if (contentEl) {
    if (message.role === 'user') {
      contentEl.textContent = message.content;
    } else {
      renderMessageMarkdown(contentEl, message.content, !streaming);
    }
  }

  // Update reasoning
  const bubble = messageElement.querySelector('.message-bubble');
  let reasoningSection = messageElement.querySelector('.reasoning-section');

  if (message.reasoning && message.reasoning.trim()) {
    if (!reasoningSection) {
      reasoningSection = createReasoningSection(message);
      bubble.insertBefore(reasoningSection, bubble.firstChild);
    } else {
      const reasoningContent = reasoningSection.querySelector('.reasoning-content');
      if (reasoningContent && !message.reasoningCollapsed) {
        renderMessageMarkdown(reasoningContent, message.reasoning, !streaming);
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
  mark.innerHTML = '<i class="fas fa-comment" aria-hidden="true"></i>';
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
      elements.messageInput.value = prompt;
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

function autoResizeTextarea() {
  const textarea = elements.messageInput;
  if (!textarea) return;

  requestAnimationFrame(() => {
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
  const hasConfig =
    provider?.apiKey?.trim() &&
    provider.models.some((model) => `${model.id} - ${provider.id}` === state.config.selectedModel);
  const hasMessage = elements.messageInput.value.trim().length > 0;
  const canSend = hasConfig && hasMessage && !state.isStreaming;

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
  elements.systemPromptSelector.disabled = state.isStreaming;
  elements.messageInput.placeholder = state.isStreaming
    ? 'Write your next message…'
    : hasConfig
      ? 'Ask a question…'
      : 'Connect a provider and choose a model…';
  elements.generationStatus.textContent = state.isStreaming
    ? 'Generating · you can draft your next message'
    : hasConfig
      ? 'Ready when you are'
      : provider && !provider.apiKey?.trim()
        ? 'Add this provider’s API key in Settings'
        : 'Choose a model to start chatting';
}

function applyFontSettings() {
  document.documentElement.style.setProperty('--font-size', state.config.fontSize || '14px');
  if (state.config.fontFamily) {
    document.documentElement.style.setProperty('--font-family', state.config.fontFamily);
  } else {
    document.documentElement.style.removeProperty('--font-family');
  }
}

function applyTheme() {
  const theme = state.config.theme || 'light';
  const html = document.documentElement;

  html.classList.remove('light-theme', 'dark-theme');

  if (theme === 'light') {
    html.classList.add('light-theme');
  } else if (theme === 'dark') {
    html.classList.add('dark-theme');
  }
}

function updateModelSelector() {
  elements.modelSelector.innerHTML = '<option value="">Select Model...</option>';

  state.config.providers.forEach((provider) => {
    const optgroup = document.createElement('optgroup');
    // 非默认接口在分组标题上标注，便于区分同名 provider
    optgroup.label =
      getApiType(provider) === 'responses' ? `${provider.name} · Responses` : provider.name;

    provider.models.forEach((model) => {
      const option = document.createElement('option');
      // 使用复合键: "modelId - providerId"
      option.value = `${model.id} - ${provider.id}`;
      // Include the provider in the selected label, where optgroups are hidden.
      option.textContent = `${model.name} · ${provider.name}`;

      // 检查是否匹配当前的选中项
      if (state.config.selectedModel === `${model.id} - ${provider.id}`) {
        option.selected = true;
      }

      optgroup.appendChild(option);
    });

    elements.modelSelector.appendChild(optgroup);
  });
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

function handleModelChange(event) {
  const selectedValue = event.target.value;

  if (!selectedValue) {
    state.config.selectedModel = null;
    state.config.selectedProvider = null;
    saveConfigSoon({ selectedModel: null, selectedProvider: null });
    updateInputState();
    return;
  }

  // 解析复合键: "modelId - providerId"
  const [modelId, providerId] = selectedValue.split(' - ');

  if (!providerId || !modelId) {
    console.error('Invalid model selection format');
    return;
  }

  state.config.selectedModel = selectedValue; // 存储复合键
  state.config.selectedProvider = providerId;
  saveConfigSoon({ selectedModel: selectedValue, selectedProvider: providerId });
  updateInputState();
  renderWelcomeMessage();
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
  const shortcut = event.ctrlKey || event.metaKey;
  if (shortcut && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    createNewSession();
    return;
  }
  if (event.shiftKey && !shortcut && !event.altKey && event.key === 'Escape') {
    event.preventDefault();
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
  const message = elements.messageInput.value.trim();
  if (!message || state.isStreaming || state.generationDone || elements.sendBtn.disabled) return;

  state.userScrolledUp = false;
  state.readingResponse = false;
  state.followOutput = false;

  clearUndo();
  addMessage('user', message);

  elements.messageInput.value = '';
  clearDraft();
  autoResizeTextarea();
  updateInputState();
  elements.messageInput.focus();

  await sendMessageToAPI(message);
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
  clearTimeout(historySearchTimer);
  elements.historySearch.value = '';
  renderChatHistory();
  elements.chatHistoryDropdown.showModal();
  elements.historySearch.focus();
}

function closeChatHistory() {
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

function describeModel(modelUsed) {
  if (!modelUsed) return [];

  const [modelId, providerId] = String(modelUsed).split(' - ');

  const provider = providerId
    ? state.config.providers.find((p) => p.id === providerId)
    : // Sessions written before the composite key stored a bare model id
      state.config.providers.find((p) => p.models.some((m) => m.id === modelId));

  const model = provider?.models.find((m) => m.id === modelId);

  return provider && model ? [provider.name, model.name] : [];
}

function updateSessionTitle() {
  const session = state.sessions[state.currentSessionId];
  const title = session?.title || 'New Chat';
  elements.sessionTitle.textContent = session?.messages.length ? title : 'SideMind';
  elements.sessionTitle.title = title;
  document.title = `${title} · SideMind`;
}

function scheduleHistorySearch() {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(renderChatHistory, 150);
}

function sessionSearchText(id) {
  if (!sessionSearchCache.has(id)) {
    const session = state.sessions[id];
    sessionSearchCache.set(id, `${session.title} ${session.messages.map((message) => message.content).join(' ')}`.toLocaleLowerCase());
  }
  return sessionSearchCache.get(id);
}

function renderChatHistory() {
  elements.chatHistoryList.replaceChildren();
  const query = elements.historySearch.value.trim().toLocaleLowerCase();
  const sessionIds = Object.keys(state.sessions)
    .filter((id) => {
      return !query || sessionSearchText(id).includes(query);
    })
    .sort((a, b) => new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp));
  if (!sessionIds.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-history-empty';
    empty.textContent = query
      ? 'No matching conversations. Try another search.'
      : 'Your conversations will appear here.';
    elements.chatHistoryList.appendChild(empty);
    return;
  }
  let lastGroup = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  sessionIds.forEach((sessionId) => {
    const session = state.sessions[sessionId];
    const date = new Date(session.timestamp);
    const days = Math.floor((today - date) / 86400000);
    const group =
      date >= today ? 'Today' : days < 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : 'Earlier';
    if (group !== lastGroup) {
      const heading = document.createElement('h4');
      heading.className = 'history-group';
      heading.textContent = group;
      elements.chatHistoryList.appendChild(heading);
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
    meta.textContent = `${date.toLocaleDateString()} · ${describeModel(session.modelUsed).join(' / ') || 'No model'}`;
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
      button.innerHTML = `<i class="fas fa-${icon}" aria-hidden="true"></i>`;
      button.addEventListener('click', handler);
      actions.appendChild(button);
    });
    item.append(content, actions);
    elements.chatHistoryList.appendChild(item);
  });
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
        saveToStorage();
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

async function sendMessageToAPI(_userMessage) {
  const provider = getCurrentProvider();
  if (!provider) {
    showError('No provider configured. Please configure in options.');
    return;
  }

  if (state.isStreaming || state.generationDone) return;
  state.generationDone = new Promise((resolve) => {
    state.resolveGeneration = resolve;
  });

  // Initialize streaming state
  state.userScrolledUp = false;
  state.abortController = new AbortController();
  state.isStreaming = true;
  updateInputState();

  // Create assistant message
  const assistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoningCollapsed: true,
    startedAt: Date.now(),
    modelUsed: state.config.selectedModel,
    timestamp: new Date().toISOString()
  };

  state.sessions[state.currentSessionId].messages.push(assistantMessage);
  state.currentStreamingMessage = assistantMessage;
  renderMessages();
  startStreamTicker();
  announce('Waiting for the assistant…');

  try {
    await streamResponse(provider, assistantMessage, state.abortController.signal);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('API request failed:', error.name);
      handleApiError(error);
    }
  } finally {
    try {
      cleanupStreaming(assistantMessage.id);
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
    applyResponse: applyChatResponse
  },
  responses: {
    label: 'Responses',
    endpoint: '/responses',
    buildRequestBody: buildResponsesRequestBody,
    applyStreamEvent: applyResponsesStreamEvent,
    applyResponse: applyResponsesResponse
  }
};

function getApiType(provider) {
  return provider?.apiType === 'responses' ? 'responses' : 'chat';
}

function getAdapter(provider) {
  return API_ADAPTERS[getApiType(provider)];
}

// SIMPLIFIED STREAMING - Core streaming logic
async function streamResponse(provider, assistantMessage, signal) {
  const adapter = getAdapter(provider);
  const body = adapter.buildRequestBody();
  const watchdog = createRequestWatchdog(signal);
  try {
    const response = await makeApiRequest(provider, adapter.endpoint, body, watchdog.signal);
    if (!response) return;
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

  // Final processing
  pendingDisplayUpdates.delete(assistantMessage.id);
  flushMessageDisplays();
  processThinkTags(assistantMessage);
  updateMessageDisplay(assistantMessage.id);
}

const REQUEST_TIMEOUT_MS = 120000;
const STREAM_IDLE_TIMEOUT_MS = 180000;

// The watchdog lasts through body consumption, not just the response headers.
// A local controller preserves the distinction between timeout and user stop.
function createRequestWatchdog(signal) {
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
  arm(REQUEST_TIMEOUT_MS, 'The provider did not respond in time. Check your connection and retry.');
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
        if (!message.streamComplete) message.completionUnconfirmed = true;
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
    message.streamComplete = true;
    message.streamEnded = true;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    // Ignore parse errors, continue streaming
    console.warn('Parse error (ignored):', error.message);
    return;
  }

  if (!parsed.type && eventType) parsed.type = eventType;

  if (adapter.applyStreamEvent(parsed, message)) {
    scheduleMessageDisplay(message.id);
  }
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

  if (delta.reasoning_content) {
    message.reasoning = (message.reasoning || '') + delta.reasoning_content;
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
  if (parsed.error) {
    throw new Error(`API Error: ${parsed.error.message || 'Unknown streaming error'}`);
  }

  switch (parsed.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      if (!parsed.delta) return false;
      message.content = (message.content || '') + parsed.delta;
      return true;

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (!parsed.delta) return false;
      message.reasoning = (message.reasoning || '') + parsed.delta;
      return true;

    // A reasoning summary can be split into several parts - keep them readable
    case 'response.reasoning_summary_part.added':
      if (!message.reasoning) return false;
      message.reasoning += '\n\n';
      return true;

    case 'response.completed':
    case 'response.incomplete':
      message.streamComplete = true;
      message.streamEnded = true;
      // The terminal response is authoritative and may contain text or usage
      // that was not included in deltas. Replace rather than append it.
      applyResponsesResponse(parsed.response || {}, message);
      if (parsed.type === 'response.incomplete') {
        message.incompleteReason = parsed.response?.incomplete_details?.reason || 'unknown reason';
      }
      return true;

    case 'response.failed': {
      const error = parsed.response?.error;
      throw new Error(`API Error: ${error?.message || 'Response failed'}`);
    }

    case 'error':
      throw new Error(`API Error: ${parsed.message || 'Unknown streaming error'}`);

    default:
      return false;
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

  if (msg.reasoning_content) {
    message.reasoning = msg.reasoning_content;
  }

  if (msg.content) {
    message.content = msg.content;
  }
}

// Responses API: a list of output items. `reasoning` items hold the summary
// (and optionally raw reasoning text), `message` items hold the answer.
function applyResponsesResponse(data, message) {
  if (data.error || data.status === 'failed') {
    throw new Error(`API Error: ${data.error?.message || 'Response failed'}`);
  }

  message.usage = readUsage(data.usage);

  const contentParts = [];
  const reasoningParts = [];

  (data.output || []).forEach((item) => {
    if (item?.type === 'reasoning') {
      (item.summary || []).forEach((part) => part?.text && reasoningParts.push(part.text));
      (item.content || []).forEach((part) => part?.text && reasoningParts.push(part.text));
    } else if (item?.type === 'message') {
      (item.content || []).forEach((part) => {
        if (part?.type === 'output_text' && part.text) {
          contentParts.push(part.text);
        } else if (part?.type === 'refusal' && part.refusal) {
          contentParts.push(part.refusal);
        }
      });
    }
  });

  if (reasoningParts.length > 0) {
    message.reasoning = reasoningParts.join('\n\n');
  }

  if (contentParts.length > 0) {
    message.content = contentParts.join('');
  } else if (typeof data.output_text === 'string' && data.output_text) {
    // Fallback for compatible providers that only expose the flattened form
    message.content = data.output_text;
  }

  if (data.status === 'incomplete') {
    message.incompleteReason = data.incomplete_details?.reason || 'unknown reason';
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

// Process think tags
function processThinkTags(message) {
  if (!message.content) return;

  const thinkRegex = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/gs;
  const matches = [...message.content.matchAll(thinkRegex)];

  if (matches.length > 0) {
    const extracted = matches.map((m) => m[1]).join('\n\n');

    if (extracted.trim()) {
      if (message.reasoning) {
        message.reasoning += '\n\n' + extracted;
      } else {
        message.reasoning = extracted;
      }
    }

    message.content = message.content.replace(thinkRegex, '').trim();
  }
}

// ========================================
// REQUEST BUILDING
// ========================================

function getSystemPromptContent() {
  const prompt = state.config.systemPrompts.find((p) => p.id === state.config.selectedSystemPrompt);
  return prompt?.content || '';
}

// Model selection uses a composite "modelId - providerId" key
function getSelectedModelId() {
  const selected = state.config.selectedModel;
  return selected ? selected.split(' - ')[0] : selected;
}

function getTemperature() {
  const temperature = state.config.temperature;
  // null/'' means "use the model default" - required by reasoning models that
  // reject the parameter outright.
  return temperature == null || temperature === '' ? null : temperature;
}

function getMaxTokens() {
  const value = String(state.config.max_completion_tokens ?? '').trim();
  if (!value) return null;

  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getReasoningEffort() {
  return state.config.reasoning_effort || null;
}

// Conversation history, shared by both APIs.
// The in-flight assistant placeholder is excluded.
function buildHistory() {
  const session = state.sessions[state.currentSessionId];
  if (!session) return [];

  return session.messages
    .filter((m) => m.id !== state.currentStreamingMessage?.id)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content || '' }));
}

function buildMessages() {
  const messages = [];

  // System prompt
  const systemPrompt = getSystemPromptContent();
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  return messages.concat(buildHistory());
}

function buildChatRequestBody() {
  const body = {
    model: getSelectedModelId(),
    messages: buildMessages(),
    stream: state.config.stream !== false
  };

  const temperature = getTemperature();
  if (temperature != null) {
    body.temperature = temperature;
  }

  const maxTokens = getMaxTokens();
  if (maxTokens != null) {
    body.max_completion_tokens = maxTokens;
  }

  const effort = getReasoningEffort();
  if (effort) {
    body.reasoning_effort = effort;
  }

  return body;
}

// https://developers.openai.com/api/reference/responses/overview
function buildResponsesRequestBody() {
  const body = {
    model: getSelectedModelId(),
    input: buildHistory(),
    stream: state.config.stream !== false,
    // Replay local history rather than relying on stored response IDs.
    store: false
  };

  // The system prompt is a first-class field rather than a message
  const systemPrompt = getSystemPromptContent();
  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  const temperature = getTemperature();
  if (temperature != null) {
    body.temperature = temperature;
  }

  const maxTokens = getMaxTokens();
  if (maxTokens != null) {
    body.max_output_tokens = maxTokens;
  }

  const reasoning = {};

  const effort = getReasoningEffort();
  if (effort) {
    reasoning.effort = effort;
  }

  // Summaries are opt-in because not every model supports reasoning options.
  const summary = state.config.reasoning_summary;
  if (summary && summary !== 'off') {
    reasoning.summary = summary;
  }

  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  }

  return body;
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

function cleanupStreaming(messageId) {
  const wasAborted = state.abortController?.signal.aborted;
  const session = state.sessions[state.currentSessionId];
  const message = session?.messages.find((item) => item.id === messageId);

  stopStreamTicker();
  pendingDisplayUpdates.delete(messageId);
  flushMessageDisplays();
  finalizeTiming(messageId);

  if (wasAborted && messageId) {
    const session = state.sessions[state.currentSessionId];
    const message = session?.messages.find((m) => m.id === messageId);

    if (message) {
      const hasContent = message.content?.trim() || message.reasoning?.trim();

      if (hasContent) {
        message.timestamp = new Date().toISOString();
        message.stopped = !message.error;
      } else {
        if (!message.error) {
          session.messages = session.messages.filter((m) => m.id !== messageId);
          messageElementCache.get(messageId)?.remove();
          messageElementCache.delete(messageId);
        }
      }
    }
  }

  state.isStreaming = false;
  state.currentStreamingMessage = null;
  state.abortController = null;

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

function handleApiError(error) {
  const key = getCurrentProvider()?.apiKey;
  const redact = (text) => key ? text.split(key).join('[redacted]') : text;
  const safeError = {
    name: error.name,
    status: error.status,
    message: redact(error.message)
  };
  const message = state.currentStreamingMessage;
  if (message) {
    message.error = getErrorMessage(safeError);
    message.errorDetail = redact(error.details || error.message).slice(0, 2000);
    message.errorAction = isContextLimitError(safeError)
      ? 'new-chat'
      : [400, 401, 403, 404].includes(error.status) ? 'settings' : null;
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
  return /context_length_exceeded|maximum context length|prompt is too long|input token limit/i.test(error.message);
}

function getErrorMessage(error) {
  if (error.name === 'TimeoutError') return error.message;
  if (isContextLimitError(error)) return 'This conversation exceeds the model’s context limit. Start a new chat or shorten your messages before retrying.';
  if (error.status === 400) return 'The provider rejected this request. Check the model, API type and parameters in Settings.';
  if (error.status === 401 || error.status === 403) return 'Access denied. Check your API key and model access in Settings.';
  if (error.status === 404) return 'Endpoint or model not found. Check the Base URL, API type and model in Settings.';
  if (error.status === 429) return 'The provider is limiting requests or your quota is exhausted. Check your quota, or wait before retrying.';
  if (error.status >= 500) return 'The provider is temporarily unavailable. Wait a moment and retry.';
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
