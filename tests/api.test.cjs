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
      createRequestWatchdog, responseCompletionNotice, processThinkTags
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

function storageContext() {
  const context = sidebar();
  const data = {};
  const hooks = { afterGet: null, failRemove: 0 };
  context.chrome = {
    storage: {
      local: {
        async get() {
          const value = structuredClone(data);
          await hooks.afterGet?.(value);
          return value;
        },
        async set(values) { Object.assign(data, structuredClone(values)); },
        async remove(keys) {
          if (hooks.failRemove > 0) { hooks.failRemove -= 1; throw new Error('remove failed'); }
          [].concat(keys).forEach(key => delete data[key]);
        }
      }
    }
  };
  vm.runInContext(`globalThis.store = { writeLocalChanges, stashChangesOnUnload, applyChanges, state };`, context);
  return { store: context.store, data, hooks };
}

const pendingKeys = data => Object.keys(data).filter(key => key.startsWith('pendingSave:'));

test('a newer stash under the same page is applied even when an earlier one is already folded in', async () => {
  // These two drafts have the same 32-bit djb2 fingerprint ("o4kdcp").
  const { store, data, hooks } = storageContext();
  store.state.drafts.chat = 'draft-0001r';
  store.stashChangesOnUnload();
  hooks.failRemove = 1;
  await assert.rejects(store.writeLocalChanges(false));
  assert.equal(data.drafts.chat, 'draft-0001r');
  assert.equal(pendingKeys(data).length, 1);
  store.state.drafts.chat = 'draft-00030';
  store.stashChangesOnUnload();
  assert.equal(pendingKeys(data).length, 2);
  await store.writeLocalChanges(false);
  assert.equal(data.drafts.chat, 'draft-00030');
  assert.deepEqual(pendingKeys(data), []);
});

test('re-stashing identical content reuses the key, so repeated pagehide stays one changeset', () => {
  const { store, data } = storageContext();
  store.state.drafts.chat = 'same';
  store.stashChangesOnUnload();
  store.stashChangesOnUnload();
  assert.equal(pendingKeys(data).length, 1);
});

test('a stash written after a locked save read its snapshot is not removed by that save', async () => {
  const { store, data, hooks } = storageContext();
  store.state.drafts.chat = 'earlier pending';
  store.stashChangesOnUnload();
  let released = false;
  hooks.afterGet = async () => {
    if (released) return;
    released = true;
    // pagehide: same page, newer payload, no lock
    store.state.drafts.chat = 'latest pending';
    store.stashChangesOnUnload();
  };
  await store.writeLocalChanges(false);
  assert.equal(pendingKeys(data).length, 1, 'newer stash must survive the earlier save');
  hooks.afterGet = null;
  await store.writeLocalChanges(false);
  assert.equal(data.drafts.chat, 'latest pending');
  assert.deepEqual(pendingKeys(data), []);
});

test('different conflicting edits get different copies; replaying one changeset adds none', () => {
  const { store } = storageContext();
  const msg = content => ({ id: 'm', role: 'user', content });
  const chat = content => ({ title: 'T', messages: [msg(content)] });
  const stored = { sessions: { s: chat('theirs') }, drafts: {} };
  const change = (content, copyNonce) => ({
    sessions: { s: { base: JSON.stringify(chat('base')), mine: chat(content), copyNonce, draft: null, current: false } },
    removed: {}, drafts: {}
  });
  // Contents with colliding legacy hashes.
  let tables = store.applyChanges(stored, change('draft-0000r', 'n1'));
  tables = store.applyChanges(tables, change('draft-00020', 'n2'));
  const copies = Object.keys(tables.sessions).filter(key => key.startsWith('conflict-'));
  assert.equal(copies.length, 2);
  const again = store.applyChanges(tables, change('draft-0000r', 'n1'));
  assert.deepEqual(Object.keys(again.sessions).sort(), Object.keys(tables.sessions).sort());
});

// Re-keys the stored stashes so that sorted key order is `names` order (or the reverse),
// and re-inserts them in that order, whatever order they were written in.
function rekeyPending(data, names, reverse) {
  const keys = pendingKeys(data);
  const payloads = keys.map(key => data[key]);
  keys.forEach(key => delete data[key]);
  const order = names.map((name, i) => [`pendingSave:p:${name}`, payloads[i]]);
  (reverse ? order.reverse() : order).forEach(([key, value]) => { data[key] = value; });
}

for (const reverse of [false, true]) {
  test(`stashes fold oldest first whatever the key sort or return order (${reverse ? 'reversed' : 'plain'})`, async () => {
    const { store, data } = storageContext();
    store.state.drafts.chat = 'older pending';
    store.stashChangesOnUnload();
    store.state.drafts.chat = 'latest pending';
    store.stashChangesOnUnload();
    assert.equal(pendingKeys(data).length, 2);
    // The page itself no longer holds the draft, so only the stashes decide the result.
    delete store.state.drafts.chat;
    // Name the older stash so that it sorts last, and the newer one first.
    rekeyPending(data, ['zzz', 'aaa'], reverse);
    await store.writeLocalChanges(false);
    assert.equal(data.drafts.chat, 'latest pending');
    assert.deepEqual(pendingKeys(data), []);
  });
}

