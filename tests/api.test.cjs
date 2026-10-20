const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function loadScript(file, globals = {}) {
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: { addEventListener() {} },
    URL, AbortController, DOMException, TextDecoder, TextEncoder, setTimeout, clearTimeout, structuredClone, crypto: require('node:crypto'),
    ...globals
  });
  vm.runInContext(readFileSync(resolve(__dirname, '..', 'sidebar/marked.umd.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(__dirname, '..', 'assets/js/ui.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(__dirname, '..', file), 'utf8'), context);
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sidebar() {
  const context = loadScript('sidebar/sidebar.js');
  vm.runInContext(`
    scheduleMessageDisplay = () => {};
    updateMessageDisplay = () => {};
    globalThis.errors = [];
    showError = text => errors.push(text);
    globalThis.app = {
      state, getAdapter, buildChatRequestBody, buildResponsesRequestBody,
      buildEndpointUrl, streamResponse, processStream, processNonStream,
      applyChatStreamEvent, applyResponsesStreamEvent, applyResponsesResponse,
      createRequestWatchdog, responseCompletionNotice, processThinkTags,
      parseModelKey, displayParts, titleFromContent
    };
  `, context);
  const { app } = context;
  app.state.currentSessionId = 'session';
  app.state.sessions.session = { messages: [
    { id: 'user', role: 'user', content: '你好' },
    { id: 'answer', role: 'assistant', content: 'Hello' },
    { id: 'notice', role: 'system', content: 'Local error' },
    { id: 'followup', role: 'user', content: 'Continue' }
  ] };
  app.state.config.selectedModel = 'test-model - provider';
  app.state.config.temperature = null;
  app.state.currentStreamingMessage = { id: 'pending', role: 'assistant', content: '' };
  app.state.sessions.session.messages.push(app.state.currentStreamingMessage);
  return context;
}

function sseResponse(events, { crlf = false, multiline = false } = {}) {
  const newline = crlf ? '\r\n' : '\n';
  const source = events.map(event => {
    const json = JSON.stringify(event, null, multiline ? 2 : undefined);
    return `: heartbeat${newline}event: ${event.type || 'message'}${newline}` +
      json.split('\n').map(line => `data: ${line}`).join(newline) + newline + newline;
  }).join('') + `data: [DONE]${newline}${newline}`;
  const bytes = new TextEncoder().encode(source);
  // One byte per chunk exercises UTF-8, CRLF, JSON and event boundary splits.
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(index, ++index));
    }
  }));
}

function output(text = '完整回答') {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'First' }, { type: 'summary_text', text: 'Second' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
    ],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 3 } }
  };
}

test('legacy providers default to Chat Completions; Responses is opt-in', () => {
  const { app } = sidebar();
  assert.equal(app.getAdapter({}).endpoint, '/chat/completions');
  assert.equal(app.getAdapter({ apiType: 'unknown' }).endpoint, '/chat/completions');
  assert.equal(app.getAdapter({ apiType: 'responses' }).endpoint, '/responses');
});

test('request bodies map history, instructions and parameters for each API', () => {
  const { app } = sidebar();
  const history = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Continue' }
  ];
  assert.deepEqual(plain(app.buildResponsesRequestBody()), {
    model: 'test-model', input: history, instructions: 'You are a helpful assistant.', stream: true, store: false
  });
  Object.assign(app.state.config, {
    temperature: 0, max_completion_tokens: '123', reasoning_effort: 'low', reasoning_summary: 'auto', stream: false
  });
  assert.deepEqual(plain(app.buildResponsesRequestBody()), {
    model: 'test-model', input: history, instructions: 'You are a helpful assistant.',
    stream: false, store: false, temperature: 0, max_output_tokens: 123,
    reasoning: { effort: 'low', summary: 'auto' }
  });
  assert.deepEqual(plain(app.buildChatRequestBody()), {
    model: 'test-model', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, ...history],
    stream: false, temperature: 0, max_completion_tokens: 123, reasoning_effort: 'low'
  });
});

test('optional parameters and empty instructions are omitted', () => {
  const { app } = sidebar();
  Object.assign(app.state.config, { temperature: '', max_completion_tokens: 'invalid', selectedSystemPrompt: 'missing' });
  const body = app.buildResponsesRequestBody();
  for (const key of ['instructions', 'temperature', 'max_output_tokens', 'reasoning']) {
    assert.equal(Object.hasOwn(body, key), false);
  }
});

test('switching API type does not duplicate a pasted endpoint', () => {
  const { app } = sidebar();
  for (const baseUrl of [' https://example.com/v1/ ', 'https://example.com/v1/chat/completions/', 'https://example.com/v1/responses///']) {
    assert.equal(app.buildEndpointUrl({ baseUrl }, '/responses'), 'https://example.com/v1/responses');
    assert.equal(app.buildEndpointUrl({ baseUrl }, '/chat/completions'), 'https://example.com/v1/chat/completions');
  }
});

for (const crlf of [false, true]) {
  test(`Responses SSE handles fragmented UTF-8, multiline data and ${crlf ? 'CRLF' : 'LF'}`, async () => {
    const { app } = sidebar();
    const message = { id: 'pending', content: '', reasoning: '' };
    const response = sseResponse([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'First' },
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Second' },
      { type: 'response.output_text.delta', delta: '部分回答' },
      { type: 'response.completed', response: output() }
    ], { crlf, multiline: true });
    await app.processStream(response, message, new AbortController().signal, app.getAdapter({ apiType: 'responses' }));
    assert.equal(message.content, '完整回答');
    assert.equal(message.reasoning, 'First\n\nSecond');
    assert.deepEqual(plain(message.usage), { input: 11, output: 7, total: 18, reasoning: 3 });
    assert.equal(response.body.locked, false);
  });
}

test('SSE accepts event type from framing and a missing final blank line', async () => {
  const { app } = sidebar();
  const message = { id: 'pending' };
  await app.processStream(new Response('event: response.output_text.delta\ndata: {"delta":"Hello"}'),
    message, new AbortController().signal, app.getAdapter({ apiType: 'responses' }));
  assert.equal(message.content, 'Hello');
});

test('Chat Completions streaming and usage remain compatible', async () => {
  const { app } = sidebar();
  const message = { id: 'pending' };
  await app.processStream(sseResponse([
    { choices: [{ delta: { reasoning_content: 'Think' } }] },
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
  ]), message, new AbortController().signal, app.getAdapter({}));
  assert.equal(message.content, 'Hello');
  assert.equal(message.reasoning, 'Think');
  assert.equal(message.usage.total, 6);
});

