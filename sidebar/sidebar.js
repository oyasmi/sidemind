// SideMind Chrome Extension - Sidebar Script
// Main application logic for the sidebar chat interface

// ========================================
// GLOBAL STATE MANAGEMENT
// ========================================

const state = {
  currentSessionId: null,
  sessions: {},
  config: {
    providers: [],
    selectedProvider: null,
    selectedModel: null,
    selectedSystemPrompt: 'default',
    temperature: 0.7,
    max_completion_tokens: '',
    stream: true,
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
  abortController: null
};

// ========================================
// SIMPLIFIED RENDERING SYSTEM
// ========================================

// Message element cache
const messageElementCache = new Map();

// Simplified markdown cache with automatic size control
const markdownCache = new Map();
const MAX_MARKDOWN_CACHE_SIZE = 100;

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
  
  // Simple LRU for markdown cache
  if (markdownCache.size > MAX_MARKDOWN_CACHE_SIZE) {
    const entries = Array.from(markdownCache.entries());
    markdownCache.clear();
    entries.slice(-Math.floor(MAX_MARKDOWN_CACHE_SIZE * 0.8)).forEach(([k, v]) => {
      markdownCache.set(k, v);
    });
  }
}

// Periodic cleanup
setInterval(clearOldCacheEntries, 5 * 60 * 1000); // Every 5 minutes

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
  
  // Listen for config changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.config) {
      state.config = { ...state.config, ...changes.config.newValue };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
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
    
    const localResult = await chrome.storage.local.get(['sessions', 'currentSessionId']);
    
    if (localResult.sessions) {
      state.sessions = localResult.sessions;
    }
    
    if (localResult.currentSessionId) {
      state.currentSessionId = localResult.currentSessionId;
    }
    
    if (!state.currentSessionId) {
      createNewSession();
    }
    
  } catch (error) {
    console.error('Storage load error:', error);
    createNewSession();
  }
}