test('stashes from different pages are ordered by their clock, not by page id or key', async () => {
  const { store, data } = storageContext();
  const stash = (page, at, text) => ({ sessions: {}, removed: {}, drafts: { chat: text }, order: { at, page, n: 1 } });
  data['pendingSave:a'] = stash('page-z', 2000, 'newer, page z');
  data['pendingSave:b'] = stash('page-a', 1000, 'older, page a');
  await store.writeLocalChanges(false);
  assert.equal(data.drafts.chat, 'newer, page z');
  assert.deepEqual(pendingKeys(data), []);
});

test('a stash without a copy nonce gets a fresh one: colliding legacy hashes keep both edits', async () => {
  const { store, data } = storageContext();
  const chat = content => ({ title: 'T', messages: [{ id: 'm', role: 'user', content }] });
  data.sessions = { s: chat('theirs') };
  const legacy = content => ({
    sessions: { s: { base: JSON.stringify(chat('base')), mine: chat(content), draft: null, current: false } },
    removed: {}, drafts: {}
  });
  // 'draft-0000r' and 'draft-00020' collide under the old 32-bit hash.
  data['pendingSave:1'] = legacy('draft-0000r');
  data['pendingSave:2'] = legacy('draft-00020');
  await store.writeLocalChanges(false);
  const copies = Object.entries(data.sessions).filter(([key]) => key.startsWith('conflict-s-'));
  assert.deepEqual(copies.map(([, copy]) => copy.messages[0].content).sort(), ['draft-0000r', 'draft-00020']);
  assert.deepEqual(pendingKeys(data), []);
});

test('applying a nonce-less change directly is stable within the call and differs between calls', () => {
  const { store } = storageContext();
  const chat = content => ({ title: 'T', messages: [{ id: 'm', role: 'user', content }] });
  const change = { sessions: { s: { base: JSON.stringify(chat('base')), mine: chat('mine'), draft: null, current: true } }, removed: {}, drafts: {} };
  const stored = { sessions: { s: chat('theirs') }, drafts: {} };
  const first = store.applyChanges(stored, change);
  const second = store.applyChanges(stored, change);
  assert.equal(first.conflicts.length, 1);
  assert.ok(first.sessions[first.conflicts[0].copyId]);
  assert.equal(first.currentSessionId, first.conflicts[0].copyId);
  assert.notEqual(first.conflicts[0].copyId, second.conflicts[0].copyId);
});

test('a conflict copy is recorded in the same write as the marker that guards it', async () => {
  const { store, data, hooks } = storageContext();
  const chat = content => ({ title: 'T', messages: [{ id: 'm', role: 'user', content }] });
  data.sessions = { s: chat('theirs') };
  data['pendingSave:1'] = { sessions: { s: { base: JSON.stringify(chat('base')), mine: chat('mine'), draft: null, current: false } }, removed: {}, drafts: {} };
  hooks.failRemove = 1;
  await assert.rejects(store.writeLocalChanges(false));
  assert.equal(Object.keys(data.sessions).filter(key => key.startsWith('conflict-s-')).length, 1);
  assert.equal(typeof data.appliedPending['pendingSave:1'].nonce, 'string');
  await store.writeLocalChanges(false);
  assert.equal(Object.keys(data.sessions).filter(key => key.startsWith('conflict-s-')).length, 1, 'retry only removes the key');
  assert.deepEqual(pendingKeys(data), []);
});

test('legacy string markers: a matching one counts as applied, a stale one is replayed', async () => {
  const { store, data } = storageContext();
  const payload = text => ({ sessions: {}, removed: {}, drafts: { chat: text } });
  // The fingerprint format of the previous build: djb2 over the stash JSON.
  const hash = text => {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  data.drafts = { chat: 'newer draft' };
  data['pendingSave:old'] = payload('already folded in');
  data.appliedPending = { 'pendingSave:old': hash(JSON.stringify(payload('already folded in'))) };
  await store.writeLocalChanges(false);
  assert.equal(data.drafts.chat, 'newer draft', 'matching legacy marker: only the removal is retried');
  assert.deepEqual(pendingKeys(data), []);

  // Same key rewritten with different content after the marker was written.
  data['pendingSave:old'] = payload('rewritten later');
  data.appliedPending = { 'pendingSave:old': hash(JSON.stringify(payload('first version'))) };
  await store.writeLocalChanges(false);
  assert.equal(data.drafts.chat, 'rewritten later', 'non-matching legacy marker: the stash is replayed, not dropped');
  assert.deepEqual(pendingKeys(data), []);
  await store.writeLocalChanges(false);
  assert.deepEqual(data.appliedPending, {}, 'the next save drops the stale marker');
});
