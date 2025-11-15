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
    max_completion_tokens: '', // API standard naming
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
  chatHistoryList: null
};

// ========================================
// APPLICATION INITIALIZATION
// ========================================

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  console.log('SideMind initializing...');

  // Cache DOM elements
  cacheElements();

  // Load configuration and sessions
  await loadFromStorage();

  // Setup event listeners
  setupEventListeners();

  // Initialize UI
  initializeUI();

  // Listen for window focus to refresh config if needed
  window.addEventListener('focus', async () => {
    console.log('Window gained focus, checking for config updates...');
    const oldConfig = JSON.stringify(state.config);
    await loadFromStorage();
    const newConfig = JSON.stringify(state.config);

    if (oldConfig !== newConfig) {
      console.log('Configuration changed, refreshing UI...');
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
    }
  });

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
  // Model and system prompt selection
  elements.modelSelector.addEventListener('change', handleModelChange);
  elements.systemPromptSelector.addEventListener('change', handleSystemPromptChange);

  // Chat controls
  elements.newChatBtn.addEventListener('click', createNewSession);
  elements.sendBtn.addEventListener('click', handleSendOrStop);
  elements.optionsBtn.addEventListener('click', openOptions);

  // Input handling
  elements.messageInput.addEventListener('input', handleInputChange);
  elements.messageInput.addEventListener('keydown', handleInputKeydown);

  // Chat history
  elements.chatHistoryBtn.addEventListener('click', openChatHistory);
  elements.closeBtn.addEventListener('click', closeChatHistory);
  elements.dropdownOverlay.addEventListener('click', closeChatHistory);

  // Auto-resize textarea
  elements.messageInput.addEventListener('input', autoResizeTextarea);

  // Scroll behavior monitoring
  elements.messagesList.addEventListener('scroll', handleScroll);

  // Listen for configuration changes from options page
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.config) {
      console.log('Configuration changed in options page, updating...');
      state.config = { ...state.config, ...changes.config.newValue };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
      applyFontSettings(); // Apply font settings after config update
      applyTheme(); // Apply theme after config update
      console.log('Updated configuration from sync storage:', state.config);
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

// Load configuration and sessions from Chrome storage
async function loadFromStorage() {
  try {
    // Try to load from sync storage first (where options now saves)
    let result = await chrome.storage.sync.get(['config']);

    // If no config in sync storage, try to migrate from local storage
    if (!result.config) {
      const localResult = await chrome.storage.local.get(['config']);
      if (localResult.config) {
        // Migrate config to sync storage
        await chrome.storage.sync.set({ config: localResult.config });
        result = localResult;
        console.log('Migrated config from local to sync storage');
      }
    }

    if (result.config) {
      state.config = { ...state.config, ...result.config };
      console.log('Loaded config from sync storage:', state.config);
      applyFontSettings(); // Apply font settings after loading config
      applyTheme(); // Apply theme after loading config
    }

    // Sessions and current session ID remain in local storage
    const localResult = await chrome.storage.local.get(['sessions', 'currentSessionId']);

    if (localResult.sessions) {
      state.sessions = localResult.sessions;
    }

    if (localResult.currentSessionId) {
      state.currentSessionId = localResult.currentSessionId;
    }

    // If no current session, create one
    if (!state.currentSessionId) {
      createNewSession();
    }

    console.log('Loaded from storage:', {
      config: state.config,
      sessionsCount: Object.keys(state.sessions).length,
      currentSessionId: state.currentSessionId
    });

  } catch (error) {
    logError(error, 'Storage Load');
    createNewSession();
  }
}

// Save configuration and sessions to Chrome storage
async function saveToStorage() {
  try {
    // Save config to sync storage
    await chrome.storage.sync.set({
      config: state.config
    });

    // Save sessions and current session ID to local storage
    await chrome.storage.local.set({
      sessions: state.sessions,
      currentSessionId: state.currentSessionId
    });

    console.log('Saved to storage (config: sync, sessions: local)');
  } catch (error) {
    logError(error, 'Storage Save');
  }
}

// ========================================
// SESSION MANAGEMENT
// ========================================

// Create a new chat session
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

  console.log('Created new session:', sessionId);
}

