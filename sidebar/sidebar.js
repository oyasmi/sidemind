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
    reasoning_summary: 'auto',
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
  streamTicker: null
};

// ========================================
// SIMPLIFIED RENDERING SYSTEM
// ========================================

// Message element cache
const messageElementCache = new Map();

// Simplified markdown cache with automatic size control
const markdownCache = new Map();
const MAX_MARKDOWN_CACHE_SIZE = 100;

// ----------------------------------------
// Throttled streaming updates
// ----------------------------------------
// A stream can deliver dozens of deltas per second and each repaint re-parses
// the whole message. Coalesce them into one repaint per interval instead.
const STREAM_RENDER_INTERVAL = 60;
const pendingDisplayUpdates = new Set();
let streamRenderTimer = null;

function scheduleMessageDisplay(messageId) {
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
  ids.forEach(id => updateMessageDisplay(id));
}

// Simple cache cleanup
function clearOldCacheEntries() {
  // Clean message cache for non-current sessions
  if (state.currentSessionId && state.sessions[state.currentSessionId]) {
    const currentMessages = new Set(
      state.sessions[state.currentSessionId].messages.map(m => m.id)
    );
    
    for (const [messageId] of messageElementCache) {
      if (!currentMessages.has(messageId)) {
        messageElementCache.delete(messageId);
      }
    }
  }
  
  // Simple size-based markdown cache eviction
  if (markdownCache.size > MAX_MARKDOWN_CACHE_SIZE) {
    const entriesToDelete = markdownCache.size - MAX_MARKDOWN_CACHE_SIZE + 10;
    let deleted = 0;
    for (const [key] of markdownCache) {
      if (deleted >= entriesToDelete) break;
      markdownCache.delete(key);
      deleted++;
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
  dropdownOverlay: null,
  closeBtn: null,
  chatHistoryList: null,
  scrollBottomBtn: null,
  srStatus: null,
  undoBar: null,
  undoText: null,
  undoBtn: null,
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
  elements.dropdownOverlay = document.querySelector('.dropdown-overlay');
  elements.closeBtn = document.querySelector('.close-btn');
  elements.chatHistoryList = document.getElementById('chatHistoryList');
  elements.scrollBottomBtn = document.getElementById('scrollBottomBtn');
  elements.srStatus = document.getElementById('srStatus');
  elements.undoBar = document.getElementById('undoBar');
  elements.undoText = document.getElementById('undoText');
  elements.undoBtn = document.getElementById('undoBtn');
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
  elements.dropdownOverlay.addEventListener('click', closeChatHistory);
  
  elements.messagesList.addEventListener('scroll', handleScroll);
  elements.scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));
  elements.undoBtn.addEventListener('click', applyUndo);

  document.addEventListener('keydown', handleGlobalKeydown);
  
  // Listen for config changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.config) {
      state.config = { ...state.config, ...changes.config.newValue };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
      renderWelcomeMessage();
      applyFontSettings();
      applyTheme();
    }
  });
  
  // Network status monitoring
  window.addEventListener('offline', () => {
    if (state.isStreaming) {
      handleStopGeneration();
      showError('Network connection lost. Please try again.');
    }
  });
}

// Initialize UI
function initializeUI() {
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
        await chrome.storage.sync.set({ config: localResult.config });
        result.config = localResult.config;
      }
    }
    
    if (result.config) {
      state.config = { ...state.config, ...result.config };
      applyFontSettings();
      applyTheme();
    }
    
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
    
    if (!state.currentSessionId) {
      await createNewSession();
    }

  } catch (error) {
    console.error('Storage load error:', error);
    await createNewSession();
  }
}

async function saveToStorage() {
  try {
    await chrome.storage.sync.set({ config: state.config });
    await chrome.storage.local.set({
      sessions: state.sessions,
      currentSessionId: state.currentSessionId,
      drafts: state.drafts
    });
  } catch (error) {
    console.error('Storage save error:', error);
  }
}

// Debounced save
let saveTimeout = null;
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveToStorage(), 1000);
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

  chrome.storage.local.set({ drafts: state.drafts })
    .catch(error => console.error('Draft save error:', error));
}

