// SideMind Options Page Script
// Handles configuration management for service providers, parameters, and system prompts

// State
let config = {
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
  ],
  theme: 'light'
};

let editingProviderId = null;
let editingPromptId = null;

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
  renderUI();

  console.log('Options page initialized');
});

// Cache DOM Elements
function cacheElements() {
  // Buttons
  elements.addProviderBtn = document.getElementById('addProviderBtn');
  elements.addPromptBtn = document.getElementById('addPromptBtn');
  elements.saveBtn = document.getElementById('saveBtn');
  elements.exportBtn = document.getElementById('exportBtn');
  elements.importBtn = document.getElementById('importBtn');
  elements.importFile = document.getElementById('importFile');

  // Lists
  elements.providersList = document.getElementById('providersList');
  elements.promptsList = document.getElementById('promptsList');

  // Parameters
  elements.temperatureSlider = document.getElementById('temperatureSlider');
  elements.temperatureValue = document.getElementById('temperatureValue');
  elements.maxCompletionTokensInput = document.getElementById('maxCompletionTokensInput');
  elements.streamSelector = document.getElementById('streamSelector');

  // Appearance
  elements.fontSizeSelector = document.getElementById('fontSizeSelector');
  elements.fontFamilySelector = document.getElementById('fontFamilySelector');
  elements.customFontFamilyInput = document.getElementById('customFontFamilyInput');
  elements.themeSelector = document.getElementById('themeSelector');

  // Modals
  elements.providerModal = document.getElementById('providerModal');
  elements.promptModal = document.getElementById('promptModal');

  // Forms
  elements.providerForm = document.getElementById('providerForm');
  elements.promptForm = document.getElementById('promptForm');
  elements.modelsList = document.getElementById('modelsList');
  elements.addModelBtn = document.getElementById('addModelBtn');
  elements.providerName = document.getElementById('providerName');
  elements.providerBaseUrl = document.getElementById('providerBaseUrl');
  elements.providerApiKey = document.getElementById('providerApiKey');
  elements.promptName = document.getElementById('promptName');
  elements.promptContent = document.getElementById('promptContent');

  // Modal buttons
  elements.providerSaveBtn = document.getElementById('providerSaveBtn');
  elements.providerCancelBtn = document.getElementById('providerCancelBtn');
  elements.promptSaveBtn = document.getElementById('promptSaveBtn');
  elements.promptCancelBtn = document.getElementById('promptCancelBtn');
  elements.modalCloseBtns = document.querySelectorAll('.modal-close-btn');
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
  let temperatureTimeout;
  elements.temperatureSlider.addEventListener('input', () => {
    updateTemperatureDisplay();
    clearTimeout(temperatureTimeout);
    temperatureTimeout = setTimeout(() => saveConfig(), 500);
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
    console.error('Error loading config:', error);
    showNotification('Error loading configuration', 'error');
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

    // Verify the save was successful by reading it back
    const result = await chrome.storage.sync.get(['config']);
    if (result.config) {
      console.log('Verified config saved correctly:', result.config);
    } else {
      throw new Error('Config verification failed - no data found after save');
    }
  } catch (error) {
    console.error('Error saving config:', error);
    showNotification('Error saving configuration: ' + error.message, 'error');
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

  config.providers.forEach(provider => {
    const providerElement = createProviderElement(provider);
    elements.providersList.appendChild(providerElement);
  });
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

  config.systemPrompts.forEach(prompt => {
    const promptElement = createPromptElement(prompt);
    elements.promptsList.appendChild(promptElement);
  });
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
  elements.maxCompletionTokensInput.value = config.max_completion_tokens;
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

  models.forEach(model => {
    const modelField = createModelField(model.name, model.id);
    elements.modelsList.appendChild(modelField);
  });
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
    name: elements.providerName.value,
    baseUrl: elements.providerBaseUrl.value,
    apiKey: elements.providerApiKey.value,
    models: []
  };

  // Collect models
  const modelItems = elements.modelsList.querySelectorAll('.model-item');
  modelItems.forEach(item => {
    const name = item.querySelector('.model-name').value;
    const id = item.querySelector('.model-id').value;
    if (name && id) {
      providerData.models.push({ name, id });
    }
  });

  if (providerData.models.length === 0) {
    showNotification('Please add at least one model', 'error');
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
    name: elements.promptName.value,
    content: elements.promptContent.value
  };

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
    config.max_completion_tokens = value;
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

async function updateTheme() {
  config.theme = elements.themeSelector.value;
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
      console.error('Import error:', error);
      showNotification('Error importing configuration: ' + error.message, 'error');
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