// Switch to a different chat session
function switchSession(sessionId) {
  if (state.sessions[sessionId]) {
    state.currentSessionId = sessionId;
    saveToStorage();
    renderMessages();
    updateInputState();
    closeChatHistory();

    console.log('Switched to session:', sessionId);
  }
}

// Delete a chat session
function deleteSession(sessionId) {
  if (!state.sessions[sessionId]) {
    return;
  }

  // Delete the session directly without confirmation
  delete state.sessions[sessionId];

  // If deleted session was the current session, create a new one
  if (state.currentSessionId === sessionId) {
    const remainingSessions = Object.keys(state.sessions);
    if (remainingSessions.length > 0) {
      // Switch to the most recent session
      const recentSessionId = remainingSessions.sort((a, b) => {
        return new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp);
      })[0];
      state.currentSessionId = recentSessionId;
    } else {
      // No sessions left, create a new one
      createNewSession();
    }
  }

  // Save and update UI
  saveToStorage();
  renderMessages();
  updateInputState();

  // Refresh chat history if it's open
  if (!elements.chatHistoryDropdown.classList.contains('hidden')) {
    renderChatHistory();
  }

  console.log('Deleted session:', sessionId);
}

// ========================================
// MESSAGE MANAGEMENT
// ========================================

// Add a new message to the current session
function addMessage(role, content, reasoning = null) {
  const sessionId = state.currentSessionId;
  const session = state.sessions[sessionId];
  if (!session) return;

  const message = {
    id: Date.now().toString(),
    role,
    content,
    reasoning,
    timestamp: new Date().toISOString()
  };

  session.messages.push(message);

  // Prepare session updates
  const sessionUpdates = {
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel,
    systemPromptId: state.config.selectedSystemPrompt
  };

  // Auto-generate session title from first user message
  if (role === 'user' && session.messages.length === 1) {
    sessionUpdates.title = content.length > 50 ? content.substring(0, 50) + '...' : content;
  }

  updateSession(sessionId, sessionUpdates);
  renderMessages();
}

// ========================================
// UI RENDERING FUNCTIONS
// ========================================

// Render all messages in the current session
function renderMessages() {
  const session = state.sessions[state.currentSessionId];
  if (!session || session.messages.length === 0) {
    showWelcomeMessage();
    return;
  }

  hideWelcomeMessage();
  elements.messagesList.innerHTML = '';

  session.messages.forEach(message => {
    const messageElement = createMessageElement(message);
    elements.messagesList.appendChild(messageElement);
  });

  scrollToBottom();
}

// Create a DOM element for a single message
function createMessageElement(message) {
  const messageDiv = createElement('div', `message ${message.role}`);
  messageDiv.setAttribute('data-message-id', message.id);

  // Create message header with avatar and sender name
  const messageHeader = createElement('div', 'message-header');

  // Create avatar with appropriate icon
  const avatar = createElement('div', 'message-avatar');
  const avatarIcon = message.role === 'user' ? 'fas fa-user' : 'fas fa-robot';
  avatar.innerHTML = createIcon(avatarIcon);

  // Create sender name
  const senderName = createElement('span', 'sender-name');
  senderName.textContent = message.role === 'user' ? 'You' : 'Assistant';

  // Assemble message header
  messageHeader.appendChild(avatar);
  messageHeader.appendChild(senderName);

  // Create message wrapper to contain bubble and actions
  const messageWrapper = createElement('div', 'message-wrapper');
  const bubble = createElement('div', 'message-bubble');
  const content = createElement('div', 'message-content');

  // User messages: render as plain text to preserve line breaks
  // Assistant messages: render as markdown
  if (message.role === 'user') {
    content.textContent = message.content;
  } else {
    content.innerHTML = renderMarkdown(message.content);
  }

  // Add reasoning section first (before content) if exists
  if (message.reasoning && message.reasoning.trim()) {
    const reasoningSection = createReasoningSection(message.reasoning);
    bubble.appendChild(reasoningSection);
  }

  // Add content after reasoning
  bubble.appendChild(content);

  // Create message actions bar
  const actionsBar = createMessageActions(message);

  // Assemble message wrapper with bubble and actions
  messageWrapper.appendChild(bubble);
  messageWrapper.appendChild(actionsBar);

  // Assemble message with header and wrapper
  messageDiv.appendChild(messageHeader);
  messageDiv.appendChild(messageWrapper);

  return messageDiv;
}