function restoreDraft() {
  elements.messageInput.value = state.drafts[state.currentSessionId] || '';
  autoResizeTextarea();
}

function clearDraft() {
  delete state.drafts[state.currentSessionId];
  persistDrafts();
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
}

function clearUndo() {
  if (pendingUndo?.timer) clearTimeout(pendingUndo.timer);
  pendingUndo = null;
  elements.undoBar?.classList.add('hidden');
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
  if (!state.isStreaming) return;

  await handleStopGeneration();
  // Give the abort time to propagate through the reader
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function createNewSession() {
  await stopStreamingIfActive();

  const sessionId = Date.now().toString();
  state.sessions[sessionId] = {
    messages: [],
    title: 'New Chat',
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel,
    systemPromptId: state.config.selectedSystemPrompt
  };
  state.currentSessionId = sessionId;
  state.userScrolledUp = false;
  clearUndo();

  saveToStorage();
  renderMessages();
  restoreDraft();
  updateInputState();
}

async function switchSession(sessionId) {
  if (!state.sessions[sessionId]) return;

  await stopStreamingIfActive();

  clearOldCacheEntries();
  state.currentSessionId = sessionId;
  state.userScrolledUp = false;
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
  
  // Clear cache for this session
  if (state.sessions[sessionId].messages) {
    state.sessions[sessionId].messages.forEach(msg => {
      messageElementCache.delete(msg.id);
    });
  }
  
  delete state.sessions[sessionId];
  delete state.drafts[sessionId];

  // Switch to another session or create new
  if (state.currentSessionId === sessionId) {
    const remaining = Object.keys(state.sessions);
    if (remaining.length > 0) {
      const recent = remaining.sort((a, b) =>
        new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp)
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
    saveToStorage();
    renderChatHistory();
  });

  if (!elements.chatHistoryDropdown.classList.contains('hidden')) {
    renderChatHistory();
  }
}

// ========================================
// MESSAGE MANAGEMENT
// ========================================

function addMessage(role, content, reasoning = null, reasoningCollapsed = false) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;
  
  const message = {
    id: Date.now().toString(),
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
    session.title = content.length > 50 ? content.substring(0, 50) + '...' : content;
  }
  
  debouncedSave();
  renderMessages();
}

// ========================================
// UI RENDERING
// ========================================

function renderMessages() {
  const session = state.sessions[state.currentSessionId];
  if (!session || session.messages.length === 0) {
    showWelcomeMessage();
    return;
  }
  
  hideWelcomeMessage();
  
  const fragment = document.createDocumentFragment();
  let lastModel = null;

  session.messages.forEach(message => {
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

    fragment.appendChild(messageElement);
  });
  
  elements.messagesList.innerHTML = '';
  elements.messagesList.appendChild(fragment);
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
  senderName.textContent = MESSAGE_LABELS[message.role] || 'Assistant';
  
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
    content.innerHTML = renderMarkdown(message.content);
    decorateCodeBlocks(content);
  }

  bubble.appendChild(content);

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
  section.className = message.reasoningCollapsed ? 'reasoning-section' : 'reasoning-section expanded';
  
  const header = document.createElement('div');
  header.className = 'reasoning-header';
  
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
    // Once opened or closed by hand, stop auto-folding this one
    message.reasoningTouched = true;
    debouncedSave();
  });

  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.innerHTML = renderMarkdown(message.reasoning, !isStreamingMessage(message.id));
  
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
  indicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span>' +
    '<span class="typing-dot"></span><span class="typing-elapsed"></span>';
  indicator.hidden = !isAwaitingFirstToken(message);
  return indicator;
}

function isStreamingMessage(messageId) {
  return state.currentStreamingMessage?.id === messageId;
}

