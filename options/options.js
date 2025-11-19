// SideMind Options Page Script
// Handles configuration management for service providers, parameters, and system prompts

// State
let config = {
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
  ],
  theme: 'light'
};

let editingProviderId = null;
let editingPromptId = null;

// Utility function for debouncing
function debounce(func, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

// Input sanitization helper
function sanitizeInput(input) {
  return input.replace(/[<>]/g, '').trim();
}

// Centralized error handling
function handleError(error, context) {
  const message = error.message || 'An unexpected error occurred';
  console.error(`Error in ${context}:`, error);
  showNotification(`${context}: ${message}`, 'error');
}

// DOM Elements
const elements = {
  // Buttons
  addProviderBtn: null,
  addPromptBtn: null,
  saveBtn: null,
  exportBtn: null,
  importBtn: null,
  importFile: null,

  // Lists
  providersList: null,
  promptsList: null,

  // Parameters
  temperatureSlider: null,
  temperatureValue: null,
  maxCompletionTokensInput: null,
  streamSelector: null,

  // Modals
  providerModal: null,
  promptModal: null,

  // Forms
  providerForm: null,
  promptForm: null,
  modelsList: null,
  addModelBtn: null,
  providerName: null,
  providerBaseUrl: null,
  providerApiKey: null,
  promptName: null,
  promptContent: null,

  // Modal buttons
  providerSaveBtn: null,
  providerCancelBtn: null,
  promptSaveBtn: null,
  promptCancelBtn: null,
  modalCloseBtns: null
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Options page initializing...');

  cacheElements();
  setupEventListeners();
  await loadConfig();
  applyTheme(); // Apply theme after loading config
  renderUI();

  console.log('Options page initialized');
});

// Cache DOM Elements
function cacheElements() {
  const elementIds = [
    // Buttons
    'addProviderBtn', 'addPromptBtn', 'saveBtn', 'exportBtn', 'importBtn', 'importFile',
    // Lists
    'providersList', 'promptsList',
    // Parameters
    'temperatureSlider', 'temperatureValue', 'maxCompletionTokensInput', 'streamSelector',
    // Appearance
    'fontSizeSelector', 'fontFamilySelector', 'customFontFamilyInput', 'themeSelector',
    // Modals
    'providerModal', 'promptModal',
    // Forms
    'providerForm', 'promptForm', 'modelsList', 'addModelBtn',
    'providerName', 'providerBaseUrl', 'providerApiKey',
    'promptName', 'promptContent',
    // Modal buttons
    'providerSaveBtn', 'providerCancelBtn', 'promptSaveBtn', 'promptCancelBtn'
  ];

  elementIds.forEach(id => {
    const element = document.getElementById(id);
    if (!element) {
      console.error(`Required element not found: #${id}`);
      return;
    }
    // Convert kebab-case to camelCase for property names
    const propName = id.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    elements[propName] = element;
  });

  // Handle querySelector elements separately
  elements.modalCloseBtns = document.querySelectorAll('.modal-close-btn');
  if (elements.modalCloseBtns.length === 0) {
    console.error('Required elements not found: .modal-close-btn');
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Main actions
  elements.addProviderBtn.addEventListener('click', () => openProviderModal());
  elements.addPromptBtn.addEventListener('click', () => openPromptModal());
  elements.saveBtn.addEventListener('click', async () => {
    await saveConfig();
    renderUI(); // Re-render to ensure UI is in sync
  });
  elements.exportBtn.addEventListener('click', exportConfig);
  elements.importBtn.addEventListener('click', () => elements.importFile.click());
  elements.importFile.addEventListener('change', importConfig);

  // Parameter controls - use debounced saves to avoid excessive writes
  const debouncedSave = debounce(saveConfig, 500);
  elements.temperatureSlider.addEventListener('input', () => {
    updateTemperatureDisplay();
    debouncedSave();
  });
  elements.maxCompletionTokensInput.addEventListener('change', updateMaxCompletionTokens);
  elements.streamSelector.addEventListener('change', updateStream);

  // Appearance controls
  elements.fontSizeSelector.addEventListener('change', updateFontSize);
  elements.fontFamilySelector.addEventListener('change', () => {
    toggleCustomFontInputVisibility();
    updateFontFamily();
  });
  elements.customFontFamilyInput.addEventListener('input', updateFontFamily);
  elements.themeSelector.addEventListener('change', updateTheme);

  // Model management
  elements.addModelBtn.addEventListener('click', addModelField);

  // Modal actions
  elements.providerSaveBtn.addEventListener('click', saveProvider);
  elements.providerCancelBtn.addEventListener('click', () => closeProviderModal());
  elements.promptSaveBtn.addEventListener('click', savePrompt);
  elements.promptCancelBtn.addEventListener('click', () => closePromptModal());

  // Modal close buttons
  elements.modalCloseBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      closeAllModals();
    });
  });

  // Modal overlays
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', () => {
      closeAllModals();
    });
  });

  // Form submissions
  elements.providerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveProvider();
  });

  elements.promptForm.addEventListener('submit', (e) => {
    e.preventDefault();
    savePrompt();
  });
}