function createMessageActions(message) {
  const actionsBar = createElement('div', 'message-actions');

  // Create copy button
  const copyBtn = createButton('copy-btn', 'Copy message', createIcon('fas fa-copy'));
  copyBtn.addEventListener('click', async () => {
    await copyMessageContent(message, copyBtn);
  });

  // Create regenerate button
  const regenerateBtn = createButton('regenerate-btn', 'Regenerate response', createIcon('fas fa-redo'));
  regenerateBtn.addEventListener('click', async () => {
    await regenerateFromMessage(message, regenerateBtn);
  });

  // Create time display
  const timeDisplay = createElement('span', 'time-display');
  timeDisplay.textContent = formatMessageTime(message.timestamp);

  // Assemble actions bar
  actionsBar.appendChild(copyBtn);
  actionsBar.appendChild(regenerateBtn);
  actionsBar.appendChild(timeDisplay);

  return actionsBar;
}

function createReasoningSection(reasoning) {
  const section = document.createElement('div');
  section.className = 'reasoning-section expanded'; // Start expanded for better UX during streaming

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
  });

  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.innerHTML = renderMarkdown(reasoning);

  section.appendChild(header);
  section.appendChild(content);

  return section;
}

// Copy Message Content
async function copyMessageContent(message, copyBtn) {
  try {
    // For assistant messages, copy the original markdown content
    // For user messages, copy the raw content
    let textToCopy = message.content;

    // If it's an assistant message with reasoning, include reasoning
    if (message.role === 'assistant' && message.reasoning && message.reasoning.trim()) {
      textToCopy = `🤔 Thinking:\n${message.reasoning}\n\n${message.content}`;
    }

    await navigator.clipboard.writeText(textToCopy);

    // Show copied state
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = createIcon('fas fa-check');

    // Reset after 2 seconds
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = createIcon('fas fa-copy');
    }, 2000);

  } catch (error) {
    logError(error, 'Copy Message', { messageId: message.id });
    // Show error state briefly
    copyBtn.innerHTML = createIcon('fas fa-exclamation');
    setTimeout(() => {
      copyBtn.innerHTML = createIcon('fas fa-copy');
    }, 1000);
  }
}

// Regenerate Response from Message
async function regenerateFromMessage(message, regenerateBtn) {
  if (state.isStreaming) {
    console.log('Cannot regenerate while streaming');
    return;
  }

  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  // Show regenerating state
  regenerateBtn.classList.add('regenerating');
  regenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    // Find message index
    const messageIndex = session.messages.findIndex(m => m.id === message.id);
    if (messageIndex === -1) {
      console.error('Message not found');
      return;
    }

    // Remove messages based on role
    let messagesToKeep;
    if (message.role === 'user') {
      // For user messages, keep messages up to and including this message
      messagesToKeep = session.messages.slice(0, messageIndex + 1);
    } else {
      // For assistant messages, keep messages before this message
      messagesToKeep = session.messages.slice(0, messageIndex);
    }

    // Update session messages
    session.messages = messagesToKeep;
    session.timestamp = new Date().toISOString();

    // Save to storage and render
    saveToStorage();
    renderMessages();

    // If it's a user message, send API request
    if (message.role === 'user') {
      await sendMessageToAPI(message.content);
    } else {
      // If it's an assistant message, find the last user message and resend
      const lastUserMessage = session.messages
        .slice()
        .reverse()
        .find(m => m.role === 'user');

      if (lastUserMessage) {
        await sendMessageToAPI(lastUserMessage.content);
      } else {
        console.error('No user message found to regenerate');
      }
    }

  } catch (error) {
    console.error('Error regenerating response:', error);
    showError('Failed to regenerate response. Please try again.');
  } finally {
    // Reset button state
    regenerateBtn.classList.remove('regenerating');
    regenerateBtn.innerHTML = '<i class="fas fa-redo"></i>';
  }
}