function isAwaitingFirstToken(message) {
  return isStreamingMessage(message.id) &&
    !message.content?.trim() &&
    !message.reasoning?.trim();
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function reasoningTitle(message) {
  if (message.thinkingMs != null) {
    return `🤔 Thought for ${formatDuration(message.thinkingMs)}`;
  }

  if (isStreamingMessage(message.id) && message.startedAt) {
    return `🤔 Thinking… ${formatDuration(Date.now() - message.startedAt)}`;
  }

  return '🤔 Thought process';
}

// Reasoning is considered finished the moment the first visible token lands
function markStreamProgress(message) {
  if (!message.startedAt || message.thinkingMs != null) return;
  if (!message.content || !message.reasoning) return;

  message.thinkingMs = Date.now() - message.startedAt;

  // Fold the chain of thought away so the answer is not pushed off screen
  if (!message.reasoningTouched) {
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
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;

    const code = pre.querySelector('code');
    const language = highlightCode(code);

    if (language) {
      const label = document.createElement('span');
      label.className = 'code-language';
      label.textContent = language;
      pre.appendChild(label);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-btn';
    button.setAttribute('aria-label', 'Copy code');
    button.innerHTML = '<i class="fas fa-copy"></i>';
    button.addEventListener('click', () => copyCode(pre, button));

    pre.appendChild(button);
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
    button.innerHTML = '<i class="fas fa-check"></i>';

    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = '<i class="fas fa-copy"></i>';
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
  }
}

function createMessageActions(message) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  
  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
  copyBtn.addEventListener('click', () => copyMessage(message, copyBtn));
  
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

  actions.appendChild(copyBtn);
  actions.appendChild(regenBtn);
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
    let text = message.content;
    if (message.role === 'assistant' && message.reasoning) {
      text = `🤔 Thinking:\n${message.reasoning}\n\n${text}`;
    }
    
    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    button.innerHTML = '<i class="fas fa-check"></i>';
    
    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = '<i class="fas fa-copy"></i>';
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
  }
}

async function regenerateMessage(message, button) {
  if (state.isStreaming) return;
  
  const session = state.sessions[state.currentSessionId];
  if (!session) return;
  
  button.classList.add('regenerating');
  button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  
  try {
    const index = session.messages.findIndex(m => m.id === message.id);
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
      const lastUser = session.messages.slice().reverse().find(m => m.role === 'user');
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
    const html = marked.parse(text);

    if (cache && text.length > 20 && markdownCache.size < MAX_MARKDOWN_CACHE_SIZE) {
      markdownCache.set(text, html);
    }

    return html;
  } catch (error) {
    console.error('Markdown error:', error);
    return text;
  }
}

function updateMessageDisplay(messageId) {
  const messageElement = messageElementCache.get(messageId);
  if (!messageElement) return;

  const message = state.sessions[state.currentSessionId]?.messages.find(m => m.id === messageId);
  if (!message) return;

  const streaming = isStreamingMessage(messageId);
  markStreamProgress(message);

  // Update content
  const contentEl = messageElement.querySelector('.message-content');
  if (contentEl) {
    if (message.role === 'user') {
      contentEl.textContent = message.content;
    } else {
      contentEl.innerHTML = renderMarkdown(message.content, !streaming);
      // Decorating mid-stream is wasted work: the next repaint replaces the
      // whole subtree anyway
      if (!streaming) decorateCodeBlocks(contentEl);
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
      if (reasoningContent) {
        reasoningContent.innerHTML = renderMarkdown(message.reasoning, !streaming);

        // Follow the thinking as it is written
        if (streaming && !message.reasoningCollapsed) {
          reasoningContent.scrollTop = reasoningContent.scrollHeight;
        }
      }

      const title = reasoningSection.querySelector('.reasoning-title');
      if (title) title.textContent = reasoningTitle(message);
    }

    reasoningSection.classList.toggle('expanded', !message.reasoningCollapsed);
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

  const hasProviders = state.config.providers.length > 0;
  const hasModel = Boolean(state.config.selectedProvider && state.config.selectedModel);

  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Welcome to SideMind';

  const body = document.createElement('p');
  container.appendChild(heading);
  container.appendChild(body);

  if (!hasProviders) {
    body.textContent = 'No AI provider configured yet. Add one to start chatting.';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'welcome-action';
    action.textContent = 'Add a provider';
    action.addEventListener('click', openOptions);
    container.appendChild(action);
    return;
  }

  body.textContent = hasModel
    ? 'Ask anything, or pick a different model and system prompt above.'
    : 'Choose a model from the selector above to start chatting.';
}

function hideWelcomeMessage() {
  elements.welcomeMessage?.classList.add('hidden');
  elements.messagesList?.classList.remove('hidden');
}

function scrollToBottom(force = false) {
  if (!elements.messagesList) return;

  if (force) {
    state.userScrolledUp = false;
    elements.messagesList.scrollTo({
      top: elements.messagesList.scrollHeight,
      behavior: 'smooth'
    });
  } else if (!state.userScrolledUp) {
    // Instant during streaming - smooth scrolling would fight itself when the
    // target moves on every repaint
    elements.messagesList.scrollTop = elements.messagesList.scrollHeight;
  }

  updateScrollButton();
}

function updateScrollButton() {
  const button = elements.scrollBottomBtn;
  if (!button) return;

  const session = state.sessions[state.currentSessionId];
  const show = state.userScrolledUp && session?.messages.length > 0;

  button.classList.toggle('hidden', !show);
  button.classList.toggle('has-new', show && state.isStreaming);
}

function autoResizeTextarea() {
  const textarea = elements.messageInput;
  if (!textarea) return;
  
  requestAnimationFrame(() => {
    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight + 2, 44), 320);
    textarea.style.height = newHeight + 'px';
  });
}