// Load Configuration
async function loadConfig() {
  try {
    const result = await chrome.storage.sync.get(['config']);
    if (result.config) {
      config = { ...config, ...result.config };
      console.log('Loaded config from sync storage:', config);
    } else {
      // Try to migrate from local storage if sync storage is empty
      const localResult = await chrome.storage.local.get(['config']);
      if (localResult.config) {
        config = { ...config, ...localResult.config };
        // Migrate to sync storage
        await chrome.storage.sync.set({ config });
        console.log('Migrated config from local to sync storage:', config);
        // Clear local storage after migration
        await chrome.storage.local.remove(['config']);
      }
    }
  } catch (error) {
    handleError(error, 'Loading configuration');
  }
}

// Save Configuration
async function saveConfig() {
  try {
    // Ensure we have a valid config object before saving
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid config object');
    }

    await chrome.storage.sync.set({ config });
    showNotification('Configuration saved successfully', 'success');
    console.log('Saved config to sync storage:', config);
  } catch (error) {
    handleError(error, 'Saving configuration');
  }
}

// Render UI
function renderUI() {
  renderProviders();
  renderPrompts();
  renderParameters();
}

// Render Providers
function renderProviders() {
  elements.providersList.innerHTML = '';

  if (config.providers.length === 0) {
    elements.providersList.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">No service providers configured. Click "Add Provider" to get started.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  config.providers.forEach(provider => {
    fragment.appendChild(createProviderElement(provider));
  });
  elements.providersList.appendChild(fragment);
}

function createProviderElement(provider) {
  const div = document.createElement('div');
  div.className = 'provider-item';

  const info = document.createElement('div');
  info.className = 'provider-info';

  const name = document.createElement('div');
  name.className = 'provider-name';
  name.textContent = provider.name;

  const details = document.createElement('div');
  details.className = 'provider-details';
  details.textContent = provider.baseUrl;

  const models = document.createElement('div');
  models.className = 'provider-models';
  models.textContent = `${provider.models.length} model(s): ${provider.models.map(m => m.name).join(', ')}`;

  info.appendChild(name);
  info.appendChild(details);
  info.appendChild(models);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-edit';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => editProvider(provider.id));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-remove';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteProvider(provider.id));

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  div.appendChild(info);
  div.appendChild(actions);

  return div;
}

// Render Prompts
function renderPrompts() {
  elements.promptsList.innerHTML = '';

  const fragment = document.createDocumentFragment();
  config.systemPrompts.forEach(prompt => {
    fragment.appendChild(createPromptElement(prompt));
  });
  elements.promptsList.appendChild(fragment);
}