// Format Message Time
function formatMessageTime(timestamp) {
  if (!timestamp) return '';

  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Markdown Rendering
function renderMarkdown(text) {
  try {
    return marked.parse(text);
  } catch (error) {
    console.error('Markdown parsing error:', error);
    return text;
  }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

// DOM Creation Utilities
function createElement(tag, className, innerHTML = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (innerHTML) element.innerHTML = innerHTML;
  return element;
}

// Button Creation Utilities
function createButton(className, ariaLabel, iconHTML = null) {
  const button = createElement('button', className);
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (iconHTML) button.innerHTML = iconHTML;
  return button;
}

// Icon Utilities
function createIcon(iconClass) {
  return `<i class="${iconClass}"></i>`;
}

// Error Handling Utilities
function handleAsyncError(error, context = 'Operation') {
  console.error(`${context} failed:`, error);
  const errorMessage = error.name === 'AbortError' ?
    'Operation was cancelled' :
    `${context} failed. Please try again.`;
  return errorMessage;
}

// Enhanced error handling with specific error types
function getApiErrorMessage(error) {
  const message = error.message.toLowerCase();

  if (message.includes('401') || message.includes('authentication')) {
    return 'Authentication failed. Please check your API key.';
  }
  if (message.includes('404') || message.includes('not found')) {
    return 'Model or endpoint not found. Please check your configuration.';
  }
  if (message.includes('429') || message.includes('rate limit')) {
    return 'Rate limit exceeded. Please try again later.';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'Network error. Please check your connection.';
  }

  return 'An error occurred while processing your request.';
}

// Unified error logging
function logError(error, context, additionalInfo = {}) {
  const errorInfo = {
    context,
    message: error.message,
    name: error.name,
    timestamp: new Date().toISOString(),
    ...additionalInfo
  };
  console.error(`[${context}] Error:`, errorInfo);
  return errorInfo;
}

// Storage Validation Utilities
function validateConfig(config) {
  return (
    typeof config === 'object' &&
    Array.isArray(config.providers) &&
    Array.isArray(config.systemPrompts) &&
    typeof config.temperature === 'number' &&
    typeof config.max_completion_tokens === 'string' &&
    typeof config.stream === 'boolean' &&
    (!config.theme || ['light', 'dark', 'system'].includes(config.theme))
  );
}

// State Management Utilities
function updateConfig(updates, immediateSave = true) {
  Object.assign(state.config, updates);
  if (immediateSave) {
    debouncedSave();
  }
}

function updateSession(sessionId, updates, immediateSave = true) {
  if (!state.sessions[sessionId]) return;

  Object.assign(state.sessions[sessionId], updates);
  state.sessions[sessionId].timestamp = new Date().toISOString();

  if (immediateSave) {
    debouncedSave();
  }
}

// Debounced save to prevent excessive storage operations
let saveTimeout = null;
function debouncedSave(delay = 2000) {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveToStorage();
  }, delay);
}

// Immediate save for important operations
function immediateSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  saveToStorage();
}

// ========================================
// UI HELPER FUNCTIONS
// ========================================

function showWelcomeMessage() {
  if (elements.welcomeMessage) {
    elements.welcomeMessage.classList.remove('hidden');
  }
  if (elements.messagesList) {
    elements.messagesList.classList.add('hidden');
  }
}

function hideWelcomeMessage() {
  if (elements.welcomeMessage) {
    elements.welcomeMessage.classList.add('hidden');
  }
  if (elements.messagesList) {
    elements.messagesList.classList.remove('hidden');
  }
}

function scrollToBottom() {
  if (elements.messagesList && !state.userScrolledUp) {
    elements.messagesList.scrollTop = elements.messagesList.scrollHeight;
  }
}

