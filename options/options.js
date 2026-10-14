// SideMind settings — vanilla DOM, Chrome sync storage, transactional dialogs.

// ===== Configuration =====
const DEFAULT_CONFIG = {
  providers: [],
  selectedProvider: null,
  selectedModel: null,
  selectedSystemPrompt: 'default',
  temperature: 0.7,
  max_completion_tokens: '',
  stream: true,
  reasoning_effort: '',
  reasoning_summary: 'off',
  systemPrompts: [
    { id: 'default', name: 'Default', content: 'You are a helpful assistant.', isDefault: true }
  ],
  theme: 'light'
};
let config = structuredClone(DEFAULT_CONFIG);
let editingProviderId = null;
let editingPromptId = null;
let saveTimer = null;
let saveQueue = Promise.resolve();
let saveRevision = 0;
let dialogSnapshot = '';
let dialogBusy = false;
let confirmResolver = null;
let dialogOpener = null;
const pendingPreferenceKeys = new Set();
const elements = {};

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  await loadConfig();
  setupEventListeners();
  renderUI();
  elements.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
  const observer = new IntersectionObserver(updateActiveSection, {
    rootMargin: '-20% 0px -55% 0px'
  });
  document.querySelectorAll('main > section').forEach((section) => observer.observe(section));
});

function cacheElements() {
  [
    'addProviderBtn',
    'addPromptBtn',
    'saveBtn',
    'saveStatus',
    'exportBtn',
    'exportKeys',
    'importBtn',
    'importFile',
    'providersList',
    'promptsList',
    'temperatureSlider',
    'temperatureValue',
    'temperatureDefaultToggle',
    'maxCompletionTokensInput',
    'maxTokensError',
    'streamSelector',
    'reasoningEffortSelector',
    'reasoningSummarySelector',
    'fontSizeSelector',
    'fontFamilySelector',
    'customFontFamilyInput',
    'themeSelector',
    'fontPreview',
    'providerModal',
    'promptModal',
    'providerForm',
    'promptForm',
    'modelsList',
    'addModelBtn',
    'providerName',
    'providerBaseUrl',
    'providerApiKey',
    'providerApiType',
    'toggleApiKey',
    'endpointPreview',
    'promptName',
    'promptContent',
    'providerSaveBtn',
    'providerCancelBtn',
    'promptSaveBtn',
    'promptCancelBtn',
    'confirmModal',
    'confirmTitle',
    'confirmDescription',
    'confirmAccept',
    'confirmCancel',
    'notifications',
    'versionBadge'
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function setupEventListeners() {
  elements.addProviderBtn.addEventListener('click', () => openProviderModal());
  elements.addPromptBtn.addEventListener('click', () => openPromptModal());
  elements.saveBtn.addEventListener('click', saveCurrentConfig);
  elements.exportBtn.addEventListener('click', exportConfig);
  elements.importBtn.addEventListener('click', () => elements.importFile.click());
  elements.importFile.addEventListener('change', importConfig);
  elements.temperatureSlider.addEventListener('input', updateTemperatureMode);
  elements.temperatureDefaultToggle.addEventListener('change', updateTemperatureMode);
  elements.maxCompletionTokensInput.addEventListener('input', updateMaxCompletionTokens);
  elements.streamSelector.addEventListener('change', updateStream);
  elements.reasoningEffortSelector.addEventListener('change', updateReasoningEffort);
  elements.reasoningSummarySelector.addEventListener('change', updateReasoningSummary);
  elements.fontSizeSelector.addEventListener('change', updateFontSize);
  elements.fontFamilySelector.addEventListener('change', updateFontFamily);
  elements.customFontFamilyInput.addEventListener('input', updateFontFamily);
  elements.themeSelector.addEventListener('change', updateTheme);
  elements.addModelBtn.addEventListener('click', addModelField);
  elements.providerBaseUrl.addEventListener('input', updateEndpointPreview);
  elements.providerApiType.addEventListener('change', updateEndpointPreview);
  elements.toggleApiKey.addEventListener('click', toggleApiKey);
  elements.providerSaveBtn.addEventListener('click', saveProvider);
  elements.promptSaveBtn.addEventListener('click', savePrompt);
  elements.providerCancelBtn.addEventListener('click', () =>
    requestCloseDialog(elements.providerModal)
  );
  elements.promptCancelBtn.addEventListener('click', () =>
    requestCloseDialog(elements.promptModal)
  );
  [elements.providerModal, elements.promptModal].forEach((dialog) => {
    dialog
      .querySelector('.modal-close-btn')
      .addEventListener('click', () => requestCloseDialog(dialog));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      requestCloseDialog(dialog);
    });
    dialog.addEventListener('click', handleDialogBackdrop);
    dialog.addEventListener('input', clearDialogError);
  });
  elements.confirmModal
    .querySelector('.modal-close-btn')
    .addEventListener('click', () => resolveConfirmation(false));
  elements.confirmCancel.addEventListener('click', () => resolveConfirmation(false));
  elements.confirmAccept.addEventListener('click', () => resolveConfirmation(true));
  elements.confirmModal.addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveConfirmation(false);
  });
  elements.providerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveProvider();
  });
  elements.promptForm.addEventListener('submit', (event) => {
    event.preventDefault();
    savePrompt();
  });
  window.addEventListener('pagehide', flushPendingSave);
  chrome.storage.onChanged.addListener(handleConfigurationChange);
}

