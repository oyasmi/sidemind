// SideMind Chrome Extension - Sidebar Script
// Main application logic for the sidebar chat interface

// State Management
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
  currentStreamingMessage: null
};

// DOM Elements
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
  elements.sendBtn.addEventListener('click', handleSendMessage);
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

  // Listen for configuration changes from options page
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.config) {
      console.log('Configuration changed in options page, updating...');
      state.config = { ...state.config, ...changes.config.newValue };
      updateModelSelector();
      updateSystemPromptSelector();
      updateInputState();
      applyFontSettings(); // Apply font settings after config update
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

// Storage Functions
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
    console.error('Error loading from storage:', error);
    createNewSession();
  }
}

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
    console.error('Error saving to storage:', error);
  }
}

// Session Management
function createNewSession() {
  const sessionId = Date.now().toString();
  state.sessions[sessionId] = {
    messages: [],
    title: 'New Chat',
    timestamp: new Date().toISOString(),
    modelUsed: state.config.selectedModel
  };
  state.currentSessionId = sessionId;

  saveToStorage();
  renderMessages();
  updateInputState();

  console.log('Created new session:', sessionId);
}

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

// Message Management
function addMessage(role, content, reasoning = null) {
  const session = state.sessions[state.currentSessionId];
  if (!session) return;

  const message = {
    id: Date.now().toString(),
    role,
    content,
    reasoning,
    timestamp: new Date().toISOString()
  };

  session.messages.push(message);

  // Auto-generate session title from first user message
  if (role === 'user' && session.messages.length === 1) {
    session.title = content.length > 50 ? content.substring(0, 50) + '...' : content;
  }

  session.timestamp = new Date().toISOString();

  renderMessages();
  saveToStorage();
}

// UI Rendering
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