function createPromptElement(prompt) {
  const div = document.createElement('div');
  div.className = 'prompt-item';

  const info = document.createElement('div');
  info.className = 'prompt-info';

  const name = document.createElement('div');
  name.className = 'prompt-name';
  name.textContent = prompt.name;

  const preview = document.createElement('div');
  preview.className = 'prompt-preview';
  preview.textContent = prompt.content.length > 100 ? prompt.content.substring(0, 100) + '...' : prompt.content;

  name.appendChild(preview);

  if (prompt.isDefault) {
    const defaultBadge = document.createElement('span');
    defaultBadge.className = 'prompt-default';
    defaultBadge.textContent = 'Default';
    name.appendChild(defaultBadge);
  }

  info.appendChild(name);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  if (!prompt.isDefault) {
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editPrompt(prompt.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-remove';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deletePrompt(prompt.id));

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
  }

  div.appendChild(info);
  div.appendChild(actions);

  return div;
}

// Render Parameters
function renderParameters() {
  elements.temperatureSlider.value = config.temperature;
  elements.temperatureValue.textContent = config.temperature;
  elements.maxCompletionTokensInput.value = config.max_completion_tokens; // API standard naming
  elements.streamSelector.value = config.stream.toString();

  // Load font settings
  elements.fontSizeSelector.value = config.fontSize || '14px';

  const predefinedFontFamilies = Array.from(elements.fontFamilySelector.options).map(option => option.value);
  if (config.fontFamily && !predefinedFontFamilies.includes(config.fontFamily)) {
    // It's a custom font family
    elements.fontFamilySelector.value = 'custom';
    elements.customFontFamilyInput.value = config.fontFamily;
    elements.customFontFamilyInput.classList.remove('hidden');
  } else {
    // It's a predefined font family or not set
    elements.fontFamilySelector.value = config.fontFamily || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    elements.customFontFamilyInput.classList.add('hidden');
  }

  // Load theme setting
  elements.themeSelector.value = config.theme || 'light';
}

// Provider Management
function openProviderModal(provider = null) {
  editingProviderId = provider ? provider.id : null;
  document.getElementById('providerModalTitle').textContent = provider ? 'Edit Service Provider' : 'Add Service Provider';

  if (provider) {
    elements.providerName.value = provider.name;
    elements.providerBaseUrl.value = provider.baseUrl;
    elements.providerApiKey.value = provider.apiKey;
    renderModelsList(provider.models);
  } else {
    elements.providerForm.reset();
    renderModelsList([]);
  }

  elements.providerModal.classList.remove('hidden');
}

function closeProviderModal() {
  elements.providerModal.classList.add('hidden');
  elements.providerForm.reset();
  editingProviderId = null;
  renderModelsList([]);
}

function renderModelsList(models) {
  elements.modelsList.innerHTML = '';

  if (models.length === 0) {
    addModelField();
    return;
  }

  const fragment = document.createDocumentFragment();
  models.forEach(model => {
    fragment.appendChild(createModelField(model.name, model.id));
  });
  elements.modelsList.appendChild(fragment);
}

function createModelField(name = '', id = '') {
  const div = document.createElement('div');
  div.className = 'model-item';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'model-name';
  nameInput.placeholder = 'Model Name';
  nameInput.value = name;
  nameInput.required = true;

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'model-id';
  idInput.placeholder = 'Model ID';
  idInput.value = id;
  idInput.required = true;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-model';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    div.remove();
  });

  div.appendChild(nameInput);
  div.appendChild(idInput);
  div.appendChild(removeBtn);

  return div;
}

function addModelField() {
  const modelField = createModelField();
  elements.modelsList.appendChild(modelField);
}