function updateInputState() {
  const hasConfig = state.config.selectedProvider && state.config.selectedModel;
  const hasMessage = elements.messageInput.value.trim().length > 0;
  const canSend = hasConfig && hasMessage && !state.isStreaming;
  
  elements.sendBtn.disabled = !canSend;
  
  if (state.isStreaming) {
    elements.sendBtn.setAttribute('data-state', 'stop');
    elements.sendBtn.setAttribute('aria-label', 'Stop generation');
    elements.sendBtn.disabled = false;
  } else {
    elements.sendBtn.setAttribute('data-state', 'send');
    elements.sendBtn.setAttribute('aria-label', 'Send message');
  }
}

function applyFontSettings() {
  if (state.config.fontSize) {
    document.documentElement.style.setProperty('--font-size', state.config.fontSize);
  }
  if (state.config.fontFamily) {
    document.documentElement.style.setProperty('--font-family', state.config.fontFamily);
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

  state.config.providers.forEach(provider => {
    const optgroup = document.createElement('optgroup');
    // 非默认接口在分组标题上标注，便于区分同名 provider
    optgroup.label = getApiType(provider) === 'responses'
      ? `${provider.name} · Responses`
      : provider.name;

    provider.models.forEach(model => {
      const option = document.createElement('option');
      // 使用复合键: "modelId - providerId"
      option.value = `${model.id} - ${provider.id}`;
      // UI显示: 只显示模型名称，provider已由optgroup显示
      option.textContent = model.name;

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
  
  state.config.systemPrompts.forEach(prompt => {
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
    debouncedSave();
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
  debouncedSave();
  updateInputState();
  renderWelcomeMessage();
}

function handleSystemPromptChange(event) {
  state.config.selectedSystemPrompt = event.target.value;
  debouncedSave();
}

function handleInputChange() {
  updateInputState();
  autoResizeTextarea();
  saveDraftSoon();
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!elements.sendBtn.disabled) {
      handleSendMessage();
    }
  }
}

// Escape works wherever the focus is: stop generation first, otherwise close
// whatever is open
function handleGlobalKeydown(event) {
  if (event.key !== 'Escape') return;

  if (state.isStreaming) {
    event.preventDefault();
    handleStopGeneration();
    return;
  }

  if (!elements.chatHistoryDropdown.classList.contains('hidden')) {
    event.preventDefault();
    closeChatHistory();
  }
}

function handleScroll() {
  if (!elements.messagesList) return;

  const { scrollTop, scrollHeight, clientHeight } = elements.messagesList;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

  state.userScrolledUp = distanceFromBottom > 50;
  updateScrollButton();
}

async function handleSendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || elements.sendBtn.disabled) return;
  
  state.userScrolledUp = false;
  
  clearUndo();
  addMessage('user', message);

  elements.messageInput.value = '';
  clearDraft();
  autoResizeTextarea();
  updateInputState();
  
  await sendMessageToAPI(message);
}

async function handleStopGeneration() {
  if (!state.isStreaming || !state.abortController) return;
  
  console.log('Stopping generation...');
  
  // Mark as not streaming immediately
  state.isStreaming = false;
  updateInputState();
  
  // Abort the request
  state.abortController.abort();
  
  // Give abort time to propagate
  await new Promise(resolve => setTimeout(resolve, 100));
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
  elements.chatHistoryDropdown.classList.remove('hidden');
  renderChatHistory();
}

function closeChatHistory() {
  elements.chatHistoryDropdown.classList.add('hidden');
}

// `modelUsed` holds the composite "modelId - providerId" key. Matching it
// against a bare model id never succeeded, so every history row fell back to
// "Unknown".
function describeModel(modelUsed) {
  if (!modelUsed) return [];

  const [modelId, providerId] = String(modelUsed).split(' - ');

  const provider = providerId
    ? state.config.providers.find(p => p.id === providerId)
    // Sessions written before the composite key stored a bare model id
    : state.config.providers.find(p => p.models.some(m => m.id === modelId));

  const model = provider?.models.find(m => m.id === modelId);

  return provider && model ? [provider.name, model.name] : [];
}

function renderChatHistory() {
  elements.chatHistoryList.innerHTML = '';
  
  const sessionIds = Object.keys(state.sessions).sort((a, b) => 
    new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp)
  );
  
  if (sessionIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-history-empty';
    empty.textContent = 'No chat history yet';
    empty.style.cssText = 'padding: 20px; text-align: center; color: var(--text-tertiary);';
    elements.chatHistoryList.appendChild(empty);
    return;
  }
  
  sessionIds.forEach(sessionId => {
    const session = state.sessions[sessionId];
    const item = document.createElement('div');
    item.className = 'chat-history-item';
    
    if (sessionId === state.currentSessionId) {
      item.style.backgroundColor = 'var(--accent-light)';
    }
    
    const content = document.createElement('div');
    content.className = 'chat-history-content';
    
    const title = document.createElement('div');
    title.className = 'chat-history-title';
    title.textContent = session.title;
    
    const meta = document.createElement('div');
    meta.className = 'chat-history-meta';
    
    const date = new Date(session.timestamp);
    const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    
    const metaInfo = describeModel(session.modelUsed);
    
    const systemPrompt = state.config.systemPrompts.find(p => p.id === (session.systemPromptId || state.config.selectedSystemPrompt));
    if (systemPrompt) {
      metaInfo.push(systemPrompt.name);
    }
    
    // Built as text nodes: provider, model and prompt names are user-supplied
    const dateSpan = document.createElement('span');
    dateSpan.textContent = dateStr;

    const infoSpan = document.createElement('span');
    infoSpan.textContent = metaInfo.join(' • ') || 'Unknown';

    meta.appendChild(dateSpan);
    meta.appendChild(infoSpan);
    
    content.appendChild(title);
    content.appendChild(meta);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-chat-btn';
    deleteBtn.setAttribute('aria-label', 'Delete chat');
    deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(sessionId);
    });
    
    item.appendChild(content);
    item.appendChild(deleteBtn);
    item.addEventListener('click', () => switchSession(sessionId));
    
    elements.chatHistoryList.appendChild(item);
  });
}