function autoResizeTextarea() {
  const textarea = elements.messageInput;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function updateInputState() {
  const hasConfig = state.config.selectedProvider && state.config.selectedModel;
  const hasMessage = elements.messageInput.value.trim().length > 0;
  const canSend = hasConfig && hasMessage && !state.isStreaming;

  // Update button disabled state
  elements.sendBtn.disabled = !canSend;

  // Update button appearance and behavior based on streaming state
  if (state.isStreaming) {
    // Show loading button (clicking will stop generation)
    elements.sendBtn.setAttribute('data-state', 'stop');
    elements.sendBtn.setAttribute('aria-label', 'Click to stop generation');
    elements.sendBtn.disabled = false; // Always enable stop button
  } else {
    // Show send button
    elements.sendBtn.setAttribute('data-state', 'send');
    elements.sendBtn.setAttribute('aria-label', 'Send Message');
  }
}

function applyFontSettings() {
  if (state.config.fontSize) {
    document.documentElement.style.setProperty('--main-font-size', state.config.fontSize);
  }
  if (state.config.fontFamily) {
    document.documentElement.style.setProperty('--main-font-family', state.config.fontFamily);
  }
}

function applyTheme() {
  const theme = state.config.theme || 'light';
  const html = document.documentElement;

  // Remove existing theme classes
  html.classList.remove('light-theme', 'dark-theme');

  // Apply the selected theme
  if (theme === 'light') {
    html.classList.add('light-theme');
  } else if (theme === 'dark') {
    html.classList.add('dark-theme');
  }
  // If 'system', don't add any class - let the system preference media query handle it

  console.log(`Applied theme: ${theme}`);
}

// UI Update Functions
function updateModelSelector() {
  elements.modelSelector.innerHTML = '<option value="">Select Model...</option>';

  state.config.providers.forEach(provider => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = provider.name;

    provider.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;

      if (state.config.selectedModel === model.id) {
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
  const selectedModel = event.target.value;

  // Find the provider for this model
  let selectedProvider = null;
  for (const provider of state.config.providers) {
    const model = provider.models.find(m => m.id === selectedModel);
    if (model) {
      selectedProvider = provider.id;
      break;
    }
  }

  // Update config with both model and provider
  updateConfig({
    selectedModel,
    selectedProvider
  });

  updateInputState();
}

function handleSystemPromptChange(event) {
  updateConfig({
    selectedSystemPrompt: event.target.value
  });
}

function handleInputChange() {
  updateInputState();
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!elements.sendBtn.disabled) {
      handleSendMessage();
    }
  }
}

function handleScroll() {
  if (!elements.messagesList) return;

  const { scrollTop, scrollHeight, clientHeight } = elements.messagesList;
  const threshold = 50; // pixels from bottom to consider "at bottom"

  // Check if user is scrolled up (not at bottom)
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  state.userScrolledUp = distanceFromBottom > threshold;

  // If user scrolls back to bottom, reset the flag
  if (distanceFromBottom <= threshold && state.userScrolledUp) {
    state.userScrolledUp = false;
  }
}

async function handleSendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || elements.sendBtn.disabled) {
    return;
  }

  // Reset scroll state when user sends a new message
  state.userScrolledUp = false;

  // Add user message
  addMessage('user', message);

  // Clear input
  elements.messageInput.value = '';
  autoResizeTextarea();
  updateInputState();

  // Send API request
  await sendMessageToAPI(message);
}

// Handle Stop Generation
async function handleStopGeneration() {
  if (!state.isStreaming || !state.abortController) {
    console.log('No active streaming to stop');
    return;
  }

  console.log('Stopping generation...');

  try {
    // Abort the fetch request
    state.abortController.abort();

    console.log('Generation stopped by user');

  } catch (error) {
    // Silently ignore abort errors since they're expected
    if (error.name === 'AbortError') {
      console.log('Abort signal sent successfully');
    } else {
      console.error('Error stopping generation:', error);
    }
  }
}

// Handle Send or Stop button click
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

// Chat History Functions
function openChatHistory() {
  elements.chatHistoryDropdown.classList.remove('hidden');
  renderChatHistory();
}

function closeChatHistory() {
  elements.chatHistoryDropdown.classList.add('hidden');
}