async function saveProvider() {
  if (!elements.providerForm.checkValidity()) {
    elements.providerForm.reportValidity();
    return;
  }

  const providerData = {
    name: sanitizeInput(elements.providerName?.value || ''),
    baseUrl: sanitizeInput(elements.providerBaseUrl?.value || ''),
    apiKey: elements.providerApiKey?.value || '', // API key doesn't need sanitization
    models: []
  };

  // Validate required fields
  if (!providerData.name || !providerData.baseUrl) {
    showNotification('Provider name and base URL are required', 'error');
    return;
  }

  // Basic URL validation
  try {
    new URL(providerData.baseUrl);
  } catch (error) {
    showNotification('Please enter a valid base URL (e.g., https://api.example.com)', 'error');
    return;
  }

  // Collect models with validation
  const models = Array.from(elements.modelsList.querySelectorAll('.model-item'))
    .map(item => ({
      name: sanitizeInput(item.querySelector('.model-name')?.value || ''),
      id: sanitizeInput(item.querySelector('.model-id')?.value || '')
    }))
    .filter(model => model.name && model.id);

  providerData.models = models;

  if (providerData.models.length === 0) {
    showNotification('Please add at least one model', 'error');
    return;
  }

  // Ensure we have permission for the provider's baseUrl
  const hasPermission = await ensureBackendPermission(providerData.baseUrl);
  if (!hasPermission) {
    showNotification(`Permission required for ${providerData.baseUrl} to save this provider`, 'error');
    return;
  }

  if (editingProviderId) {
    // Update existing provider
    const index = config.providers.findIndex(p => p.id === editingProviderId);
    if (index !== -1) {
      config.providers[index] = { ...providerData, id: editingProviderId };
    }
  } else {
    // Add new provider
    config.providers.push({ ...providerData, id: Date.now().toString() });
  }

  // Save the entire config to sync storage
  await saveConfig();
  renderProviders();
  closeProviderModal();
}

function editProvider(id) {
  const provider = config.providers.find(p => p.id === id);
  if (provider) {
    openProviderModal(provider);
  }
}

async function deleteProvider(id) {
  if (confirm('Are you sure you want to delete this provider?')) {
    config.providers = config.providers.filter(p => p.id !== id);
    await saveConfig();
    renderProviders();
  }
}

// Prompt Management
function openPromptModal(prompt = null) {
  editingPromptId = prompt ? prompt.id : null;
  document.getElementById('promptModalTitle').textContent = prompt ? 'Edit System Prompt' : 'Add System Prompt';

  if (prompt) {
    elements.promptName.value = prompt.name;
    elements.promptContent.value = prompt.content;
  } else {
    elements.promptForm.reset();
  }

  elements.promptModal.classList.remove('hidden');
}

function closePromptModal() {
  elements.promptModal.classList.add('hidden');
  elements.promptForm.reset();
  editingPromptId = null;
}

async function savePrompt() {
  if (!elements.promptForm.checkValidity()) {
    elements.promptForm.reportValidity();
    return;
  }

  const promptData = {
    name: sanitizeInput(elements.promptName?.value || ''),
    content: elements.promptContent?.value || ''
  };

  // Validate required fields
  if (!promptData.name || !promptData.content) {
    showNotification('Prompt name and content are required', 'error');
    return;
  }

  if (editingPromptId) {
    // Update existing prompt
    const index = config.systemPrompts.findIndex(p => p.id === editingPromptId);
    if (index !== -1) {
      config.systemPrompts[index] = { ...promptData, id: editingPromptId };
    }
  } else {
    // Add new prompt
    config.systemPrompts.push({ ...promptData, id: Date.now().toString() });
  }

  // Save the entire config to sync storage
  await saveConfig();
  renderPrompts();
  closePromptModal();
}

function editPrompt(id) {
  const prompt = config.systemPrompts.find(p => p.id === id);
  if (prompt) {
    openPromptModal(prompt);
  }
}

async function deletePrompt(id) {
  if (confirm('Are you sure you want to delete this prompt?')) {
    config.systemPrompts = config.systemPrompts.filter(p => p.id !== id);
    await saveConfig();
    renderPrompts();
  }
}

// Parameter Management
function updateTemperatureDisplay() {
  config.temperature = parseFloat(elements.temperatureSlider.value);
  elements.temperatureValue.textContent = config.temperature;
}

async function updateMaxCompletionTokens() {
  const value = elements.maxCompletionTokensInput.value.trim();
  // Allow empty string (null) or valid positive integer
  if (value === '' || (!isNaN(value) && parseInt(value) > 0)) {
    config.max_completion_tokens = value; // API standard naming
    await saveConfig();
  }
}