test('non-streaming Responses reads all text, refusals, summaries and usage', async () => {
  const { app } = sidebar();
  const data = output();
  data.output.push({ type: 'message', content: [{ type: 'refusal', refusal: 'Refused' }] });
  const message = {};
  await app.processNonStream(Response.json(data), message, new AbortController().signal, app.getAdapter({ apiType: 'responses' }));
  assert.equal(message.content, '完整回答Refused');
  assert.equal(message.reasoning, 'First\n\nSecond');
  assert.equal(message.usage.reasoning, 3);
  app.applyResponsesResponse({ output_text: 'Compatible server' }, message);
  assert.equal(message.content, 'Compatible server');
});

test('non-streaming Responses rejects payloads it cannot recognise', async () => {
  const { app } = sidebar();
  const adapter = app.getAdapter({ apiType: 'responses' });
  for (const data of [{}, { choices: [{ message: { content: 'Wrong API type' } }] }]) {
    await assert.rejects(
      app.processNonStream(Response.json(data), {}, new AbortController().signal, adapter),
      /no answer.*API type/
    );
  }
  const message = {};
  await app.processNonStream(Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), message, new AbortController().signal, adapter);
  assert.equal(message.incompleteReason, 'max_output_tokens');
});

test('think tags in code stay in the answer while real reasoning is extracted', () => {
  const { app } = sidebar();
  const code = 'Use:\n\n```html\n<think>literal example</think>\n```\n\nOr `<think>inline</think>`.';
  const kept = { content: code };
  app.processThinkTags(kept);
  assert.equal(kept.content, code);
  assert.equal(kept.reasoning, undefined);

  const mixed = { content: '<think>plan `x`</think>Answer\n```\n<thinking>demo</thinking>\n```' };
  app.processThinkTags(mixed);
  assert.equal(mixed.reasoning, 'plan `x`');
  assert.equal(mixed.content, 'Answer\n```\n<thinking>demo</thinking>\n```');

  const unclosed = { content: '```\n<think>never closed' };
  app.processThinkTags(unclosed);
  assert.equal(unclosed.content, '```\n<think>never closed');
});

test('think tags survive longer fences with nested fences and indented code', () => {
  const { app } = sidebar();
  const nested = 'Example:\n\n````md\n```html\n<think>literal example</think>\n```\n````\n\nDone.';
  const indented = 'Example:\n\n    <think>indented example</think>\n\nDone.';
  for (const content of [nested, indented]) {
    const message = { content };
    app.processThinkTags(message);
    assert.equal(message.content, content);
    assert.equal(message.reasoning, undefined);
  }
});

test('think tags stay in code inside tables, quotes and lists, but plain tags are still extracted', () => {
  const { app } = sidebar();
  const cases = [
    '| Tag |\n| --- |\n| `<think>literal example</think>` |',
    '> Quote:\n>\n> ```html\n> <think>literal example</think>\n> ```',
    '- Item:\n\n  ```html\n  <think>literal example</think>\n  ```',
    '1. Item\n\n       <think>literal example</think>'
  ];
  for (const content of cases) {
    const message = { content };
    app.processThinkTags(message);
    assert.equal(message.content, content);
    assert.equal(message.reasoning, undefined);
  }
  const message = { content: '<think>plan</think>Answer with `code` and\n\n| a |\n| - |\n| `<think>kept</think>` |' };
  app.processThinkTags(message);
  assert.equal(message.reasoning, 'plan');
  assert.equal(message.content, 'Answer with `code` and\n\n| a |\n| - |\n| `<think>kept</think>` |');
});

test('masking never confuses answer text containing NUL characters with code', () => {
  const { app } = sidebar();
  const content = 'Keep \u00000\u0000 literal `<think>code</think>` and \u0000\u0000 too.<think>plan</think>';
  const message = { content };
  app.processThinkTags(message);
  assert.equal(message.reasoning, 'plan');
  assert.equal(message.content, 'Keep \u00000\u0000 literal `<think>code</think>` and \u0000\u0000 too.');
});

test('removing think tags can never assemble a mask-like marker from answer text', () => {
  const { app } = sidebar();
  const message = { content: '`example`\n\n\u0000<think>a</think>\u00000\u0000<think>b</think>\u0000' };
  app.processThinkTags(message);
  assert.equal(message.content, '`example`\n\n\u0000\u00000\u0000\u0000');
  assert.equal(message.reasoning, 'a\n\nb');
});

test('CRLF answers still have plain think tags extracted and keep code examples', () => {
  const { app } = sidebar();
  const plain = { content: '<think>plan</think>\r\nAnswer' };
  app.processThinkTags(plain);
  assert.equal(plain.reasoning, 'plan');
  assert.equal(plain.content, 'Answer');

  const code = 'Use:\r\n\r\n```html\r\n<think>literal</think>\r\n```\r\n\r\n    <think>indented</think>\r\n';
  const mixed = { content: `<think>plan</think>${code}` };
  app.processThinkTags(mixed);
  assert.equal(mixed.reasoning, 'plan');
  assert.equal(mixed.content, code.trim());
});

test('refusal deltas are displayed', () => {
  const { app } = sidebar();
  const message = {};
  app.applyResponsesStreamEvent({ type: 'response.refusal.delta', delta: 'Refused' }, message);
  assert.equal(message.content, 'Refused');
});

test('API failures propagate and release the stream reader', async () => {
  const { app } = sidebar();
  const adapter = app.getAdapter({ apiType: 'responses' });
  for (const event of [
    { type: 'response.failed', response: { error: { message: 'Provider failed' } } },
    { type: 'error', message: 'Provider failed' },
    { error: { message: 'Provider failed' } }
  ]) {
    const response = sseResponse([event]);
    await assert.rejects(app.processStream(response, {}, new AbortController().signal, adapter), /Provider failed/);
    assert.equal(response.body.locked, false);
  }
  assert.throws(() => app.applyResponsesResponse({ status: 'failed', error: { message: 'Failed JSON' } }, {}), /Failed JSON/);
});

