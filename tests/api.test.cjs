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
      createRequestWatchdog, responseCompletionNotice
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
      permissions: { contains: async () => true }
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