async function updateStream() {
  config.stream = elements.streamSelector.value === 'true';
  await saveConfig();
}

async function updateFontSize() {
  config.fontSize = elements.fontSizeSelector.value;
  await saveConfig();
}

function toggleCustomFontInputVisibility() {
  if (elements.fontFamilySelector.value === 'custom') {
    elements.customFontFamilyInput.classList.remove('hidden');
  } else {
    elements.customFontFamilyInput.classList.add('hidden');
  }
}

async function updateFontFamily() {
  let selectedFontFamily = elements.fontFamilySelector.value;
  if (selectedFontFamily === 'custom') {
    selectedFontFamily = elements.customFontFamilyInput.value.trim();
  }
  config.fontFamily = selectedFontFamily || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; // Fallback to default if custom is empty
  await saveConfig();
}

function applyTheme() {
  const theme = config.theme || 'light';
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

async function updateTheme() {
  config.theme = elements.themeSelector.value;
  applyTheme();
  await saveConfig();
}

// Import/Export
function exportConfig() {
  const configBlob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(configBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sidemind-config.json';
  a.click();
  URL.revokeObjectURL(url);
  showNotification('Configuration exported successfully', 'success');
}

function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const importedConfig = JSON.parse(e.target.result);
      if (validateConfig(importedConfig)) {
        config = importedConfig;
        // Save the imported config to sync storage immediately
        await saveConfig();
        renderUI();
        showNotification('Configuration imported successfully', 'success');
      } else {
        showNotification('Invalid configuration file', 'error');
      }
    } catch (error) {
      handleError(error, 'Importing configuration');
    }
  };
  reader.readAsText(file);

  // Reset file input
  event.target.value = '';
}

function validateConfig(config) {
  return (
    config &&
    typeof config === 'object' &&
    Array.isArray(config.providers) &&
    Array.isArray(config.systemPrompts) &&
    typeof config.temperature === 'number' &&
    (typeof config.max_completion_tokens === 'string') && // Can be empty string
    typeof config.stream === 'boolean' &&
    (!config.theme || ['light', 'dark', 'system'].includes(config.theme))
  );
}

// Modal Management
function closeAllModals() {
  elements.providerModal.classList.add('hidden');
  elements.promptModal.classList.add('hidden');
}

// ========================================
// PERMISSION MANAGEMENT
// ========================================

// Ensure backend permission for a given URL
async function ensureBackendPermission(backendUrl) {
  try {
    // Validate URL format
    const urlObj = new URL(backendUrl);
    const origin = urlObj.origin + '/*';

    // First check if we already have permission
    const hasPermission = await chrome.permissions.contains({
      origins: [origin]
    });

    if (hasPermission) {
      console.log(`Permission already granted for ${origin}`);
      return true;
    }

    // If it's a local address, it might be declared in manifest
    if (urlObj.hostname === 'localhost' ||
        urlObj.hostname === '127.0.0.1' ||
        urlObj.hostname.startsWith('192.168.') ||
        urlObj.hostname.startsWith('10.') ||
        urlObj.hostname === '0.0.0.0') {
      console.log(`Local address detected: ${urlObj.hostname}, assuming permission exists`);
      return true;
    }

    // Otherwise request permission dynamically
    console.log(`Requesting permission for ${origin}`);
    return await chrome.permissions.request({
      origins: [origin]
    });

  } catch (error) {
    console.error('Error checking/requesting permissions:', error);
    return false;
  }
}

// Notifications
function showNotification(message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 20px;
    border-radius: 6px;
    color: white;
    font-weight: 500;
    z-index: 10000;
    background-color: ${type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--accent)'};
    box-shadow: var(--shadow-lg);
    animation: slideInRight 0.3s ease;
  `;

  document.body.appendChild(notification);

  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'fadeOut 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 300);
  }, 3000);
}

console.log('Options script loaded');