// ========================================
// SIMPLIFIED API COMMUNICATION
// ========================================

async function sendMessageToAPI(_userMessage) {
  const provider = getCurrentProvider();
  if (!provider) {
    showError('No provider configured. Please configure in options.');
    return;
  }
  
  // Stop any existing stream
  if (state.isStreaming) {
    await handleStopGeneration();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Initialize streaming state
  state.userScrolledUp = false;
  state.abortController = new AbortController();
  state.isStreaming = true;
  updateInputState();
  
  // Create assistant message
  const assistantMessage = {
    id: Date.now().toString(),
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoningCollapsed: false,
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
      console.error('API Error:', error);
      handleApiError(error);
    }
  } finally {
    cleanupStreaming(assistantMessage.id);
  }
}

function getCurrentProvider() {
  if (!state.config.selectedProvider) return null;
  return state.config.providers.find(p => p.id === state.config.selectedProvider);
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

  // Make API request
  const response = await makeApiRequest(provider, adapter.endpoint, body, signal);
  if (!response) return; // Aborted

  // Handle streaming or non-streaming
  if (body.stream) {
    await processStream(response, assistantMessage, signal, adapter);
  } else {
    await processNonStream(response, assistantMessage, signal, adapter);
  }

  // Final processing
  pendingDisplayUpdates.delete(assistantMessage.id);
  flushMessageDisplays();
  processThinkTags(assistantMessage);
  updateMessageDisplay(assistantMessage.id);
}