async function saveToStorage() {
  try {
    await chrome.storage.sync.set({ config: state.config });
    await chrome.storage.local.set({
      sessions: state.sessions,
      currentSessionId: state.currentSessionId
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

// ========================================
// SESSION MANAGEMENT
// ========================================

function createNewSession() {
  const sessionId = Date.now().toString();
  state.sessions[sessionId] = {
    messages: [],
    title: 'New Chat',
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel,
    systemPromptId: state.config.selectedSystemPrompt
  };
  state.currentSessionId = sessionId;
  
  saveToStorage();
  renderMessages();
  updateInputState();
}

async function switchSession(sessionId) {
  if (!state.sessions[sessionId]) return;
  
  // Stop current streaming if any
  if (state.isStreaming) {
    await handleStopGeneration();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  clearOldCacheEntries();
  state.currentSessionId = sessionId;
  saveToStorage();
  renderMessages();
  updateInputState();
  closeChatHistory();
}

function deleteSession(sessionId) {
  if (!state.sessions[sessionId]) return;
  
  // Clear cache for this session
  if (state.sessions[sessionId].messages) {
    state.sessions[sessionId].messages.forEach(msg => {
      messageElementCache.delete(msg.id);
    });
  }
  
  delete state.sessions[sessionId];
  
  // Switch to another session or create new
  if (state.currentSessionId === sessionId) {
    const remaining = Object.keys(state.sessions);
    if (remaining.length > 0) {
      const recent = remaining.sort((a, b) => 
        new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp)
      )[0];
      state.currentSessionId = recent;
    } else {
      createNewSession();
    }
  }
  
  saveToStorage();
  renderMessages();
  updateInputState();
  
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
  
  session.messages.forEach(message => {
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

function createMessageElement(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${message.role}`;
  messageDiv.setAttribute('data-message-id', message.id);
  
  // Header
  const header = document.createElement('div');
  header.className = 'message-header';
  
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.innerHTML = `<i class="fas fa-${message.role === 'user' ? 'user' : 'robot'}"></i>`;
  
  const senderName = document.createElement('span');
  senderName.className = 'sender-name';
  senderName.textContent = message.role === 'user' ? 'You' : 'Assistant';
  
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
  }
  
  bubble.appendChild(content);
  
  // Actions
  const actions = createMessageActions(message);
  
  wrapper.appendChild(bubble);
  wrapper.appendChild(actions);
  messageDiv.appendChild(header);
  messageDiv.appendChild(wrapper);
  
  // Cache tracking
  messageDiv.lastContent = message.content || '';
  messageDiv.lastReasoning = message.reasoning || '';
  
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
  title.textContent = '🤔 Thinking...';
  
  header.appendChild(icon);
  header.appendChild(title);
  header.addEventListener('click', () => {
    section.classList.toggle('expanded');
    message.reasoningCollapsed = !section.classList.contains('expanded');
    debouncedSave();
  });
  
  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.innerHTML = renderMarkdown(message.reasoning);
  
  section.appendChild(header);
  section.appendChild(content);
  
  return section;
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
  regenBtn.setAttribute('aria-label', 'Regenerate response');
  regenBtn.innerHTML = '<i class="fas fa-redo"></i>';
  regenBtn.addEventListener('click', () => regenerateMessage(message, regenBtn));
  
  // Time
  const time = document.createElement('span');
  time.className = 'time-display';
  time.textContent = formatTime(message.timestamp);
  
  actions.appendChild(copyBtn);
  actions.appendChild(regenBtn);
  actions.appendChild(time);
  
  return actions;
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
    
    const keepMessages = message.role === 'user' 
      ? session.messages.slice(0, index + 1)
      : session.messages.slice(0, index);
    
    session.messages = keepMessages;
    session.timestamp = new Date().toISOString();
    
    saveToStorage();
    renderMessages();
    
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

function renderMarkdown(text) {
  if (!text) return '';
  
  // Check cache
  if (markdownCache.has(text)) {
    return markdownCache.get(text);
  }
  
  try {
    const html = marked.parse(text);
    
    // Cache if reasonable size
    if (text.length > 20 && markdownCache.size < MAX_MARKDOWN_CACHE_SIZE) {
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
  
  // Update content if changed
  const contentEl = messageElement.querySelector('.message-content');
  if (contentEl && messageElement.lastContent !== message.content) {
    if (message.role === 'user') {
      contentEl.textContent = message.content;
    } else {
      contentEl.innerHTML = renderMarkdown(message.content);
    }
    messageElement.lastContent = message.content;
    scrollToBottom();
  }
  
  // Update reasoning if changed
  if (messageElement.lastReasoning !== (message.reasoning || '')) {
    const bubble = messageElement.querySelector('.message-bubble');
    let reasoningSection = messageElement.querySelector('.reasoning-section');
    
    if (message.reasoning && message.reasoning.trim()) {
      if (reasoningSection) {
        const reasoningContent = reasoningSection.querySelector('.reasoning-content');
        if (reasoningContent) {
          reasoningContent.innerHTML = renderMarkdown(message.reasoning);
        }
      } else {
        const newSection = createReasoningSection(message);
        const contentEl = bubble.querySelector('.message-content');
        bubble.insertBefore(newSection, contentEl);
      }
    } else if (reasoningSection) {
      reasoningSection.remove();
    }
    
    messageElement.lastReasoning = message.reasoning || '';
    scrollToBottom();
  }
}

// ========================================
// UI HELPERS
// ========================================

function showWelcomeMessage() {
  elements.welcomeMessage?.classList.remove('hidden');
  elements.messagesList?.classList.add('hidden');
}

function hideWelcomeMessage() {
  elements.welcomeMessage?.classList.add('hidden');
  elements.messagesList?.classList.remove('hidden');
}

function scrollToBottom() {
  if (!state.userScrolledUp && elements.messagesList) {
    elements.messagesList.scrollTop = elements.messagesList.scrollHeight;
  }
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
    optgroup.label = provider.name;

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
}

function handleSystemPromptChange(event) {
  state.config.selectedSystemPrompt = event.target.value;
  debouncedSave();
}

function handleInputChange() {
  updateInputState();
  autoResizeTextarea();
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!elements.sendBtn.disabled) {
      handleSendMessage();
    }
  }
}

function handleScroll() {
  if (!elements.messagesList) return;
  
  const { scrollTop, scrollHeight, clientHeight } = elements.messagesList;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  
  state.userScrolledUp = distanceFromBottom > 50;
}

async function handleSendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || elements.sendBtn.disabled) return;
  
  state.userScrolledUp = false;
  
  addMessage('user', message);
  
  elements.messageInput.value = '';
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
    
    let metaInfo = [];
    
    if (session.modelUsed) {
      for (const provider of state.config.providers) {
        const model = provider.models.find(m => m.id === session.modelUsed);
        if (model) {
          metaInfo.push(provider.name, model.name);
          break;
        }
      }
    }
    
    const systemPrompt = state.config.systemPrompts.find(p => p.id === (session.systemPromptId || state.config.selectedSystemPrompt));
    if (systemPrompt) {
      metaInfo.push(systemPrompt.name);
    }
    
    meta.innerHTML = `<span>${dateStr}</span><span>${metaInfo.join(' • ') || 'Unknown'}</span>`;
    
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
    timestamp: new Date().toISOString()
  };
  
  state.sessions[state.currentSessionId].messages.push(assistantMessage);
  state.currentStreamingMessage = assistantMessage;
  renderMessages();
  
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

// SIMPLIFIED STREAMING - Core streaming logic
async function streamResponse(provider, assistantMessage, signal) {
  const messages = buildMessages();
  const body = buildRequestBody(messages);
  
  // Make API request
  const response = await makeApiRequest(provider, body, signal);
  if (!response) return; // Aborted
  
  // Handle streaming or non-streaming
  if (body.stream) {
    await processStream(response, assistantMessage, signal);
  } else {
    await processNonStream(response, assistantMessage, signal);
  }
  
  // Final processing
  processThinkTags(assistantMessage);
  updateMessageDisplay(assistantMessage.id);
}

// Simple stream processing
async function processStream(response, message, signal) {
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
          processStreamLine(buffer, message);
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
        processStreamLine(line, message);
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
function processStreamLine(line, message) {
  line = line.trim();
  if (!line || !line.startsWith('data:')) return;
  
  const data = line.slice(5).trim();
  if (data === '[DONE]') return;
  
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;
    
    let updated = false;
    
    if (delta.reasoning_content) {
      message.reasoning = (message.reasoning || '') + delta.reasoning_content;
      updated = true;
    }
    
    if (delta.content) {
      message.content = (message.content || '') + delta.content;
      updated = true;
    }
    
    if (updated) {
      updateMessageDisplay(message.id);
    }
  } catch (error) {
    // Ignore parse errors, continue streaming
    console.warn('Parse error (ignored):', error.message);
  }
}

// Process non-streaming response
async function processNonStream(response, message, signal) {
  if (signal.aborted) return;
  
  const data = await response.json();
  if (signal.aborted) return;
  
  const choice = data.choices?.[0];
  if (!choice?.message) return;
  
  const msg = choice.message;
  
  if (msg.reasoning_content) {
    message.reasoning = msg.reasoning_content;
  }
  
  if (msg.content) {
    message.content = msg.content;
  }
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

function buildMessages() {
  const session = state.sessions[state.currentSessionId];
  const messages = [];
  
  // System prompt
  const systemPrompt = state.config.systemPrompts.find(p => p.id === state.config.selectedSystemPrompt);
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt.content });
  }
  
  // History (excluding current streaming message)
  session.messages
    .filter(m => m.id !== state.currentStreamingMessage?.id)
    .forEach(m => {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    });
  
  return messages;
}

function buildRequestBody(messages) {
  const body = {
    // 从复合键中提取实际的model ID
    model: state.config.selectedModel ? state.config.selectedModel.split(' - ')[0] : state.config.selectedModel,
    messages: messages,
    stream: state.config.stream !== false
  };

  if (state.config.temperature != null && state.config.temperature !== '') {
    body.temperature = state.config.temperature;
  }

  if (state.config.max_completion_tokens && state.config.max_completion_tokens.trim()) {
    body.max_completion_tokens = parseInt(state.config.max_completion_tokens);
  }

  return body;
}

async function makeApiRequest(provider, body, signal) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  
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
  
  saveToStorage();
  renderMessages();
  updateInputState();
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

  return 'An error occurred. Please try again.';
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
  renderMessages();
  saveToStorage();
}

console.log('SideMind loaded');