function createMessageElement(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${message.role}`;
  messageDiv.setAttribute('data-message-id', message.id);

  // Create avatar
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';

  if (message.role === 'user') {
    avatar.innerHTML = '<i class="fas fa-user"></i>';
  } else {
    avatar.innerHTML = '<i class="fas fa-robot"></i>';
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = renderMarkdown(message.content);

  // Add reasoning section first (before content) if exists
  if (message.reasoning && message.reasoning.trim()) {
    const reasoningSection = createReasoningSection(message.reasoning);
    bubble.appendChild(reasoningSection);
  }

  // Add content after reasoning
  bubble.appendChild(content);

  // Assemble message with avatar and bubble
  if (message.role === 'user') {
    // User: bubble first, then avatar
    messageDiv.appendChild(bubble);
    messageDiv.appendChild(avatar);
  } else {
    // Assistant: avatar first, then bubble
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(bubble);
  }

  return messageDiv;
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

// Markdown Rendering
function renderMarkdown(text) {
  try {
    return marked.parse(text);
  } catch (error) {
    console.error('Markdown parsing error:', error);
    return text;
  }
}

// UI Helper Functions
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
  if (elements.messagesList) {
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

  elements.sendBtn.disabled = !canSend;
}

function applyFontSettings() {
  if (state.config.fontSize) {
    document.documentElement.style.setProperty('--main-font-size', state.config.fontSize);
  }
  if (state.config.fontFamily) {
    document.documentElement.style.setProperty('--main-font-family', state.config.fontFamily);
  }
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

// Event Handlers
function handleModelChange(event) {
  state.config.selectedModel = event.target.value;

  // Find the provider for this model
  for (const provider of state.config.providers) {
    const model = provider.models.find(m => m.id === event.target.value);
    if (model) {
      state.config.selectedProvider = provider.id;
      break;
    }
  }

  saveToStorage();
  updateInputState();
}

function handleSystemPromptChange(event) {
  state.config.selectedSystemPrompt = event.target.value;
  saveToStorage();
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

async function handleSendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || elements.sendBtn.disabled) {
    return;
  }

  // Add user message
  addMessage('user', message);

  // Clear input
  elements.messageInput.value = '';
  autoResizeTextarea();
  updateInputState();

  // Send API request
  await sendMessageToAPI(message);
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

    const title = document.createElement('div');
    title.className = 'chat-history-title';
    title.textContent = session.title;

    const meta = document.createElement('div');
    meta.className = 'chat-history-meta';

    const date = new Date(session.timestamp);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const modelStr = session.modelUsed || 'Unknown';

    meta.innerHTML = `<span>${dateStr}</span><span>${modelStr}</span>`;

    item.appendChild(title);
    item.appendChild(meta);

    item.addEventListener('click', () => {
      switchSession(sessionId);
    });

    elements.chatHistoryList.appendChild(item);
  });
}

// API Functions
async function sendMessageToAPI(_userMessage) {
  const provider = getCurrentProvider();
  if (!provider) {
    showError('No service provider configured. Please configure a provider in the options.');
    return;
  }

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
    await streamResponseFromAPI(provider, assistantMessage);
  } catch (error) {
    console.error('API Error:', error);
    handleError(error);
  } finally {
    state.isStreaming = false;
    state.currentStreamingMessage = null;
    saveToStorage();
    updateInputState();
  }
}

function getCurrentProvider() {
  if (!state.config.selectedProvider) {
    return null;
  }
  return state.config.providers.find(p => p.id === state.config.selectedProvider);
}

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

async function streamResponseFromAPI(provider, assistantMessage) {
  const messages = buildMessageHistory();
  const assistantMessageId = assistantMessage.id;

  // Fix base URL: remove only trailing slashes
  const cleanedBaseUrl = provider.baseUrl.replace(/\/$/, '');
  const URL = `${cleanedBaseUrl}/chat/completions`;

  const requestBody = buildRequestBody(messages);
  const isStream = requestBody.stream;

  const response = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`API Error (${response.status}): ${errorData.error?.message || response.statusText}`);
  }

  // Handle streaming response
  if (isStream) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let partialLine = '';

    // Define regex pattern for thinking tags (like in open-os.js)
    const thinkRegex = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/gs;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const textChunk = decoder.decode(value);
    const lines = (partialLine + textChunk).split('\n');
    partialLine = lines.pop();

    for (const line of lines) {
      if (line.trim() === '' || !line.startsWith('data: ')) continue;

      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
          const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;

          if (!delta) continue;

          // Handle new format reasoning content
          if (delta.reasoning_content) {
            assistantMessage.reasoning += delta.reasoning_content;
          }

          // Handle content
          if (delta.content) {
            // Check for old format <think> tags and process them correctly
            const thinkMatches = [...delta.content.matchAll(thinkRegex)];
            if (thinkMatches.length > 0) {
              // Extract reasoning from <think> tags
              thinkMatches.forEach(match => {
                assistantMessage.reasoning += match[1];
              });
              // Remove <think> tags from content
              assistantMessage.content += delta.content.replace(thinkRegex, '');
            } else {
              assistantMessage.content += delta.content;
            }
          }

          // Update UI
          updateMessageDisplay(assistantMessageId);
        } catch (parseError) {
          console.warn('Parse error:', parseError, 'Data:', data);
        }
      }
    }
  } else {
    // Handle non-streaming response
    try {
      const responseData = await response.json();
      const choice = responseData.choices?.[0];

      if (choice?.message) {
        const message = choice.message;

        // Handle reasoning content (new format)
        if (message.reasoning_content) {
          assistantMessage.reasoning = message.reasoning_content;
        }

        // Handle content
        if (message.content) {
          // Check for old format  tags and process them correctly
          const thinkRegex = /<think(?:ing)?>(.*?)<\/think(?:ing)?>/gs;
          const thinkMatches = [...message.content.matchAll(thinkRegex)];

          if (thinkMatches.length > 0) {
            // Extract reasoning from  tags
            thinkMatches.forEach(match => {
              assistantMessage.reasoning += match[1];
            });
            // Remove  tags from content
            assistantMessage.content = message.content.replace(thinkRegex, '');
          } else {
            assistantMessage.content = message.content;
          }
        }

        // Update UI to show the complete message
        updateMessageDisplay(assistantMessageId);
      }
    } catch (parseError) {
      console.error('Error parsing non-streaming response:', parseError);
      throw new Error('Failed to parse API response');
    }
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
    contentElement.innerHTML = renderMarkdown(message.content);
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
  // Remove the assistant message if streaming failed
  if (state.currentStreamingMessage) {
    const session = state.sessions[state.currentSessionId];
    session.messages = session.messages.filter(m => m.id !== state.currentStreamingMessage.id);
    renderMessages();
  }

  let errorMessage = 'An error occurred while processing your request.';

  if (error.message.includes('401')) {
    errorMessage = 'Authentication failed. Please check your API key.';
  } else if (error.message.includes('404')) {
    errorMessage = 'Model or endpoint not found. Please check your configuration.';
  } else if (error.message.includes('429')) {
    errorMessage = 'Rate limit exceeded. Please try again later.';
  } else if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
    errorMessage = 'Network error. Please check your connection.';
  }

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
  saveToStorage();
}

console.log('SideMind sidebar script loaded');