// Simple stream processing
async function processStream(response, message, signal, adapter) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { stream: true });
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining buffer
        if (buffer.trim()) {
          processStreamLine(buffer, message, adapter);
        }
        break;
      }

      // Decode chunk
      const chunk = decoder.decode(value, { stream: true });
      const lines = (buffer + chunk).split('\n');

      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      // Process complete lines
      for (const line of lines) {
        if (signal.aborted) {
          await reader.cancel();
          throw new DOMException('Aborted', 'AbortError');
        }
        processStreamLine(line, message, adapter);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      try { await reader.cancel(); } catch (e) {}
    }
    throw error;
  }
}

// Process single stream line
function processStreamLine(line, message, adapter) {
  line = line.trim();
  // Ignore SSE framing lines (`event:`, `id:`, `retry:`, comments) - both APIs
  // carry everything we need inside the `data:` payload itself.
  if (!line || !line.startsWith('data:')) return;

  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return;

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    // Ignore parse errors, continue streaming
    console.warn('Parse error (ignored):', error.message);
    return;
  }

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
      message.usage = readUsage(parsed.response?.usage);
      return false;

    case 'response.failed': {
      const error = parsed.response?.error;
      throw new Error(`API Error: ${error?.message || 'Response failed'}`);
    }

    case 'response.incomplete':
      console.warn('Response incomplete:', parsed.response?.incomplete_details?.reason || 'unknown reason');
      return false;

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
  if (!msg) return;

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

  (data.output || []).forEach(item => {
    if (item?.type === 'reasoning') {
      (item.summary || []).forEach(part => part?.text && reasoningParts.push(part.text));
      (item.content || []).forEach(part => part?.text && reasoningParts.push(part.text));
    } else if (item?.type === 'message') {
      (item.content || []).forEach(part => {
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
    console.warn('Response incomplete:', data.incomplete_details?.reason || 'unknown reason');
  }
}

// Chat Completions reports prompt/completion tokens, Responses reports
// input/output tokens. Normalise to one shape, or null when absent.
function readUsage(usage) {
  if (!usage) return null;

  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (input == null && output == null) return null;

  const reasoning = usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens ?? null;

  return {
    input: input ?? 0,
    output: output ?? 0,
    total: usage.total_tokens ?? ((input ?? 0) + (output ?? 0)),
    reasoning
  };
}

// Process think tags
function processThinkTags(message) {
  if (!message.content) return;
  
  const thinkRegex = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/gs;
  const matches = [...message.content.matchAll(thinkRegex)];
  
  if (matches.length > 0) {
    const extracted = matches.map(m => m[1]).join('\n\n');
    
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
  const prompt = state.config.systemPrompts.find(p => p.id === state.config.selectedSystemPrompt);
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
  return (temperature == null || temperature === '') ? null : temperature;
}

function getMaxTokens() {
  const value = String(state.config.max_completion_tokens ?? '').trim();
  if (!value) return null;

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
    .filter(m => m.id !== state.currentStreamingMessage?.id)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content || '' }));
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

// https://platform.openai.com/docs/api-reference/responses/create
function buildResponsesRequestBody() {
  const body = {
    model: getSelectedModelId(),
    input: buildHistory(),
    stream: state.config.stream !== false,
    // Stateless by design: full history is replayed on every turn, nothing is
    // retained server-side.
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

  // Reasoning models only emit a visible chain of thought when a summary is
  // requested, so 'auto' is the default.
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
  
  const timeoutId = setTimeout(() => {
    console.warn('Request timeout (360s)');
  }, 360000);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`API Error (${response.status}): ${error.error?.message || response.statusText}`);
    }
    
    if (!response.body) {
      throw new Error('Response body is null');
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return null;
    }
    throw error;
  }
}