test('aborting an SSE request cancels the reader', async () => {
  const { app } = sidebar();
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(app.processStream(response, {}, controller.signal, app.getAdapter({ apiType: 'responses' })), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

for (const apiType of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    test(`${apiType} HTTP dispatch works with stream=${stream}`, async () => {
      const context = sidebar();
      const { app } = context;
      app.state.config.stream = stream;
      const provider = { apiType, baseUrl: 'https://example.com/v1', apiKey: 'test-key' };
      context.fetch = async (url, options) => {
        assert.equal(url, `https://example.com/v1/${apiType === 'chat' ? 'chat/completions' : 'responses'}`);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer test-key');
        assert.equal(JSON.parse(options.body).stream, stream);
        const data = apiType === 'chat' ? { choices: [{ message: { content: 'Answer' }, delta: { content: 'Answer' } }] } : output('Answer');
        return stream ? sseResponse([apiType === 'chat' ? data : { type: 'response.completed', response: data }]) : Response.json(data);
      };
      const message = { id: 'pending' };
      await app.streamResponse(provider, message, new AbortController().signal);
      assert.equal(message.content, 'Answer');
    });
  }
}

for (const stream of [false, true]) {
  test(`incomplete Responses preserves output and usage and explains the limit, stream=${stream}`, async () => {
    const context = sidebar();
    const { app } = context;
    app.state.config.stream = stream;
    const data = { ...output('Partial'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    context.fetch = async () => stream ? sseResponse([{ type: 'response.incomplete', response: data }]) : Response.json(data);
    const message = { id: 'pending' };
    await app.streamResponse({ apiType: 'responses', baseUrl: 'https://example.com/v1' }, message, new AbortController().signal);
    assert.equal(message.content, 'Partial');
    assert.equal(message.usage.total, 18);
    assert.equal(message.incompleteReason, 'max_output_tokens');
    assert.match(app.responseCompletionNotice(message), /Increase Max Completion Tokens/);
  });
}

test('provider API selection survives save, reload, edit and legacy configuration', async () => {
  let saved;
  const fields = { providerModalTitle: {} };
  const context = loadScript('options/options.js', {
    document: { addEventListener() {}, getElementById: id => fields[id] },
    chrome: {
      storage: { sync: { set: async value => { saved = structuredClone(value); }, get: async () => saved } },
      permissions: { contains: async () => true, request: async () => true }
    }
  });
  vm.runInContext(`
    showNotification = () => {};
    renderProviders = () => {};
    renderModelsList = () => {};
    openDialog = () => {};
    setDialogBusy = () => {};
    updateEndpointPreview = () => {};
    showDialogError = () => {};
    closeProviderModal = () => {};
    globalThis.app = { elements, saveProvider, loadConfig, openProviderModal, getConfig: () => config };
  `, context);
  const { app } = context;
  const value = value => ({ value });
  Object.assign(app.elements, {
    providerForm: { checkValidity: () => true, reset() {} },
    providerModal: { classList: { add() {}, remove() {} } },
    providerName: value('OpenAI'), providerBaseUrl: value('https://api.openai.com/v1/responses/'),
    providerApiKey: value('test-key'), providerApiType: value('responses'),
    toggleApiKey: { setAttribute() {} },
    connectionStatus: { dataset: {} }, modelSuggestions: { replaceChildren() {} },
    modelsList: { querySelectorAll: () => [{ querySelector: () => value('test-model') }] }
  });
  await app.saveProvider();
  assert.equal(saved.config.providers[0].apiType, 'responses');
  assert.equal(saved.config.providers[0].baseUrl, 'https://api.openai.com/v1');
  await app.loadConfig();
  app.openProviderModal(app.getConfig().providers[0]);
  assert.equal(app.elements.providerApiType.value, 'responses');
  app.elements.providerApiType.value = 'chat';
  await app.saveProvider();
  assert.equal(saved.config.providers.length, 1);
  assert.equal(saved.config.providers[0].apiType, 'chat');
  const legacy = { ...saved.config.providers[0] };
  delete legacy.apiType;
  app.openProviderModal(legacy);
  assert.equal(app.elements.providerApiType.value, 'chat');
  app.openProviderModal();
  assert.equal(app.elements.providerApiType.value, 'chat');
});

test('Chat output limits are preserved in streaming and complete responses', async () => {
  for (const stream of [false, true]) {
    const context = sidebar();
    const { app } = context;
    app.state.config.stream = stream;
    const choice = { delta: { content: 'Partial' }, message: { content: 'Partial' }, finish_reason: 'length' };
    context.fetch = async () => stream ? sseResponse([{ choices: [choice] }]) : Response.json({ choices: [choice] });
    const message = { id: 'pending' };
    await app.streamResponse({ baseUrl: 'https://example.com/v1' }, message, new AbortController().signal);
    assert.equal(message.content, 'Partial');
    assert.equal(message.incompleteReason, 'max_output_tokens');
    assert.match(app.responseCompletionNotice(message), /partial response/);
  }
});

test('EOF without a completion marker is distinguished from a confirmed answer', async () => {
  const { app } = sidebar();
  for (const apiType of ['chat', 'responses']) {
    const event = apiType === 'chat'
      ? { choices: [{ delta: { content: 'Partial' } }] }
      : { type: 'response.output_text.delta', delta: 'Partial' };
    const message = {};
    await app.processStream(new Response(`data: ${JSON.stringify(event)}\n\n`), message,
      new AbortController().signal, app.getAdapter({ apiType }));
    assert.equal(message.content, 'Partial');
    assert.equal(message.completionUnconfirmed, true);
    assert.match(app.responseCompletionNotice(message), /not confirmed/);
  }
});

test('terminal events release an HTTP stream that stays open', async () => {
  const { app } = sidebar();
  for (const apiType of ['chat', 'responses']) {
    let cancelled = false;
    const terminal = apiType === 'chat' ? '[DONE]' : JSON.stringify({ type: 'response.completed', response: output() });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${terminal}\n\n`)); },
      cancel() { cancelled = true; }
    }));
    const message = {};
    await app.processStream(response, message, new AbortController().signal, app.getAdapter({ apiType }));
    assert.equal(cancelled, true);
    assert.equal(message.streamComplete, true);
    assert.equal(message.completionUnconfirmed, undefined);
    assert.equal(response.body.locked, false);
  }
});

function fakeWatchdogTimers(context) {
  const timers = new Map();
  let id = 0;
  context.setTimeout = (callback) => { timers.set(++id, callback); return id; };
  context.clearTimeout = (timer) => timers.delete(timer);
  return {
    expire() { assert.equal(timers.size, 1); [...timers.values()][0](); },
    get size() { return timers.size; }
  };
}

test('a stalled request times out without becoming a user cancellation', async () => {
  const context = sidebar();
  const timers = fakeWatchdogTimers(context);
  let requestSignal;
  context.fetch = (_, { signal }) => {
    requestSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const user = new AbortController();
  const result = context.app.streamResponse({ baseUrl: 'https://example.com/v1' }, {}, user.signal);
  timers.expire();
  await assert.rejects(result, { name: 'TimeoutError' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(user.signal.aborted, false);
  assert.equal(timers.size, 0);
});

test('a stream stalled after headers keeps its partial answer on timeout', async () => {
  const context = sidebar();
  const timers = fakeWatchdogTimers(context);
  context.fetch = async (_, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    }
  }));
  const message = {};
  const result = context.app.streamResponse({ baseUrl: 'https://example.com/v1' }, message, new AbortController().signal);
  await new Promise(setImmediate);
  assert.equal(message.content, 'Partial');
  timers.expire();
  await assert.rejects(result, { name: 'TimeoutError' });
  assert.equal(message.content, 'Partial');
  assert.equal(timers.size, 0);
});

test('watchdog resets on progress and releases timers on user stop', () => {
  const context = sidebar();
  const timers = fakeWatchdogTimers(context);
  const user = new AbortController();
  const watchdog = context.app.createRequestWatchdog(user.signal);
  watchdog.touch();
  watchdog.touch();
  assert.equal(timers.size, 1);
  user.abort();
  assert.equal(watchdog.signal.reason.name, 'AbortError');
  watchdog.dispose();
  assert.equal(timers.size, 0);
});

// chrome.storage hands back what it stored, not what it was given: it is JSON,
// and objects come back with their keys in alphabetical order. A fixture that
// returned a clone would hide every bug that depends on this.
function stored(value) {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item));
}

// A page of the sidebar on top of a storage area; pages given the same `data`
// share it, like two side panels do.
function storageContext(data = {}) {
  const context = sidebar();
  const hooks = { afterGet: null, failRemove: 0, writes: [], removals: [] };
  context.chrome = {
    storage: {
      local: {
        async get(keys) {
          const all = stored(data);
          const value = keys == null ? all : Object.fromEntries([].concat(keys).filter(key => key in all).map(key => [key, all[key]]));
          await hooks.afterGet?.(value);
          return value;
        },
        async set(values) { hooks.writes.push(Object.keys(values)); Object.assign(data, stored(values)); },
        async remove(keys) {
          if (hooks.failRemove > 0) { hooks.failRemove -= 1; throw new Error('remove failed'); }
          hooks.removals.push([].concat(keys));
          [].concat(keys).forEach(key => delete data[key]);
        }
      }
    }
  };
  vm.runInContext(`
    renderMessages = () => { globalThis.rendered = (globalThis.rendered || 0) + 1; };
    renderChatHistory = () => {};
    globalThis.resaves = 0;
    debouncedSave = () => { resaves += 1; };
    state.sessions = {}; state.currentSessionId = null; state.drafts = {}; state.currentStreamingMessage = null;
    rememberSaved({}, {}, {}, null);
    globalThis.store = {
      writeLocalChanges, stashChangesOnUnload, applyChanges, mergeSession, mergeCopyFamilies, handleStoredChanges,
      canonicalJSON, sameValue, state,
      ready: () => { storageReady = true; },
      baseline: id => ({ json: savedSessions[id], rev: savedRevs[id] }),
      repaired: () => repairedChats
    };
  `, context);
  return { store: context.store, context, data, hooks };
}

const chat = (messages, title = 'T') => ({ title, timestamp: '2026-01-01T00:00:00.000Z', messages });
const msg = (id, content, extra = {}) => ({ id, role: id.startsWith('a') ? 'assistant' : 'user', content, ...extra });
const sessionKeys = data => Object.keys(data).filter(key => key.startsWith('session:')).sort();
const pendingKeys = data => Object.keys(data).filter(key => key.startsWith('pending:') || key.startsWith('pendingSave:'));
const scan = store => store.writeLocalChanges(true, { scanAll: true });

test('streaming a reply and saving it again and again writes one chat', async () => {
  // Regression: every save used to see the chat it had just written (keys
  // reordered by the storage) as another page's edit and made a "(conflicting
  // copy)" of the growing reply, and then of that copy.
  const { store, data } = storageContext();
  store.state.sessions.c = chat([msg('u1', 'hello'), msg('a1', '', { reasoning: null, startedAt: 1 })]);
  store.state.currentSessionId = 'c';
  await store.writeLocalChanges(true);
  const reply = store.state.sessions.c.messages[1];
  for (const part of ['One', ' two', ' three', ' four', ' five']) {
    reply.content += part;
    await store.writeLocalChanges(true);
  }
  assert.deepEqual(sessionKeys(data), ['session:c']);
  assert.equal(data['session:c'].session.messages[1].content, 'One two three four five');
  assert.equal(data['session:c'].session.title, 'T');
  assert.equal(store.state.sessions.c.messages[1], reply, 'the live message is still the one being streamed into');
  assert.equal(data.currentSessionId, 'c');
});

test('a save that changes nothing writes nothing', async () => {
  const { store, hooks } = storageContext();
  store.state.sessions.c = chat([msg('u1', 'hello')]);
  await store.writeLocalChanges(true);
  const writes = hooks.writes.length;
  await store.writeLocalChanges(true);
  await store.writeLocalChanges(false);
  assert.equal(hooks.writes.length, writes);
});

test('a save reads and writes only the chats it changed', async () => {
  const { store, data, hooks } = storageContext();
  for (const id of ['a', 'b', 'c']) store.state.sessions[id] = chat([msg('u1', id)]);
  await store.writeLocalChanges(true);
  store.state.sessions.b.messages.push(msg('u2', 'more'));
  hooks.writes.length = 0;
  let read;
  hooks.afterGet = value => { read = Object.keys(value).sort(); };
  await store.writeLocalChanges(true);
  assert.deepEqual(read, ['session:b']);
  assert.deepEqual(hooks.writes, [['session:b']]);
  assert.equal(data['session:b'].session.messages.length, 2);
});

test('values compare by content, not by key order or undefined fields', () => {
  const { store } = storageContext();
  assert.equal(store.sameValue({ a: 1, b: undefined, c: { x: 1, y: [1, { p: 1, q: 2 }] } }, { c: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 }), true);
  assert.equal(store.sameValue({ a: 1 }, { a: 2 }), false);
  assert.equal(store.sameValue(msg('u1', 'x'), undefined), false);
  assert.equal(store.sameValue(undefined, undefined), true);
});

test('merging keeps messages added by either page and prefers this page\'s version of a contested one', () => {
  const { store } = storageContext();
  const base = chat([msg('u1', 'q'), msg('a1', 'answer')]);
  const mine = chat([msg('u1', 'q'), msg('a1', 'answer, edited here'), msg('u2', 'mine')]);
  const theirs = chat([msg('u1', 'q'), msg('a1', 'answer, edited there'), msg('u3', 'theirs')], 'Renamed there');
  const merged = store.mergeSession(base, mine, theirs);
  assert.deepEqual(plain(merged.messages.map(m => m.id)), ['u1', 'a1', 'u3', 'u2']);
  assert.equal(merged.messages[1].content, 'answer, edited here');
  assert.equal(merged.title, 'Renamed there', 'a field only the other page changed is theirs');
});

test('merging respects removals nobody contests, and mine wins over a contested one', () => {
  const { store } = storageContext();
  const base = chat([msg('u1', 'q'), msg('a1', 'answer'), msg('u2', 'next')]);
  const mine = chat([msg('u1', 'q'), msg('u2', 'next, edited')]); // removed a1, edited u2
  const theirs = chat([msg('u1', 'q'), msg('u2', 'next')]); // removed a1 too
  assert.deepEqual(plain(store.mergeSession(base, mine, theirs).messages.map(m => m.id)), ['u1', 'u2']);
  const theirsEdited = chat([msg('u1', 'q'), msg('a1', 'answer, edited there'), msg('u2', 'next')]);
  assert.deepEqual(plain(store.mergeSession(base, mine, theirsEdited).messages.map(m => m.id)), ['u1', 'u2'], 'my removal is the later write');
  const theirsRemoved = chat([msg('u1', 'q'), msg('a1', 'answer')]); // removed u2, I edited it
  assert.equal(store.mergeSession(base, mine, theirsRemoved).messages.at(-1).content, 'next, edited');
});

test('a stored message equal to mine stays my object whatever order its keys are in', () => {
  const { store } = storageContext();
  const live = msg('a1', 'streaming', { startedAt: 1, reasoning: null });
  const mine = chat([live]);
  const theirs = chat([stored(live)]);
  assert.equal(store.mergeSession(chat([]), mine, theirs).messages[0], live);
});

test('a write over the rev this page last saw needs no merge; a stale rev merges', () => {
  const { store } = storageContext();
  const tables = rev => ({ sessions: { c: { rev, session: chat([msg('u1', 'q'), msg('u2', 'from the other page')]) } }, drafts: {} });
  const change = baseRev => ({
    sessions: { c: { base: JSON.stringify(chat([msg('u1', 'q')])), baseRev, mine: chat([msg('u1', 'q edited')]) } },
    removed: {}, drafts: {}
  });
  const fresh = store.applyChanges(tables('r1'), change('r1'));
  assert.deepEqual(plain(fresh.sessions.c.session.messages.map(m => m.content)), ['q edited'], 'rev matches: mine replaces the stored chat');
  const stale = store.applyChanges(tables('r2'), change('r1'));
  assert.deepEqual(plain(stale.sessions.c.session.messages.map(m => m.content)), ['q edited', 'from the other page']);
  assert.notEqual(stale.sessions.c.rev, 'r2');
  assert.deepEqual([...stale.touched], ['c']);
});

test('a merge that adds nothing to the stored chat does not write it again', () => {
  const { store } = storageContext();
  const session = chat([msg('u1', 'q'), msg('a1', 'answer')]);
  const result = store.applyChanges(
    { sessions: { c: { rev: 'r2', session } }, drafts: {} },
    { sessions: { c: { base: JSON.stringify(chat([msg('u1', 'q')])), baseRev: 'r1', mine: stored(session) } }, removed: {}, drafts: {} }
  );
  assert.equal(result.sessions.c.rev, 'r2');
  assert.equal(result.touched.size, 0);
});

test('a chat is removed only if nobody changed it since this page saw it', () => {
  const { store } = storageContext();
  const tables = { sessions: { a: { rev: 'r1', session: chat([]) }, b: { rev: 'r9', session: chat([]) } }, drafts: {} };
  const result = store.applyChanges(tables, { sessions: {}, removed: { a: { rev: 'r1' }, b: { rev: 'r2' } }, drafts: {} });
  assert.deepEqual(Object.keys(result.sessions), ['b']);
});

test('two pages adding to one chat keep both, and each follows the other', async () => {
  const data = {};
  const first = storageContext(data);
  first.store.state.sessions.c = chat([msg('u1', 'q')]);
  await first.store.writeLocalChanges(true);
  const second = storageContext(data);
  await scan(second.store);
  // the second page loads the chat like loadFromStorage does
  vm.runInContext(`state.sessions.c = ${JSON.stringify(data['session:c'].session)}; rememberSaved(state.sessions, { c: ${JSON.stringify(data['session:c'].rev)} }, {}, null);`, second.context);

  first.store.state.sessions.c.messages.push(msg('a1', 'from first'));
  second.store.state.sessions.c.messages.push(msg('u2', 'from second'));
  await first.store.writeLocalChanges(true);
  await second.store.writeLocalChanges(true);

  const ids = session => plain(session.messages.map(m => m.id));
  assert.deepEqual(ids(data['session:c'].session), ['u1', 'a1', 'u2']);
  assert.deepEqual(sessionKeys(data), ['session:c']);
  assert.deepEqual(ids(second.store.state.sessions.c), ['u1', 'a1', 'u2'], 'the saving page takes over what it merged in');
  assert.equal(second.store.baseline('c').rev, data['session:c'].rev);
  assert.equal(second.context.resaves, 0);
});

test('a chat changed again while its save was in flight keeps its changes and is saved once more', async () => {
  const data = {};
  const first = storageContext(data);
  first.store.state.sessions.c = chat([msg('u1', 'q')]);
  await first.store.writeLocalChanges(true);
  const second = storageContext(data);
  vm.runInContext(`state.sessions.c = ${JSON.stringify(data['session:c'].session)}; rememberSaved(state.sessions, { c: ${JSON.stringify(data['session:c'].rev)} }, {}, null);`, second.context);
  first.store.state.sessions.c.messages.push(msg('a1', 'from first'));
  await first.store.writeLocalChanges(true);

  second.store.state.sessions.c.messages.push(msg('u2', 'from second'));
  const streaming = second.store.state.sessions.c.messages[1];
  second.hooks.afterGet = () => { streaming.content = 'typed while saving'; };
  await second.store.writeLocalChanges(true);
  second.hooks.afterGet = null;
  assert.equal(second.context.resaves, 1);
  assert.deepEqual(plain(second.store.state.sessions.c.messages.map(m => m.content)), ['q', 'typed while saving']);
  await second.store.writeLocalChanges(true);
  assert.deepEqual(plain(data['session:c'].session.messages.map(m => m.content)), ['q', 'from first', 'typed while saving']);
  assert.deepEqual(plain(second.store.state.sessions.c.messages.map(m => m.content)), ['q', 'from first', 'typed while saving']);
  assert.equal(second.context.resaves, 1, 'settled after the second merge');
});

test('stored changes made elsewhere are adopted unless this page has unsaved changes', async () => {
  const data = {};
  const first = storageContext(data);
  first.store.ready();
  first.store.state.sessions.c = chat([msg('u1', 'q')]);
  first.store.state.sessions.d = chat([msg('u1', 'other chat')]);
  await first.store.writeLocalChanges(true);
  const entry = (rev, messages) => ({ newValue: { rev, session: chat(messages) } });
  const live = first.store.state.sessions.c;

  first.store.handleStoredChanges({ 'session:c': entry(first.store.baseline('c').rev, [msg('u1', 'ignored: own write')]) });
  assert.equal(live.messages.length, 1);

  first.store.handleStoredChanges({ 'session:c': entry('r-other', [msg('u1', 'q'), msg('a1', 'from elsewhere')]) });
  assert.equal(first.store.state.sessions.c, live, 'adopted in place');
  assert.deepEqual(plain(live.messages.map(m => m.id)), ['u1', 'a1']);
  assert.equal(first.store.baseline('c').rev, 'r-other');
  const writes = first.hooks.writes.length;
  await first.store.writeLocalChanges(true);
  assert.equal(first.hooks.writes.length, writes, 'adopting is not a change to save');

  live.messages.push(msg('u2', 'typed here'));
  first.store.handleStoredChanges({ 'session:c': entry('r-later', [msg('u1', 'q'), msg('a1', 'from elsewhere'), msg('a2', 'newer')]) });
  assert.deepEqual(plain(live.messages.map(m => m.id)), ['u1', 'a1', 'u2'], 'left for the merge on the next save');

  first.store.handleStoredChanges({ 'session:new': entry('r-new', [msg('u1', 'a chat from another panel')]) });
  assert.equal(first.store.state.sessions.new.messages[0].content, 'a chat from another panel');
  first.store.handleStoredChanges({ 'session:d': {} });
  assert.equal('d' in first.store.state.sessions, false, 'removed elsewhere');
});

test('a chat that is open here stays when it is removed elsewhere, and comes back with the next change', async () => {
  const { store, data } = storageContext();
  store.ready();
  store.state.sessions.c = chat([msg('u1', 'q')]);
  store.state.currentSessionId = 'c';
  await store.writeLocalChanges(true);
  delete data['session:c'];
  store.handleStoredChanges({ 'session:c': {} });
  assert.equal('c' in store.state.sessions, true);
  store.state.sessions.c.messages.push(msg('u2', 'still here'));
  await store.writeLocalChanges(true);
  assert.equal(data['session:c'].session.messages.length, 2);
});

test('a deletion goes out with the rev it saw; undo writes the chat again', async () => {
  const { store, data } = storageContext();
  store.state.sessions.c = chat([msg('u1', 'q')]);
  await store.writeLocalChanges(true);
  const removed = store.state.sessions.c;
  delete store.state.sessions.c;
  await store.writeLocalChanges(true);
  assert.deepEqual(sessionKeys(data), []);
  store.state.sessions.c = removed;
  await store.writeLocalChanges(true);
  assert.deepEqual(sessionKeys(data), ['session:c']);
});

test('a chat another page changed meanwhile survives this page deleting it', async () => {
  const data = {};
  const first = storageContext(data);
  first.store.state.sessions.c = chat([msg('u1', 'q')]);
  await first.store.writeLocalChanges(true);
  const second = storageContext(data);
  vm.runInContext(`state.sessions.c = ${JSON.stringify(data['session:c'].session)}; rememberSaved(state.sessions, { c: ${JSON.stringify(data['session:c'].rev)} }, {}, null);`, second.context);
  first.store.state.sessions.c.messages.push(msg('a1', 'new reply'));
  await first.store.writeLocalChanges(true);
  delete second.store.state.sessions.c;
  await second.store.writeLocalChanges(true);
  assert.equal(data['session:c'].session.messages.length, 2);
});

test('drafts and the selected chat are last writer wins', async () => {
  const { store, data } = storageContext();
  store.state.sessions.c = chat([]);
  store.state.currentSessionId = 'c';
  store.state.drafts.c = 'first';
  await store.writeLocalChanges(true);
  data.drafts = { c: 'written by another page', other: 'kept' };
  store.state.drafts.c = 'second';
  await store.writeLocalChanges(false);
  assert.deepEqual(data.drafts, { c: 'second', other: 'kept' });
  delete store.state.drafts.c;
  await store.writeLocalChanges(false);
  assert.deepEqual(data.drafts, { other: 'kept' });
});

// ---- stashes written by closing pages ----

test('a closing page stashes its changes under a key of its own and the next scan folds them in once', async () => {
  const { store, data, hooks } = storageContext();
  store.state.sessions.c = chat([msg('u1', 'q')]);
  store.state.drafts.c = 'unsent';
  store.stashChangesOnUnload();
  assert.equal(pendingKeys(data).length, 1);
  assert.deepEqual(sessionKeys(data), [], 'a stash never touches the shared tables');
  store.state.sessions = {};
  store.state.drafts = {};
  await scan(store);
  assert.equal(data['session:c'].session.messages[0].content, 'q');
  assert.equal(data.drafts.c, 'unsent');
  assert.deepEqual(pendingKeys(data), []);
  assert.equal('appliedPending' in data, false);
  assert.ok(hooks.writes.length > 0);
});

test('a stash recorded as applied is only removed, never replayed over newer edits', async () => {
  const { store, data, hooks } = storageContext();
  store.state.drafts.chat = 'stashed draft';
  store.stashChangesOnUnload();
  const [key] = pendingKeys(data);
  hooks.failRemove = 1;
  await assert.rejects(scan(store));
  assert.equal(data.drafts.chat, 'stashed draft');
  assert.deepEqual(Object.keys(data.appliedPending), [key]);
  data.drafts.chat = 'newer draft';
  store.state.drafts = { chat: 'newer draft' };
  await scan(store);
  assert.equal(data.drafts.chat, 'newer draft');
  assert.deepEqual(pendingKeys(data), []);
  assert.equal('appliedPending' in data, false);
});

test('a newer stash of the same page is applied even if an earlier one is already folded in', async () => {
  const { store, data, hooks } = storageContext();
  store.state.drafts.chat = 'first';
  store.stashChangesOnUnload();
  hooks.failRemove = 1;
  await assert.rejects(scan(store));
  store.state.drafts.chat = 'second';
  store.stashChangesOnUnload();
  assert.equal(pendingKeys(data).length, 2);
  await scan(store);
  assert.equal(data.drafts.chat, 'second');
  assert.deepEqual(pendingKeys(data), []);
});

test('re-stashing identical content reuses the key, so repeated pagehide stays one changeset', () => {
  const { store, data } = storageContext();
  store.state.drafts.chat = 'same';
  store.stashChangesOnUnload();
  store.stashChangesOnUnload();
  assert.equal(pendingKeys(data).length, 1);
});

test('a stash written after a scan read its snapshot is not removed by that scan', async () => {
  const { store, data, hooks } = storageContext();
  store.state.drafts.chat = 'earlier pending';
  store.stashChangesOnUnload();
  let released = false;
  hooks.afterGet = async () => {
    if (released) return;
    released = true;
    store.state.drafts.chat = 'latest pending';
    store.stashChangesOnUnload();
  };
  store.state.drafts = {};
  await scan(store);
  assert.equal(pendingKeys(data).length, 1, 'newer stash must survive the earlier scan');
  hooks.afterGet = null;
  store.state.drafts = {};
  await scan(store);
  assert.equal(data.drafts.chat, 'latest pending');
  assert.deepEqual(pendingKeys(data), []);
});

test('stashes fold oldest first, by their clock, not by key or return order', async () => {
  const { store, data } = storageContext();
  const stash = (page, at, text) => ({ sessions: {}, removed: {}, drafts: { chat: text }, order: { at, page, n: 1 } });
  data['pending:a'] = stash('page-z', 2000, 'newer, page z');
  data['pending:b'] = stash('page-a', 1000, 'older, page a');
  await scan(store);
  assert.equal(data.drafts.chat, 'newer, page z');
  assert.deepEqual(pendingKeys(data), []);
});

test('a stash from a page that closed before another saved merges into that page\'s chat', async () => {
  const data = {};
  const closing = storageContext(data);
  closing.store.state.sessions.c = chat([msg('u1', 'q')]);
  await closing.store.writeLocalChanges(true);
  closing.store.state.sessions.c.messages.push(msg('a1', 'typed just before closing'));
  closing.store.stashChangesOnUnload();
  const other = storageContext(data);
  vm.runInContext(`state.sessions.c = ${JSON.stringify(data['session:c'].session)}; rememberSaved(state.sessions, { c: ${JSON.stringify(data['session:c'].rev)} }, {}, null);`, other.context);
  other.store.state.sessions.c.messages.push(msg('u2', 'from the open page'));
  await scan(other.store);
  assert.deepEqual(plain(other.store.state.sessions.c.messages.map(m => m.id)), ['u1', 'a1', 'u2']);
  assert.deepEqual(plain(data['session:c'].session.messages.map(m => m.id)), ['u1', 'a1', 'u2']);
  assert.deepEqual(pendingKeys(data), []);
});

// ---- chats written by earlier builds ----

const growing = (...contents) => chat([msg('u1', 'question'), msg('a1', contents[0])].map((m, i) => i ? { ...m, content: contents[0] } : m));
const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

test('the one-table layout becomes one key per chat, with a backup of the old table', async () => {
  const { store, data } = storageContext();
  const old = { x: chat([msg('u1', 'one')], 'One'), y: chat([msg('u1', 'two')], 'Two') };
  data.sessions = stored(old);
  data.currentSessionId = 'y';
  data.drafts = { x: 'draft' };
  await scan(store);
  assert.deepEqual(sessionKeys(data), ['session:x', 'session:y']);
  assert.deepEqual(data['backup:sessions-v1'], stored(old));
  assert.equal('sessions' in data, false);
  assert.equal(data.currentSessionId, 'y');
  assert.deepEqual(data.drafts, { x: 'draft' });
  const writes = storageContext(data).hooks.writes;
  const again = storageContext(data);
  await scan(again.store);
  assert.deepEqual(again.hooks.writes, [], 'converted storage is left alone');
  assert.equal(writes.length, 0);
});

test('copies made by the streaming bug fold back into their chat', async () => {
  const { store, data } = storageContext();
  const [n1, n2, n3] = UUIDS;
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const copy1 = `conflict-${root}-${n1}`;
  const copy2 = `conflict-${copy1}-${n2}`;
  const copy3 = `conflict-${copy2}-${n3}`;
  const suffix = ' (conflicting copy)';
  const reply = content => chat([msg('u1', 'question'), msg('a1', content, { startedAt: 1 })], 'question');
  data.sessions = stored({
    [root]: reply(''),
    [copy1]: { ...reply('Hello'), title: `question${suffix}` },
    [copy2]: { ...reply('Hello there'), title: `question${suffix}${suffix}` },
    [copy3]: { ...reply('Hello there, friend.'), title: `question${suffix}${suffix}${suffix}` },
    other: chat([msg('u1', 'unrelated')], 'Unrelated')
  });
  data.currentSessionId = copy3;
  data.drafts = { [copy2]: 'half-typed' };
  await scan(store);
  assert.deepEqual(sessionKeys(data), [`session:${root}`, 'session:other'].sort());
  const merged = data[`session:${root}`].session;
  assert.equal(merged.title, 'question');
  assert.equal(merged.messages[1].content, 'Hello there, friend.');
  assert.equal(data.currentSessionId, root);
  assert.deepEqual(data.drafts, { [root]: 'half-typed' });
  assert.equal(store.repaired(), 3);
  assert.equal(Object.keys(data['backup:sessions-v1']).length, 5, 'the old table is kept as it was');
});

test('copies that really differ are kept, only their stacked titles are shortened', async () => {
  const { store, data } = storageContext();
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const copy = `conflict-${root}-${UUIDS[0]}`;
  const suffix = ' (conflicting copy)';
  data.sessions = stored({
    [root]: chat([msg('u1', 'my first wording')], 'T'),
    [copy]: chat([msg('u1', 'someone else\'s wording')], `T${suffix}${suffix}`)
  });
  await scan(store);
  assert.equal(data[`session:${root}`].session.messages[0].content, 'my first wording');
  assert.equal(data[`session:${copy}`].session.messages[0].content, 'someone else\'s wording');
  assert.equal(data[`session:${copy}`].session.title, `T${suffix}`);
  assert.equal(store.repaired(), 0);
});

test('legacy stashes are folded in, with their removals compared by content', async () => {
  const { store, data } = storageContext();
  data.sessions = stored({ keep: chat([msg('u1', 'kept')]), drop: chat([msg('u1', 'dropped')]), changed: chat([msg('u1', 'new text')]) });
  const legacy = {
    sessions: { added: { base: null, mine: chat([msg('u1', 'added in a stash')]), copyNonce: UUIDS[0], draft: null, current: false } },
    removed: { drop: JSON.stringify(chat([msg('u1', 'dropped')])), changed: JSON.stringify(chat([msg('u1', 'old text')])) },
    drafts: { keep: 'draft from a stash' }
  };
  data['pendingSave:1'] = legacy;
  await scan(store);
  assert.deepEqual(sessionKeys(data), ['session:added', 'session:changed', 'session:keep']);
  assert.equal(data.drafts.keep, 'draft from a stash');
  assert.deepEqual(pendingKeys(data), []);
});

test('a legacy stash that an older build recorded as applied is only removed', async () => {
  const { store, data } = storageContext();
  data.sessions = stored({ c: chat([msg('u1', 'q')]) });
  data.drafts = { chat: 'newer draft' };
  data['pendingSave:old'] = { sessions: {}, removed: {}, drafts: { chat: 'already folded in' } };
  data.appliedPending = { 'pendingSave:old': { nonce: 'n' } };
  await scan(store);
  assert.equal(data.drafts.chat, 'newer draft');
  assert.deepEqual(pendingKeys(data), []);
  assert.equal('appliedPending' in data, false);
});

test('Chat reasoning is read from reasoning_content or reasoning, never both', async () => {
  const { app } = sidebar();
  const adapter = app.getAdapter({});
  const message = { id: 'pending', content: '', reasoning: '' };
  await app.processStream(sseResponse([
    { choices: [{ delta: { reasoning: 'Weigh ' } }] },
    { choices: [{ delta: { reasoning: 'options.', reasoning_content: 'options.' } }] },
    { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] }
  ]), message, new AbortController().signal, adapter);
  assert.equal(message.reasoning, 'Weigh options.');
  assert.equal(message.content, 'Answer');

  const complete = { id: 'pending' };
  adapter.applyResponse({ choices: [{ message: { content: 'Done', reasoning: 'Thought' } }] }, complete);
  assert.equal(complete.reasoning, 'Thought');
});

test('replies without answer text are left out of the history sent to the provider', () => {
  const { app } = sidebar();
  const { messages } = app.state.sessions.session;
  messages.splice(3, 0,
    { id: 'failed', role: 'assistant', content: '', error: 'Network error' },
    { id: 'thinking', role: 'assistant', content: '  ', reasoning: 'Stopped while thinking' });
  assert.deepEqual(plain(app.buildChatRequestBody().messages.map((m) => m.role)), ['system', 'user', 'assistant', 'user']);
});

test('a reply that opens a think tag and never closes it is all reasoning', () => {
  const { app } = sidebar();
  const message = { content: '\n<think>Weighing the options' };
  app.processThinkTags(message);
  assert.equal(message.reasoning, 'Weighing the options');
  assert.equal(message.content, '');

  // Only a leading tag: one opened later in the answer is answer text
  const later = { content: 'Answer first <think>then this' };
  app.processThinkTags(later);
  assert.equal(later.content, 'Answer first <think>then this');
  assert.equal(later.reasoning, undefined);
});

test('inline think tags show as reasoning while streaming', () => {
  const { app } = sidebar();
  const message = app.state.currentStreamingMessage;
  message.reasoning = '';
  const view = (content) => (message.content = content, plain(app.displayParts(message)));
  assert.deepEqual(view('<thi'), { content: '', reasoning: '' });
  assert.deepEqual(view('<think>Plan the'), { content: '', reasoning: 'Plan the' });
  assert.deepEqual(view('<think>Plan</think>\n\nThe answer'), { content: 'The answer', reasoning: 'Plan' });
  assert.deepEqual(view('No tags <think>here'), { content: 'No tags <think>here', reasoning: '' });
  // A finished message is shown as stored
  assert.deepEqual(plain(app.displayParts({ id: 'done', role: 'assistant', content: '<think>x' })), { content: '<think>x', reasoning: '' });
});

test('model keys split at the last separator, so model ids may contain it', () => {
  const { app } = sidebar();
  assert.deepEqual(plain(app.parseModelKey('org/model - v2 - provider-id')), ['org/model - v2', 'provider-id']);
  assert.deepEqual(plain(app.parseModelKey('legacy-model')), ['legacy-model', '']);
  app.state.config.selectedModel = 'org/model - v2 - provider-id';
  assert.equal(app.buildChatRequestBody().model, 'org/model - v2');
});

test('chat titles are one line and never split a character', () => {
  const { app } = sidebar();
  assert.equal(app.titleFromContent('  Help me\n\n> with   this '), 'Help me > with this');
  const title = app.titleFromContent('😀'.repeat(60));
  assert.equal(Array.from(title).length, 51);
  assert.equal(title.endsWith('😀…'), true);
});

test('non-streaming requests get a longer wait for headers than streaming ones', async () => {
  for (const stream of [true, false]) {
    const context = sidebar();
    context.app.state.config.stream = stream;
    const delays = [];
    context.setTimeout = (callback, delay) => { delays.push(delay); return delays.length; };
    context.clearTimeout = () => {};
    context.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(context.app.streamResponse({ baseUrl: 'https://example.com/v1' }, {}, new AbortController().signal));
    assert.equal(delays[0], stream ? 120000 : 600000);
  }
});

test('pages open in the last applied theme before settings load', () => {
  const classes = new Set();
  const root = { classList: { add: (name) => classes.add(name), remove: (...names) => names.forEach((name) => classes.delete(name)) } };
  const store = { 'sidemind:appearance': JSON.stringify({ theme: 'dark' }) };
  const context = vm.createContext({
    document: { addEventListener() {}, documentElement: root },
    localStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } }
  });
  vm.runInContext(readFileSync(resolve(__dirname, '..', 'assets/js/ui.js'), 'utf8'), context);
  assert.deepEqual([...classes], ['dark-theme']);
  vm.runInContext("cacheAppearance({ theme: 'system', fontSize: '15px' }); applyThemeClass('system');", context);
  assert.deepEqual([...classes], []);
  assert.deepEqual(JSON.parse(store['sidemind:appearance']), { theme: 'system', fontSize: '15px' });
});