function renderChatHistory() {
  elements.chatHistoryList.innerHTML = '';

  const sessionIds = Object.keys(state.sessions).sort((a, b) => {
    return new Date(state.sessions[b].timestamp) - new Date(state.sessions[a].timestamp);
  });

  if (sessionIds.length === 0) {
    const emptyMessage = document.createElement('div');
    emptyMessage.className = 'chat-history-empty';
    emptyMessage.textContent = 'No chat history yet';
    emptyMessage.style.cssText = 'padding: 20px; text-align: center; color: var(--text-tertiary); font-size: 13px;';
    elements.chatHistoryList.appendChild(emptyMessage);
    return;
  }

  sessionIds.forEach(sessionId => {
    const session = state.sessions[sessionId];
    const item = document.createElement('div');
    item.className = 'chat-history-item';

    if (sessionId === state.currentSessionId) {
      item.style.backgroundColor = 'var(--accent-light)';
    }

    // Create content container
    const content = document.createElement('div');
    content.className = 'chat-history-content';

    const title = document.createElement('div');
    title.className = 'chat-history-title';
    title.textContent = session.title;

    const meta = document.createElement('div');
    meta.className = 'chat-history-meta';

    // Format date as mm-dd HH:MM
    const date = new Date(session.timestamp);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const dateStr = `${month}-${day} ${hours}:${minutes}`;

    // Get provider, model, and system prompt info
    let metaInfo = [];

    if (session.modelUsed) {
      // Find the provider for this model
      let providerName = 'Unknown';
      for (const provider of state.config.providers) {
        const model = provider.models.find(m => m.id === session.modelUsed);
        if (model) {
          providerName = provider.name;
          metaInfo.push(providerName);
          break;
        }
      }

      // Find the model name
      let modelName = session.modelUsed;
      for (const provider of state.config.providers) {
        const model = provider.models.find(m => m.id === session.modelUsed);
        if (model) {
          modelName = model.name;
          break;
        }
      }
      metaInfo.push(modelName);
    }

    // Handle system prompt - try to get it from session or current config
    let systemPromptId = session.systemPromptId || state.config.selectedSystemPrompt;

    if (systemPromptId) {
      const systemPrompt = state.config.systemPrompts.find(p => p.id === systemPromptId);
      if (systemPrompt) {
        metaInfo.push(systemPrompt.name);
      }
    }

    const metaStr = metaInfo.length > 0 ? metaInfo.join(' • ') : 'Unknown';

    meta.innerHTML = `<span>${dateStr}</span><span>${metaStr}</span>`;

    content.appendChild(title);
    content.appendChild(meta);

    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-chat-btn';
    deleteBtn.setAttribute('aria-label', 'Delete chat');
    deleteBtn.innerHTML = '<i class="fas fa-times"></i>';

    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation(); // Prevent switching to the session
      deleteSession(sessionId);
    });

    item.appendChild(content);
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => {
      switchSession(sessionId);
    });

    elements.chatHistoryList.appendChild(item);
  });
}

// ========================================
// API COMMUNICATION FUNCTIONS
// ========================================

// Send a message to the configured LLM API and handle streaming response
async function sendMessageToAPI(_userMessage) {
  const provider = getCurrentProvider();
  if (!provider) {
    showError('No service provider configured. Please configure a provider in the options.');
    return;
  }

  // Reset scroll state when starting API response
  state.userScrolledUp = false;

  // Create AbortController for this request
  state.abortController = new AbortController();

  state.isStreaming = true;
  updateInputState();

  // Create assistant message placeholder
  const assistantMessageId = Date.now().toString();
  const assistantMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    reasoning: '',
    timestamp: new Date().toISOString()
  };

  state.sessions[state.currentSessionId].messages.push(assistantMessage);
  state.currentStreamingMessage = assistantMessage;
  renderMessages();

  try {
    await streamResponseFromAPI(provider, assistantMessage, state.abortController.signal);
  } catch (error) {
    console.error('API Error:', error);
    // Don't handle error if it was aborted by user
    if (error.name === 'AbortError') {
      console.log('Request aborted by user');
    } else {
      handleError(error);
    }
  } finally {
    // Clean up streaming state
    const wasAborted = state.abortController?.signal.aborted;
    const streamingMessageId = state.currentStreamingMessage?.id;

    // If this was an abort, handle the partial message properly
    if (wasAborted && streamingMessageId) {
      const session = state.sessions[state.currentSessionId];
      if (session) {
        const streamingMessage = session.messages.find(m => m.id === streamingMessageId);
        if (streamingMessage) {
          // Always keep the message if it has any content or reasoning
          const hasContent = streamingMessage.content && streamingMessage.content.trim() !== '';
          const hasReasoning = streamingMessage.reasoning && streamingMessage.reasoning.trim() !== '';

          if (hasContent || hasReasoning) {
            // Keep the partial message and update its metadata
            streamingMessage.timestamp = new Date().toISOString();
            console.log(`Keeping partial message: ${streamingMessage.content?.length || 0} chars content, ${streamingMessage.reasoning?.length || 0} chars reasoning`);
            renderMessages(); // Re-render to ensure it's properly displayed
            saveToStorage(); // Save to preserve the partial message
          } else {
            // Only remove completely empty messages
            session.messages = session.messages.filter(m => m.id !== streamingMessageId);
            console.log('Removed empty streaming message');
            renderMessages();
          }
        }
      }
    }

    // Reset streaming state after handling the message
    state.isStreaming = false;
    state.currentStreamingMessage = null;
    state.abortController = null;

    saveToStorage();
    updateInputState();
  }
}