function updateActiveSection(entries) {
  const visible = entries.find((entry) => entry.isIntersecting);
  if (!visible) return;
  document.querySelectorAll('.settings-nav a').forEach((link) => {
    if (link.hash === `#${visible.target.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

// ===== Storage and feedback =====
async function loadConfig() {
  try {
    const result = await chrome.storage.sync.get(['config']);
    if (result.config) {
      config = { ...structuredClone(DEFAULT_CONFIG), ...result.config };
    } else {
      const local = await chrome.storage.local.get(['config']);
      if (local.config) {
        config = { ...structuredClone(DEFAULT_CONFIG), ...local.config };
        assertConfigFitsSync(config);
        await chrome.storage.sync.set({ config });
        await chrome.storage.local.remove(['config']);
      }
    }
  } catch (error) {
    console.error('Loading configuration:', error);
    showNotification(error.name === 'SyncQuotaError' ? error.message : 'Could not load settings. Reload this page to try again.', 'error');
  }
}

function setSaveStatus(text, status = '') {
  if (!elements.saveStatus) return;
  elements.saveStatus.textContent = text;
  elements.saveStatus.dataset.state = status;
  elements.saveBtn.classList.toggle('hidden', status !== 'error');
}

function queueSave(key) {
  pendingPreferenceKeys.add(key);
  clearTimeout(saveTimer);
  setSaveStatus('Saving changes…', 'saving');
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveConfig();
  }, 450);
}

function flushPendingSave() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveConfig();
}

async function saveCurrentConfig() {
  await saveConfig();
}

let lastSaveError = '';

async function saveConfig(candidate = config, replace = false) {
  lastSaveError = '';
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = structuredClone(candidate);
  const revision = ++saveRevision;
  setSaveStatus('Saving changes…', 'saving');
  // Merge just the edited fields with the latest sync configuration. A model
  // selected in the sidebar must not be overwritten by an older settings tab.
  const changedKeys = replace
    ? Object.keys(snapshot)
    : candidate === config
      ? []
      : Object.keys(snapshot).filter(
          (key) => JSON.stringify(snapshot[key]) !== JSON.stringify(config[key])
        );
  const keys = Array.from(new Set([...changedKeys, ...pendingPreferenceKeys]));
  let written;
  const write = saveQueue.then(async () => {
    const latest = await chrome.storage.sync.get(['config']);
    written = { ...structuredClone(DEFAULT_CONFIG), ...(latest?.config || config) };
    keys.forEach((key) => {
      written[key] = snapshot[key];
    });
    repairSelection(written);
    assertConfigFitsSync(written);
    await chrome.storage.sync.set({ config: written });
  });
  saveQueue = write.catch(() => {});
  try {
    await write;
    keys.forEach((key) => {
      if (JSON.stringify(config[key]) === JSON.stringify(snapshot[key]))
        pendingPreferenceKeys.delete(key);
    });
    const unsaved = Object.fromEntries(
      Array.from(pendingPreferenceKeys).map((key) => [key, config[key]])
    );
    config = { ...written, ...unsaved };
    if (revision === saveRevision) setSaveStatus('All changes saved', 'saved');
    return true;
  } catch (error) {
    console.error('Saving configuration:', error);
    lastSaveError = error.name === 'SyncQuotaError' ? error.message : '';
    if (revision === saveRevision) {
      setSaveStatus(error.name === 'SyncQuotaError' ? error.message : 'Could not save changes', 'error');
    }
    return false;
  }
}

function handleConfigurationChange(changes, area) {
  if (area !== 'sync' || !changes.config?.newValue) return;
  const unsaved = Object.fromEntries(
    Array.from(pendingPreferenceKeys).map((key) => [key, config[key]])
  );
  config = { ...structuredClone(DEFAULT_CONFIG), ...changes.config.newValue, ...unsaved };
  applyTheme();
  updateFontPreview();
  const editing = document.activeElement?.matches('input, textarea, select');
  if (!elements.providerModal.open && !elements.promptModal.open && !elements.confirmModal.open) {
    renderProviders();
    renderPrompts();
    if (!pendingPreferenceKeys.size && !editing) renderParameters();
  }
}

// ===== Rendering =====
function renderUI() {
  renderProviders();
  renderPrompts();
  renderParameters();
  applyTheme();
  updateFontPreview();
}

function renderProviders() {
  elements.providersList.replaceChildren();
  if (!config.providers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = 'Your first model starts here';
    const text = document.createElement('span');
    text.textContent = 'Add a provider, enter its API key, and choose the models you want to use.';
    empty.append(title, text);
    elements.providersList.appendChild(empty);
  }
  config.providers.forEach((provider) =>
    elements.providersList.appendChild(createProviderElement(provider))
  );
}

function createProviderElement(provider) {
  const item = document.createElement('div');
  item.className = 'provider-item';
  const info = document.createElement('div');
  info.className = 'provider-info';
  const name = document.createElement('div');
  name.className = 'provider-name';
  name.textContent = provider.name;
  const badge = document.createElement('span');
  badge.className = 'provider-api';
  badge.textContent = provider.apiType === 'responses' ? 'Responses' : 'Chat Completions';
  name.appendChild(badge);
  const details = document.createElement('div');
  details.className = 'provider-details';
  details.textContent = normalizeBaseUrl(provider.baseUrl || '');
  const models = document.createElement('div');
  models.className = 'provider-models';
  models.textContent = `${provider.models.length} model${provider.models.length === 1 ? '' : 's'} · ${provider.models.map((model) => model.name).join(', ')}`;
  info.append(name, details, models);
  const actions = createItemActions(
    () => openProviderModal(provider),
    () => deleteProvider(provider.id),
    provider.name
  );
  item.append(info, actions);
  return item;
}

function createItemActions(edit, remove, name) {
  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  [
    ['Edit', 'btn-edit', edit],
    ['Delete', 'btn-remove', remove]
  ].forEach(([label, className, handler]) => {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.setAttribute('aria-label', `${label} ${name}`);
    button.addEventListener('click', handler);
    actions.appendChild(button);
  });
  return actions;
}

function renderPrompts() {
  elements.promptsList.replaceChildren();
  config.systemPrompts.forEach((prompt) => {
    const item = document.createElement('div');
    item.className = 'prompt-item';
    const info = document.createElement('div');
    info.className = 'prompt-info';
    const name = document.createElement('div');
    name.className = 'prompt-name';
    name.textContent = prompt.name;
    if (prompt.isDefault) {
      const badge = document.createElement('span');
      badge.className = 'prompt-default';
      badge.textContent = 'Built-in';
      name.appendChild(badge);
    }
    const preview = document.createElement('div');
    preview.className = 'prompt-preview';
    preview.textContent =
      prompt.content.length > 160 ? `${prompt.content.slice(0, 160)}…` : prompt.content;
    info.append(name, preview);
    item.appendChild(info);
    if (!prompt.isDefault)
      item.appendChild(
        createItemActions(
          () => openPromptModal(prompt),
          () => deletePrompt(prompt.id),
          prompt.name
        )
      );
    elements.promptsList.appendChild(item);
  });
}

function renderParameters() {
  renderTemperature();
  elements.maxCompletionTokensInput.value = config.max_completion_tokens || '';
  elements.streamSelector.value = String(config.stream !== false);
  elements.reasoningEffortSelector.value = config.reasoning_effort || '';
  elements.reasoningSummarySelector.value = config.reasoning_summary || 'off';
  elements.fontSizeSelector.value = config.fontSize || '14px';
  const fonts = Array.from(elements.fontFamilySelector.options).map((option) => option.value);
  elements.fontFamilySelector.value = !config.fontFamily
    ? fonts[0]
    : fonts.includes(config.fontFamily)
      ? config.fontFamily
      : 'custom';
  elements.customFontFamilyInput.value =
    elements.fontFamilySelector.value === 'custom' ? config.fontFamily : '';
  toggleCustomFontInputVisibility();
  elements.themeSelector.value = config.theme || 'light';
  elements.maxTokensError.classList.add('hidden');
  elements.maxCompletionTokensInput.removeAttribute('aria-invalid');
}

// ===== Dialogs =====
function dialogValues(dialog) {
  return JSON.stringify(
    Array.from(dialog.querySelectorAll('input, textarea, select')).map((field) =>
      field.type === 'checkbox' ? field.checked : field.value
    )
  );
}

function openDialog(dialog) {
  dialog.querySelector('.modal-error')?.classList.add('hidden');
  dialogSnapshot = dialogValues(dialog);
  dialogOpener = document.activeElement;
  dialog.showModal();
  dialog.querySelector('input, textarea')?.focus();
}

async function requestCloseDialog(dialog) {
  if (dialogBusy || elements.confirmModal.open) return;
  if (dialogValues(dialog) !== dialogSnapshot) {
    const discard = await confirmAction(
      'Discard changes?',
      'Your edits in this dialog have not been saved.',
      'Discard changes'
    );
    if (!discard) return;
  }
  if (dialog === elements.providerModal) closeProviderModal();
  else closePromptModal();
}

function handleDialogBackdrop(event) {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    requestCloseDialog(dialog);
}

function clearDialogError(event) {
  event.currentTarget.querySelector('.modal-error')?.classList.add('hidden');
}

function showDialogError(dialog, text) {
  const error = dialog.querySelector('.modal-error');
  error.textContent = text;
  error.classList.remove('hidden');
}

function setDialogBusy(dialog, busy) {
  dialogBusy = busy;
  dialog.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
  dialog.querySelectorAll('input, textarea, select').forEach((field) => {
    field.disabled = busy;
  });
}

function confirmAction(title, description, label = 'Continue') {
  if (confirmResolver) return Promise.resolve(false);
  elements.confirmTitle.textContent = title;
  elements.confirmDescription.textContent = description;
  elements.confirmAccept.textContent = label;
  elements.confirmModal.showModal();
  elements.confirmCancel.focus();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirmation(accepted) {
  elements.confirmModal.close();
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(accepted);
}

// ===== Provider management =====
function sanitizeInput(input) {
  return input.trim();
}

function normalizeBaseUrl(url) {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses)$/, '');
}

function openProviderModal(provider = null) {
  editingProviderId = provider?.id || null;
  document.getElementById('providerModalTitle').textContent = provider
    ? 'Edit provider'
    : 'Connect a provider';
  elements.providerForm.reset();
  elements.providerName.value = provider?.name || '';
  elements.providerBaseUrl.value = provider?.baseUrl || '';
  elements.providerApiKey.value = provider?.apiKey || '';
  elements.providerApiType.value = provider?.apiType === 'responses' ? 'responses' : 'chat';
  elements.providerApiKey.type = 'password';
  elements.toggleApiKey.setAttribute('aria-pressed', 'false');
  elements.toggleApiKey.setAttribute('aria-label', 'Show API key');
  renderModelsList(provider?.models || []);
  updateEndpointPreview();
  openDialog(elements.providerModal);
}

function closeProviderModal() {
  elements.providerModal.close();
  elements.providerForm.reset();
  editingProviderId = null;
  (dialogOpener?.isConnected ? dialogOpener : elements.addProviderBtn)?.focus();
}

function renderModelsList(models) {
  elements.modelsList.replaceChildren();
  (models.length ? models : [{ name: '', id: '' }]).forEach((model) =>
    elements.modelsList.appendChild(createModelField(model.name, model.id))
  );
}

function createModelField(name = '', id = '') {
  const item = document.createElement('div');
  item.className = 'model-item';
  [
    ['model-name', 'Display name', name],
    ['model-id', 'Model ID', id]
  ].forEach(([className, label, value]) => {
    const input = document.createElement('input');
    input.className = className;
    input.type = 'text';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.value = value;
    input.required = true;
    item.appendChild(input);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-remove-model';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove model');
  remove.addEventListener('click', () => {
    if (elements.modelsList.children.length === 1) {
      showDialogError(elements.providerModal, 'A provider needs at least one model.');
      return;
    }
    const next = item.nextElementSibling || item.previousElementSibling;
    item.remove();
    next?.querySelector('input')?.focus();
  });
  item.appendChild(remove);
  return item;
}

function addModelField() {
  const field = createModelField();
  elements.modelsList.appendChild(field);
  field.querySelector('input').focus();
}

function updateEndpointPreview() {
  const base = normalizeBaseUrl(elements.providerBaseUrl.value);
  const endpoint =
    elements.providerApiType.value === 'responses' ? '/responses' : '/chat/completions';
  elements.endpointPreview.textContent = base
    ? `Request URL: ${base}${endpoint}`
    : 'Your request URL will appear here.';
}

function toggleApiKey() {
  const visible = elements.providerApiKey.type === 'password';
  elements.providerApiKey.type = visible ? 'text' : 'password';
  elements.toggleApiKey.setAttribute('aria-pressed', String(visible));
  elements.toggleApiKey.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
}

async function saveProvider() {
  if (dialogBusy || !elements.providerForm.checkValidity()) {
    elements.providerForm.reportValidity();
    return;
  }
  const data = {
    id: editingProviderId || crypto.randomUUID(),
    name: sanitizeInput(elements.providerName.value),
    baseUrl: normalizeBaseUrl(elements.providerBaseUrl.value),
    apiKey: elements.providerApiKey.value.trim(),
    apiType: elements.providerApiType.value === 'responses' ? 'responses' : 'chat',
    models: Array.from(elements.modelsList.querySelectorAll('.model-item')).map((item) => ({
      name: item.querySelector('.model-name').value.trim(),
      id: item.querySelector('.model-id').value.trim()
    }))
  };
  if (
    !data.name ||
    !data.apiKey ||
    !data.models.length ||
    data.models.some((model) => !model.name || !model.id)
  ) {
    showDialogError(
      elements.providerModal,
      'Enter a provider name, API key, and at least one complete model.'
    );
    return;
  }
  try {
    const url = new URL(data.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid URL');
  } catch {
    showDialogError(
      elements.providerModal,
      'Enter an HTTP or HTTPS API root without query parameters, credentials, or a fragment.'
    );
    return;
  }
  if (new Set(data.models.map((model) => model.id)).size !== data.models.length) {
    showDialogError(elements.providerModal, 'Each model ID must be unique within this provider.');
    return;
  }
  setDialogBusy(elements.providerModal, true);
  try {
    if (!(await ensureBackendPermission(data.baseUrl))) {
      showDialogError(
        elements.providerModal,
        'Chrome did not grant access to this provider. Save again to allow access.'
      );
      return;
    }
    const candidate = structuredClone(config);
    const index = candidate.providers.findIndex((provider) => provider.id === data.id);
    if (index === -1) candidate.providers.push(data);
    else candidate.providers[index] = data;
    repairSelection(candidate);
    if (!(await saveConfig(candidate))) {
      showDialogError(
        elements.providerModal,
        lastSaveError || 'Could not save this provider. Your edits are still here; try saving again.'
      );
      return;
    }
    renderProviders();
    closeProviderModal();
  } catch (error) {
    console.error('Saving provider:', error);
    showDialogError(elements.providerModal, 'Could not save this provider. Please try again.');
  } finally {
    setDialogBusy(elements.providerModal, false);
  }
}

function repairSelection(candidate) {
  const provider = candidate.providers.find((item) => item.id === candidate.selectedProvider);
  if (
    !provider?.models.some((model) => `${model.id} - ${provider.id}` === candidate.selectedModel)
  ) {
    candidate.selectedModel = null;
    candidate.selectedProvider = null;
  }
  if (!candidate.systemPrompts.some((prompt) => prompt.id === candidate.selectedSystemPrompt))
    candidate.selectedSystemPrompt = 'default';
}

async function deleteProvider(id) {
  const provider = config.providers.find((item) => item.id === id);
  if (
    !provider ||
    !(await confirmAction(
      'Delete provider?',
      `Remove “${provider.name}” and its models? Your saved conversations will remain.`,
      'Delete provider'
    ))
  )
    return;
  const candidate = structuredClone(config);
  candidate.providers = candidate.providers.filter((item) => item.id !== id);
  repairSelection(candidate);
  if (await saveConfig(candidate)) renderProviders();
  else showNotification('Provider was not deleted. Try again.', 'error');
}

// ===== Assistant roles =====
function openPromptModal(prompt = null) {
  editingPromptId = prompt?.id || null;
  document.getElementById('promptModalTitle').textContent = prompt
    ? 'Edit assistant role'
    : 'Add assistant role';
  elements.promptForm.reset();
  elements.promptName.value = prompt?.name || '';
  elements.promptContent.value = prompt?.content || '';
  openDialog(elements.promptModal);
}

function closePromptModal() {
  elements.promptModal.close();
  elements.promptForm.reset();
  editingPromptId = null;
  (dialogOpener?.isConnected ? dialogOpener : elements.addPromptBtn)?.focus();
}

async function savePrompt() {
  if (dialogBusy || !elements.promptForm.checkValidity()) {
    elements.promptForm.reportValidity();
    return;
  }
  const data = {
    id: editingPromptId || crypto.randomUUID(),
    name: elements.promptName.value.trim(),
    content: elements.promptContent.value.trim()
  };
  if (!data.name || !data.content) {
    showDialogError(elements.promptModal, 'Enter a name and instructions for this role.');
    return;
  }
  setDialogBusy(elements.promptModal, true);
  try {
    const candidate = structuredClone(config);
    const index = candidate.systemPrompts.findIndex((prompt) => prompt.id === data.id);
    if (index === -1) candidate.systemPrompts.push(data);
    else candidate.systemPrompts[index] = data;
    if (!(await saveConfig(candidate))) {
      showDialogError(
        elements.promptModal,
        lastSaveError || 'Could not save this role. Your edits are still here; try again.'
      );
      return;
    }
    renderPrompts();
    closePromptModal();
  } finally {
    setDialogBusy(elements.promptModal, false);
  }
}

async function deletePrompt(id) {
  const prompt = config.systemPrompts.find((item) => item.id === id);
  if (
    !prompt ||
    prompt.isDefault ||
    !(await confirmAction('Delete assistant role?', `Remove “${prompt.name}”?`, 'Delete role'))
  )
    return;
  const candidate = structuredClone(config);
  candidate.systemPrompts = candidate.systemPrompts.filter((item) => item.id !== id);
  repairSelection(candidate);
  if (await saveConfig(candidate)) renderPrompts();
  else showNotification('Role was not deleted. Try again.', 'error');
}

// ===== Parameters and appearance =====
function isTemperatureOmitted() {
  return config.temperature == null || config.temperature === '';
}

function renderTemperature() {
  const omitted = isTemperatureOmitted();
  elements.temperatureDefaultToggle.checked = omitted;
  elements.temperatureSlider.disabled = omitted;
  elements.temperatureSlider.value = omitted ? '0.7' : String(config.temperature);
  elements.temperatureValue.textContent = omitted ? 'Model default' : String(config.temperature);
}

function updateTemperatureMode() {
  config.temperature = elements.temperatureDefaultToggle.checked
    ? null
    : Number(elements.temperatureSlider.value);
  renderTemperature();
  queueSave('temperature');
}

function updateMaxCompletionTokens() {
  const value = elements.maxCompletionTokensInput.value.trim();
  const valid = value === '' || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
  elements.maxTokensError.classList.toggle('hidden', valid);
  elements.maxCompletionTokensInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    elements.maxTokensError.textContent =
      'Enter a positive whole number, or leave empty for the model default.';
    return;
  }
  config.max_completion_tokens = value;
  queueSave('max_completion_tokens');
}

function updateStream() {
  config.stream = elements.streamSelector.value === 'true';
  queueSave('stream');
}
function updateReasoningEffort() {
  config.reasoning_effort = elements.reasoningEffortSelector.value;
  queueSave('reasoning_effort');
}
function updateReasoningSummary() {
  config.reasoning_summary = elements.reasoningSummarySelector.value;
  queueSave('reasoning_summary');
}
function updateFontSize() {
  config.fontSize = elements.fontSizeSelector.value;
  updateFontPreview();
  queueSave('fontSize');
}
function toggleCustomFontInputVisibility() {
  elements.customFontFamilyInput.classList.toggle(
    'hidden',
    elements.fontFamilySelector.value !== 'custom'
  );
}
function updateFontFamily() {
  toggleCustomFontInputVisibility();
  config.fontFamily =
    elements.fontFamilySelector.value === 'custom'
      ? elements.customFontFamilyInput.value.trim()
      : elements.fontFamilySelector.value;
  updateFontPreview();
  queueSave('fontFamily');
}
function updateFontPreview() {
  elements.fontPreview.style.setProperty('--preview-font-size', config.fontSize || '14px');
  elements.fontPreview.style.setProperty(
    '--preview-font-family',
    config.fontFamily || 'system-ui, sans-serif'
  );
}
function applyTheme() {
  document.documentElement.classList.remove('light-theme', 'dark-theme');
  if (config.theme !== 'system')
    document.documentElement.classList.add(config.theme === 'dark' ? 'dark-theme' : 'light-theme');
}
function updateTheme() {
  config.theme = elements.themeSelector.value;
  applyTheme();
  queueSave('theme');
}

// ===== Backup and import =====
function exportConfig() {
  const exported = structuredClone(config);
  if (!elements.exportKeys.checked)
    exported.providers.forEach((provider) => {
      provider.apiKey = '';
    });
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sidemind-config.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotification(
    elements.exportKeys.checked
      ? 'Configuration exported with API keys.'
      : 'Configuration exported without API keys.'
  );
}

async function importConfig(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 1024 * 1024)
      throw new Error('This file is too large for a configuration backup.');
    const imported = JSON.parse(await file.text());
    if (!validateConfig(imported))
      throw new Error('This file does not contain a valid SideMind configuration.');
    const candidate = { ...structuredClone(DEFAULT_CONFIG), ...imported };
    candidate.providers = candidate.providers.map((provider) => ({
      ...provider,
      baseUrl: normalizeBaseUrl(provider.baseUrl)
    }));
    if (!candidate.systemPrompts.some((prompt) => prompt.id === 'default'))
      candidate.systemPrompts.unshift(structuredClone(DEFAULT_CONFIG.systemPrompts[0]));
    repairSelection(candidate);
    const missingKeys = candidate.providers.filter((provider) => !provider.apiKey).length;
    const accepted = await confirmAction(
      'Replace configuration?',
      `${candidate.providers.length} provider(s) · ${candidate.systemPrompts.length} role(s)\nThis replaces your current settings. Conversations will remain.${missingKeys ? `\n${missingKeys} provider(s) need an API key after import.` : ''}`,
      'Import configuration'
    );
    if (!accepted) return;
    if (!(await saveConfig(candidate, true))) {
      showNotification(
        lastSaveError || 'Import could not be saved. Your current configuration is unchanged.',
        'error'
      );
      return;
    }
    renderUI();
    showNotification('Configuration imported.');
  } catch (error) {
    console.error('Importing configuration:', error);
    showNotification(error.message || 'Could not import this file.', 'error');
  }
}

function validateConfig(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.systemPrompts)
  )
    return false;
  const uniqueIds = (items) => new Set(items.map((item) => item.id)).size === items.length;
  const validText = (text) => typeof text === 'string' && Boolean(text.trim());
  const providersValid = value.providers.every((provider) => {
    if (
      !provider ||
      !validText(provider.id) ||
      !validText(provider.name) ||
      typeof provider.apiKey !== 'string' ||
      !Array.isArray(provider.models) ||
      !provider.models.length
    )
      return false;
    try {
      const url = new URL(provider.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return false;
    } catch {
      return false;
    }
    return (
      (!provider.apiType || ['chat', 'responses'].includes(provider.apiType)) &&
      uniqueIds(provider.models) &&
      provider.models.every((model) => model && validText(model.id) && validText(model.name))
    );
  });
  const promptsValid = value.systemPrompts.every(
    (prompt) =>
      prompt && validText(prompt.id) && validText(prompt.name) && typeof prompt.content === 'string'
  );
  return (
    providersValid &&
    promptsValid &&
    uniqueIds(value.providers) &&
    uniqueIds(value.systemPrompts) &&
    (value.temperature == null ||
      value.temperature === '' ||
      (typeof value.temperature === 'number' &&
        value.temperature >= 0 &&
        value.temperature <= 2)) &&
    (value.max_completion_tokens == null ||
      value.max_completion_tokens === '' ||
      (typeof value.max_completion_tokens === 'string' &&
        /^[1-9]\d*$/.test(value.max_completion_tokens) &&
        Number.isSafeInteger(Number(value.max_completion_tokens)))) &&
    (value.stream == null || typeof value.stream === 'boolean') &&
    (!value.theme || ['light', 'dark', 'system'].includes(value.theme)) &&
    (!value.fontSize || ['13px', '14px', '15px', '16px'].includes(value.fontSize)) &&
    (!value.fontFamily || typeof value.fontFamily === 'string') &&
    (!value.reasoning_effort ||
      ['minimal', 'low', 'medium', 'high'].includes(value.reasoning_effort)) &&
    (!value.reasoning_summary ||
      ['off', 'auto', 'concise', 'detailed'].includes(value.reasoning_summary))
  );
}

// ===== Provider permissions and notifications =====
async function ensureBackendPermission(backendUrl) {
  try {
    const origins = [new URL(backendUrl).origin + '/*'];
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch (error) {
    console.error('Provider permission:', error);
    return false;
  }
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  elements.notifications.replaceChildren(notification);
  setTimeout(() => notification.remove(), 6000);
}