function cleanupStreaming(messageId) {
  const wasAborted = state.abortController?.signal.aborted;

  stopStreamTicker();
  pendingDisplayUpdates.delete(messageId);
  flushMessageDisplays();
  finalizeTiming(messageId);

  if (wasAborted && messageId) {
    const session = state.sessions[state.currentSessionId];
    const message = session?.messages.find(m => m.id === messageId);
    
    if (message) {
      const hasContent = message.content?.trim() || message.reasoning?.trim();
      
      if (hasContent) {
        message.timestamp = new Date().toISOString();
      } else {
        session.messages = session.messages.filter(m => m.id !== messageId);
      }
    }
  }
  
  state.isStreaming = false;
  state.currentStreamingMessage = null;
  state.abortController = null;

  announce(wasAborted ? 'Generation stopped.' : 'Response complete.');

  saveToStorage();
  renderMessages();
  // Repaint once more now that the message counts as finished: final markdown
  // goes into the cache, code blocks get their copy buttons, the reasoning
  // header settles on its final duration.
  updateMessageDisplay(messageId);
  updateInputState();
}

function finalizeTiming(messageId) {
  const message = state.sessions[state.currentSessionId]?.messages.find(m => m.id === messageId);
  if (!message?.startedAt) return;

  message.durationMs = Date.now() - message.startedAt;

  // A reply that was nothing but reasoning still deserves a duration
  if (message.thinkingMs == null && message.reasoning?.trim()) {
    message.thinkingMs = message.durationMs;
    if (!message.reasoningTouched) {
      message.reasoningCollapsed = true;
    }
  }
}

function handleApiError(error) {
  // Remove failed message
  if (state.currentStreamingMessage) {
    const session = state.sessions[state.currentSessionId];
    session.messages = session.messages.filter(m => m.id !== state.currentStreamingMessage.id);
    renderMessages();
  }
  
  // Show error
  const message = getErrorMessage(error);
  showError(message);
}

const ERROR_HANDLERS = [
  { patterns: ['unsupported parameter', 'unsupported value', 'unknown parameter', 'unrecognized request argument'],
    message: 'The provider rejected a request parameter. Check the API type, temperature and reasoning settings in options.' },
  { patterns: ['401', 'authentication'], message: 'Authentication failed. Check your API key.' },
  { patterns: ['404'], message: 'Model not found. Check your configuration.' },
  { patterns: ['429', 'rate limit'], message: 'Rate limit exceeded. Try again later.' },
  { patterns: ['cors', 'blocked'], message: () => {
    const provider = getCurrentProvider();
    return `CORS error. Need permission to access ${provider?.baseUrl}. Reconfigure in options.`;
  }},
  { patterns: ['network', 'fetch'], message: 'Network error. Check your connection.' }
];

function getErrorMessage(error) {
  const msg = error.message.toLowerCase();

  for (const { patterns, message } of ERROR_HANDLERS) {
    if (patterns.some(pattern => msg.includes(pattern))) {
      return typeof message === 'function' ? message() : message;
    }
  }

  // Surface the provider's own message - far more useful than a generic string
  return error.message.startsWith('API Error') ? error.message : 'An error occurred. Please try again.';
}

function showError(message) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;
  
  const errorMsg = {
    id: Date.now().toString(),
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