// Get the currently selected provider object
function getCurrentProvider() {
  if (!state.config.selectedProvider) {
    return null;
  }
  return state.config.providers.find(p => p.id === state.config.selectedProvider);
}

// Build the request body for API calls
function buildRequestBody(messages) {
  const body = {
    model: state.config.selectedModel,
    messages: messages
  };

  // Add temperature only if not null or empty
  if (state.config.temperature !== null && state.config.temperature !== '') {
    body.temperature = state.config.temperature;
  }

  // Add max_completion_tokens only if not empty
  if (state.config.max_completion_tokens && state.config.max_completion_tokens.trim() !== '') {
    body.max_completion_tokens = parseInt(state.config.max_completion_tokens);
  }

  // Always add stream parameter (defaults to true if not set)
  body.stream = state.config.stream !== false; // Default to true

  return body;
}

// API request helper functions
async function makeApiRequest(provider, requestBody, signal) {
  const cleanedBaseUrl = provider.baseUrl.replace(/\/$/, '');
  const url = `${cleanedBaseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Request aborted by user');
      return null;
    }
    throw error;
  }
}

// Process streaming response
async function handleStreamingResponse(response, assistantMessage, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let partialLine = '';

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) break;

      const textChunk = decoder.decode(value);
      const lines = (partialLine + textChunk).split('\n');
      partialLine = lines.pop();

      for (const rawLine of lines) {
        await processStreamLine(rawLine, assistantMessage);
      }
    }

    // Final processing for think tags after streaming completes
    processThinkTags(assistantMessage);
  } catch (error) {
    if (isAbortError(error)) {
      console.log('Streaming aborted by user');
      return;
    }
    throw error;
  }
}

// Process individual stream line
async function processStreamLine(rawLine, assistantMessage) {
  const line = rawLine.trim();
  if (line === '' || !line.startsWith('data:')) return;

  const data = line.slice(5).trim();
  if (data === '[DONE]') return;

  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta;

    if (!delta) return;

    // Handle reasoning content
    if (delta.reasoning_content) {
      assistantMessage.reasoning += delta.reasoning_content;
    }

    // Handle content
    if (delta.content) {
      assistantMessage.content += delta.content;
    }

    // Update UI
    updateMessageDisplay(assistantMessage.id);
  } catch (parseError) {
    console.warn('Parse error:', parseError, 'Data:', data);
  }
}

// Process non-streaming response
async function handleNonStreamingResponse(response, assistantMessage, signal) {
  try {
    if (signal.aborted) return;

    const responseData = await response.json();
    if (signal.aborted) return;

    const choice = responseData.choices?.[0];
    if (!choice?.message) return;

    if (signal.aborted) return;

    const message = choice.message;

    // Handle reasoning content
    if (message.reasoning_content) {
      assistantMessage.reasoning = message.reasoning_content;
    }

    // Handle content
    if (message.content) {
      assistantMessage.content = message.content;
    }

    // Process think tags after setting initial content
    processThinkTags(assistantMessage);

    // Update UI to show the complete message
    updateMessageDisplay(assistantMessage.id);
  } catch (parseError) {
    if (signal.aborted) return;
    console.error('Error parsing non-streaming response:', parseError);
    throw new Error('Failed to parse API response');
  }
}

// Check if error is an abort error
function isAbortError(error) {
  return error.name === 'AbortError' ||
         (error instanceof DOMException && error.message === 'Request aborted');
}

// Main streaming function (refactored)
async function streamResponseFromAPI(provider, assistantMessage, signal) {
  const messages = buildMessageHistory();
  const requestBody = buildRequestBody(messages);
  const isStream = requestBody.stream;

  // Make API request
  const response = await makeApiRequest(provider, requestBody, signal);
  if (!response) return; // Request was aborted

  // Handle response based on streaming mode
  if (isStream) {
    await handleStreamingResponse(response, assistantMessage, signal);
  } else {
    await handleNonStreamingResponse(response, assistantMessage, signal);
  }
}

// Process think tags in message content after streaming completes
function processThinkTags(message) {
  if (!message.content) return;

  // Define regex pattern for thinking tags - use non-greedy matching and support multiple pairs
  const thinkRegex = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/gs;

  // Find all think tag matches
  const thinkMatches = [...message.content.matchAll(thinkRegex)];

  if (thinkMatches.length > 0) {
    // Extract reasoning from think tags and concatenate
    const extractedReasoning = thinkMatches.map(match => match[1]).join('\n\n');

    // Add to existing reasoning (if any)
    if (extractedReasoning.trim()) {
      if (message.reasoning) {
        message.reasoning += (message.reasoning.trim() ? '\n\n' : '') + extractedReasoning;
      } else {
        message.reasoning = extractedReasoning;
      }
    }

    // Remove think tags from content
    message.content = message.content.replace(thinkRegex, '').trim();

    // Update display to reflect the changes
    updateMessageDisplay(message.id);
  }
}

function buildMessageHistory() {
  const session = state.sessions[state.currentSessionId];
  const messages = [];

  // Add system prompt
  const systemPrompt = state.config.systemPrompts.find(p => p.id === state.config.selectedSystemPrompt);
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt.content
    });
  }

  // Add existing messages (excluding the current streaming assistant message)
  // Note: The user message is already in the session.messages from addMessage(),
  // so we don't need to add it again to avoid duplication
  session.messages
    .filter(msg => msg.id !== state.currentStreamingMessage?.id)
    .forEach(msg => {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    });

  return messages;
}

function updateMessageDisplay(messageId) {
  const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!messageElement) return;

  const message = state.sessions[state.currentSessionId].messages.find(m => m.id === messageId);
  if (!message) return;

  const bubble = messageElement.querySelector('.message-bubble');
  if (!bubble) return;

  const contentElement = messageElement.querySelector('.message-content');
  if (contentElement) {
    // User messages: render as plain text to preserve line breaks
    // Assistant messages: render as markdown
    if (message.role === 'user') {
      contentElement.textContent = message.content;
    } else {
      contentElement.innerHTML = renderMarkdown(message.content);
    }
  }

  // Handle reasoning section - create or update dynamically
  if (message.reasoning && message.reasoning.trim()) {
    let reasoningSection = messageElement.querySelector('.reasoning-section');

    // Create reasoning section if it doesn't exist
    if (!reasoningSection) {
      reasoningSection = createReasoningSection(message.reasoning);
      // Insert reasoning section before content element
      bubble.insertBefore(reasoningSection, contentElement);
    } else {
      // Update existing reasoning content
      const reasoningContent = reasoningSection.querySelector('.reasoning-content');
      if (reasoningContent) {
        reasoningContent.innerHTML = renderMarkdown(message.reasoning);
      }
    }

    // Ensure reasoning section is expanded (it's now default behavior)
    if (!reasoningSection.classList.contains('expanded')) {
      reasoningSection.classList.add('expanded');
    }
  }

  scrollToBottom();
}

function handleError(error) {
  // Log the error with context
  logError(error, 'API Request', {
    isStreaming: state.isStreaming,
    currentSessionId: state.currentSessionId
  });

  // Remove the assistant message if streaming failed
  if (state.currentStreamingMessage) {
    const session = state.sessions[state.currentSessionId];
    session.messages = session.messages.filter(m => m.id !== state.currentStreamingMessage.id);
    renderMessages();
  }

  // Use unified error message handling
  const errorMessage = getApiErrorMessage(error);
  showError(errorMessage);
}

function showError(message) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  const errorMessage = {
    id: Date.now().toString(),
    role: 'system',
    content: message,
    timestamp: new Date().toISOString()
  };

  session.messages.push(errorMessage);
  renderMessages();
  immediateSave(); // Use immediate save for error messages
}

console.log('SideMind sidebar script loaded');
