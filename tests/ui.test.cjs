// Optional browser regression suite. Playwright is a development-only tool;
// see README for installation outside the extension and the run command.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve, extname } = require('node:path');
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {}
const browserTest = (name, fn) =>
  test(name, { skip: !chromium && 'Install Playwright to run browser checks (see README)' }, fn);
const root = resolve(__dirname, '..');
let browser;
let server;
let baseUrl;
const fixtureConfig = {
  providers: [
    {
      id: 'provider',
      name: 'Test provider',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'fixture-key',
      models: [{ id: 'model', name: 'Test model' }]
    }
  ],
  selectedProvider: 'provider',
  selectedModel: 'model - provider',
  selectedSystemPrompt: 'default',
  systemPrompts: [{ id: 'default', name: 'Default', content: 'Be helpful.', isDefault: true }],
  temperature: 0.7,
  max_completion_tokens: '',
  stream: true,
  theme: 'light'
};

before(async () => {
  if (!chromium) return;
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/attachment-fixture.html') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Attachment fixture</title>'); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(`${root}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const types = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2'
      };
      const contents = readFileSync(path);
      response.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream'
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    // The multi-page fixtures share storage through localStorage, which Chromium
    // propagates between renderer processes asynchronously: a page could read a
    // table another process wrote a moment before, after the Web Lock ordered
    // them. chrome.storage has no such lag; one process per site removes it here.
    args: ['--process-per-site'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Storage as the current build keeps it: one `session:<id>` key per chat.
// `{ sessions, __legacyLayout: true }` seeds the one-table layout of earlier builds.
function seedLayout({ sessions, __legacyLayout, ...rest }) {
  if (!sessions) return rest;
  if (__legacyLayout) return { ...rest, sessions };
  return {
    ...rest,
    ...Object.fromEntries(Object.entries(sessions).map(([id, session]) => [`session:${id}`, { rev: `seed-${id}`, session }]))
  };
}

async function openPage(kind = 'sidebar', config = fixtureConfig, rawLocal = {}, prepare, browserContext = null) {
  const local = seedLayout(rawLocal);
  const page = browserContext ? await browserContext.newPage() : await browser.newPage({
    viewport: { width: kind === 'sidebar' ? 380 : 1160, height: 800 },
    reducedMotion: 'reduce'
  });
  await prepare?.(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ initialConfig, initialLocal, version }) => {
      const listeners = [];
      window.__writes = [];
      window.__failSave = false;
      window.__failLocalSave = false;
      const reload = sessionStorage.getItem('sidemind-fixture-reload');
      window.__storage = reload ? JSON.parse(reload) : { sync: { config: initialConfig }, local: initialLocal, session: {} };
      // chrome.storage returns JSON with the keys of every object in
      // alphabetical order, not a clone of what was written.
      const stored = (value) =>
        JSON.parse(
          JSON.stringify(value, (key, item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
              : item
          )
        );
      const storageArea = (area) => ({
        get: async (keys) => {
          if (area === 'local' && window.__storage.local.__failLoad) throw new Error('Fixture read failure');
          return Object.fromEntries(
            (keys || Object.keys(window.__storage[area]))
              .filter((key) => key in window.__storage[area])
              .map((key) => [key, stored(window.__storage[area][key])])
          );
        },
        set: async (data) => {
          if (window.__failSave && area === 'sync') throw new Error('Fixture storage failure');
          if (window.__failLocalSave && area === 'local') throw new Error('Fixture local storage failure');
          const changes = {};
          for (const [key, value] of Object.entries(data)) {
            changes[key] = {
              oldValue: window.__storage[area][key],
              newValue: stored(value)
            };
            window.__storage[area][key] = stored(value);
          }
          if (sessionStorage.getItem('sidemind-fixture-reload')) sessionStorage.setItem('sidemind-fixture-reload', JSON.stringify(window.__storage));
          window.__writes.push({ area, data: stored(data) });
          listeners.forEach((listener) => listener(changes, area));
        },
        remove: async (keys) => {
          const changes = {};
          for (const key of keys) {
            if (key in window.__storage[area]) changes[key] = { oldValue: window.__storage[area][key] };
            delete window.__storage[area][key];
          }
          if (sessionStorage.getItem('sidemind-fixture-reload')) sessionStorage.setItem('sidemind-fixture-reload', JSON.stringify(window.__storage));
          listeners.forEach((listener) => listener(changes, area));
        }
      });
      window.chrome = {
        storage: {
          sync: storageArea('sync'),
          local: storageArea('local'),
          session: storageArea('session'),
          onChanged: { addListener: (listener) => listeners.push(listener) }
        },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true },
        windows: { getCurrent: async () => ({ id: 1 }) },
        runtime: {
          getManifest: () => ({ version }),
          openOptionsPage: () => {
            window.__openedOptions = true;
          }
        }
      };
      window.__fetchCalls = [];
      const originalFetch = window.fetch;
      window.fetch = async (url, options) => {
        if (!String(url).startsWith('https://provider.test')) return originalFetch(url, options);
        window.__fetchCalls.push(JSON.parse(options.body));
        if (window.__httpFailure) {
          return Response.json({ error: { message: window.__httpFailure.message } }, { status: window.__httpFailure.status });
        }
        let controller;
        const stream = new ReadableStream({
          start(value) {
            controller = value;
          }
        });
        let finished = false;
        const close = () => {
          if (!finished) {
            finished = true;
            controller.close();
          }
        };
        const fail = (error) => {
          if (!finished) {
            finished = true;
            controller.error(error);
          }
        };
        options.signal.addEventListener(
          'abort',
          () => fail(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
        window.__stream = {
          delta: (content) =>
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
              )
            ),
          reasoning: (content) =>
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: content } }] })}\n\n`
              )
            ),
          complete: () => {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            close();
          },
          unconfirmed: close,
          fail: () => fail(new Error('Network error'))
        };
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      };
    },
    {
      initialConfig: config,
      initialLocal: local,
      version: JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')).version
    }
  );
  await page.goto(`${baseUrl}/${kind}/${kind}.html`);
  await page.waitForFunction(
    (kind) =>
      kind === 'sidebar'
        ? typeof state !== 'undefined' &&
          state.currentSessionId &&
          document.querySelector('#generationStatus').textContent
        : Boolean(document.querySelector('#versionBadge')?.textContent),
    kind
  );
  return { page, errors };
}

async function openSettingsSection(page, section) {
  await page.locator(`.settings-nav a[href="#${section}"]`).click();
  await page.locator(`#${section}`).waitFor({ state: 'visible' });
}

async function setTheme(page, theme) {
  await openSettingsSection(page, 'appearance');
  await page.locator(`#themeSelector input[value="${theme}"]`).check();
}

async function chooseModel(page, key) {
  await page.locator('#modelSelector').click();
  await page.locator(`[role="option"][data-model-key="${key}"]`).click();
}

async function startResponse(page, text = 'Explain this carefully.') {
  await page.locator('#messageInput').fill(text);
  await page.locator('#messageInput').press('Enter');
  await page.waitForFunction(() => window.__fetchCalls.length && state.isStreaming);
}

async function delta(page, text) {
  await page.evaluate((text) => window.__stream.delta(text), text);
  await page.waitForFunction(
    (text) =>
      document
        .querySelector('.message.assistant .message-content')
        ?.textContent.includes(text.trim().slice(0, 10)),
    text
  );
}

browserTest('chat and settings fit narrow viewports and manual dark themes', async () => {
  for (const kind of ['sidebar', 'options']) {
    const { page, errors } = await openPage(kind);
    for (const width of [320, 380, 480, 1160]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${kind} width=${width}`
      );
    }
    if (kind === 'options') {
      await setTheme(page, 'dark');
      assert.equal(
        await page.evaluate(() => document.documentElement.classList.contains('dark-theme')),
        true
      );
      await page.locator('#fontSizeSelector').selectOption('16px');
      assert.equal(
        await page.locator('#fontPreview').evaluate((node) => getComputedStyle(node).fontSize),
        '16px'
      );
    }
    if (process.env.UI_SCREENSHOTS) {
      await page.setViewportSize({ width: kind === 'sidebar' ? 380 : 1160, height: 800 });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/${kind}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

browserTest('settings navigation restores deep links, history and the visible narrow-screen section', async () => {
  const { page, errors } = await openPage('options');
  assert.equal(await page.locator('.options-main > section:visible').count(), 1);
  await page.goto(`${baseUrl}/options/options.html#appearance`);
  await page.locator('#appearance').waitFor({ state: 'visible' });
  await openSettingsSection(page, 'roles');
  await page.goBack();
  await page.locator('#appearance').waitFor({ state: 'visible' });
  await page.goForward();
  await page.locator('#roles').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#roles').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.settings-nav [aria-current="page"]').getAttribute('href'), '#roles');
  await page.setViewportSize({ width: 320, height: 600 });
  await openSettingsSection(page, 'data');
  const inView = await page.locator('.settings-nav').evaluate((nav) => {
    const bounds = nav.getBoundingClientRect();
    const active = nav.querySelector('[aria-current]').getBoundingClientRect();
    // scrollLeft is integral, while glyph layout can end on a fractional pixel.
    return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
  });
  assert.equal(inView, true);
  await page.goto(`${baseUrl}/options/options.html#unknown`);
  await page.locator('#providers').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).hash, '#providers');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('theme choices follow the system and the streaming switch saves its actual state', async () => {
  const { page, errors } = await openPage('options');
  await setTheme(page, 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(28, 31, 29)');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(245, 244, 240)');
  await setTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 244, 240)');
  await openSettingsSection(page, 'conversation');
  await page.locator('#streamSelector').uncheck();
  await page.waitForFunction(() => window.__storage.sync.config.stream === false);
  await page.locator('#streamSelector').check();
  await page.waitForFunction(() => window.__storage.sync.config.stream === true);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('reading preferences leave controls compact and completion feedback settles quietly', async () => {
  const { page, errors } = await openPage('sidebar', {
    ...fixtureConfig, fontSize: '16px', fontFamily: 'Georgia, serif'
  });
  assert.equal(await page.locator('#messageInput').evaluate((node) => getComputedStyle(node).fontSize), '16px');
  assert.equal(await page.locator('#sendBtn').evaluate((node) => getComputedStyle(node).fontSize), '14px');
  await page.waitForFunction(() => document.querySelector('#newChatBtn .ui-icon').getBBox().width > 0);
  assert.equal(await page.locator('#generationStatus').isVisible(), false);
  await startResponse(page);
  await delta(page, 'A readable answer.');
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('.message-bubble').last().evaluate((node) => getComputedStyle(node).fontSize), '16px');
  await page.waitForFunction(() => document.querySelector('#generationStatus').dataset.state === 'idle');
  assert.equal(await page.locator('#generationStatus').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('provider dialogs keep their actions reachable on short narrow screens', async () => {
  const { page, errors } = await openPage('options');
  await page.setViewportSize({ width: 320, height: 480 });
  await page.getByRole('button', { name: 'Edit Test provider' }).click();
  for (let index = 0; index < 4; index++) await page.locator('#addModelBtn').click();
  const footer = await page.locator('#providerModal .modal-footer').boundingBox();
  assert.ok(footer.y >= 0 && footer.y + footer.height <= 480);
  assert.equal(await page.locator('#providerModal .modal-body').evaluate((node) => node.scrollHeight > node.clientHeight), true);
  await page.locator('#providerCancelBtn').click();
  await page.locator('#confirmAccept').click();
  assert.equal(await page.locator('#providerModal').evaluate((node) => node.open), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('Enter during generation retains the next draft; stop awaits cleanup', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await delta(page, 'A partial answer worth keeping.');
  await page.locator('#messageInput').fill('My next question');
  await page.locator('#messageInput').press('Enter');
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 1);
  assert.equal(await page.locator('#messageInput').inputValue(), 'My next question');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && !state.generationDone);
  assert.match(await page.locator('.response-status').last().textContent(), /stopped/);
  assert.equal(await page.locator('#messageInput').inputValue(), 'My next question');
  await page.locator('#messageInput').press('Enter');
  await page.waitForFunction(() => window.__fetchCalls.length === 2);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !state.isStreaming);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('IME Enter does not send, and Shift+Enter inserts a newline', async () => {
  const { page, errors } = await openPage();
  await page.locator('#messageInput').fill('中文输入');
  await page
    .locator('#messageInput')
    .evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      )
    );
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
  await page.locator('#messageInput').press('Shift+Enter');
  assert.match(await page.locator('#messageInput').inputValue(), /\n/);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest(
  'long responses pause scrolling; following and manual reading stay under user control',
  async () => {
    const { page, errors } = await openPage();
    await startResponse(page);
    for (let index = 0; index < 25; index++) {
      await page.evaluate(
        (index) =>
          window.__stream.delta(
            `Paragraph ${index}: a clear explanation with enough detail to read in a narrow sidebar.\n\n`
          ),
        index
      );
      await page.waitForTimeout(70);
    }
    assert.equal(await page.evaluate(() => state.readingResponse), true);
    const before = await page.locator('#messagesList').evaluate((node) => node.scrollTop);
    await delta(page, 'More text arriving below your reading position.\n\n');
    assert.equal(await page.locator('#messagesList').evaluate((node) => node.scrollTop), before);
    await page.locator('#scrollBottomBtn').click();
    await delta(page, 'Now explicitly following the new output.\n\n');
    assert.equal(
      await page
        .locator('#messagesList')
        .evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop < 3),
      true
    );
    await page.locator('#messagesList').evaluate((node) => {
      node.scrollTop = 120;
    });
    await page.waitForFunction(() => state.userScrolledUp);
    await delta(page, 'Another paragraph that should leave the reader in place.\n\n');
    assert.equal(await page.locator('#messagesList').evaluate((node) => node.scrollTop), 120);
    await page.evaluate(() => window.__stream.complete());
    await page.waitForFunction(() => !state.isStreaming);
    assert.equal(await page.locator('#messagesList').evaluate((node) => node.scrollTop), 120);
    if (process.env.UI_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/conversation.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'network failure preserves partial content and offers retry without duplication',
  async () => {
    const { page, errors } = await openPage();
    await startResponse(page);
    await delta(page, 'Keep this useful partial response.');
    await page.evaluate(() => window.__stream.fail());
    await page.waitForFunction(() => !state.isStreaming);
    assert.match(
      await page.locator('.message.assistant .message-content').textContent(),
      /useful partial/
    );
    assert.match(await page.locator('.response-status').last().textContent(), /Network/);
    await page.locator('.regenerate-btn').click();
    await page.waitForFunction(() => window.__fetchCalls.length === 2);
    assert.equal(
      await page.evaluate(
        () =>
          state.sessions[state.currentSessionId].messages.filter(
            (message) => message.role === 'user'
          ).length
      ),
      1
    );
    await page.evaluate(() => window.__stream.delta('A complete replacement.'));
    await page.evaluate(() => window.__stream.complete());
    await page.waitForFunction(() => !state.isStreaming);
    assert.equal(await page.locator('.message.assistant').count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'selection in a growing answer survives paints and deferred text catches up',
  async () => {
    const { page, errors } = await openPage();
    await startResponse(page);
    await delta(page, 'Select this first sentence.\n\n');
    await page.locator('.message.assistant .message-content p').evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.evaluate(() => window.__stream.delta('New text after the selected sentence.'));
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      'Select this first sentence.'
    );
    await page.evaluate(() => window.__stream.complete());
    await page.waitForFunction(() => !state.isStreaming);
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForFunction(() =>
      document.querySelector('.message.assistant').textContent.includes('New text')
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'history searches message bodies, renames, deletes, undoes, and restores focus',
  async () => {
    const timestamp = new Date().toISOString();
    const { page, errors } = await openPage('sidebar', fixtureConfig, {
      currentSessionId: 'first',
      drafts: { first: 'Keep my draft' },
      sessions: {
        first: {
          title: 'First conversation',
          timestamp,
          messages: [{ id: 'message-one', role: 'user', content: 'A rare pineapple.', timestamp }]
        },
        second: {
          title: 'Second conversation',
          timestamp,
          messages: [{ id: 'message-two', role: 'user', content: 'Other topic.', timestamp }]
        }
      }
    });
    await page.locator('#chatHistoryBtn').click();
    assert.equal(
      await page.locator('#historySearch').evaluate((node) => node === document.activeElement),
      true
    );
    await page.locator('#historySearch').fill('pineapple');
    await page.waitForFunction(() => document.querySelectorAll('.chat-history-item').length === 1);
    assert.equal(await page.locator('.chat-history-item').count(), 1);
    await page.getByRole('button', { name: 'Rename chat' }).click();
    await page.getByRole('textbox', { name: 'Conversation title' }).fill('Fruit discussion');
    await page.getByRole('textbox', { name: 'Conversation title' }).press('Enter');
    assert.match(await page.locator('.chat-history-title').textContent(), /Fruit/);
    await page.getByRole('button', { name: 'Delete chat' }).click();
    assert.equal(await page.locator('.chat-history-item').count(), 0);
    await page.locator('#historyUndoBtn').click();
    assert.equal(await page.locator('.chat-history-item').count(), 1);
    assert.equal(await page.evaluate(() => state.drafts.first), 'Keep my draft');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#chatHistoryDropdown').evaluate((node) => node.open), false);
    assert.equal(
      await page.locator('#chatHistoryBtn').evaluate((node) => node === document.activeElement),
      true
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'settings autosave is debounced and invalid token limits do not overwrite saved values',
  async () => {
    const { page, errors } = await openPage('options');
    await openSettingsSection(page, 'conversation');
    await page.locator('#conversation .advanced-settings summary').click();
    for (const value of ['1', '12', '120'])
      await page.locator('#maxCompletionTokensInput').fill(value);
    await page.waitForFunction(() => window.__storage.sync.config.max_completion_tokens === 120);
    assert.equal(
      await page.evaluate(() => window.__writes.filter((write) => write.area === 'sync' && write.data.config.max_completion_tokens === 120).length),
      1
    );
    await page.locator('#maxCompletionTokensInput').fill('1.5');
    assert.equal(
      await page.locator('#maxCompletionTokensInput').getAttribute('aria-invalid'),
      'true'
    );
    assert.equal(
      await page.evaluate(() => window.__storage.sync.config.max_completion_tokens),
      120
    );
    await page.evaluate(() => {
      window.__failSave = true;
    });
    await page.locator('#maxCompletionTokensInput').fill('240');
    await page.waitForFunction(
      () => document.querySelector('#saveStatus').dataset.state === 'error'
    );
    await page.evaluate(() => {
      window.__failSave = false;
    });
    await page.locator('#saveBtn').click();
    await page.waitForFunction(() => window.__storage.sync.config.max_completion_tokens === 240);
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'provider save failure retains edits and config; successful retry commits once',
  async () => {
    const { page, errors } = await openPage('options');
    await page.getByRole('button', { name: 'Edit Test provider' }).click();
    await page.locator('#providerName').fill('Updated provider');
    await page.locator('#providerApiType').selectOption('responses');
    assert.match(await page.locator('#endpointPreview').textContent(), /\/responses/);
    await page.locator('#toggleApiKey').click();
    assert.equal(await page.locator('#providerApiKey').getAttribute('type'), 'text');
    await page.evaluate(() => {
      window.__failSave = true;
    });
    await page.locator('#providerSaveBtn').click();
    await page.waitForFunction(() =>
      document.querySelector('#providerModal .modal-error').textContent.includes('Could not save')
    );
    assert.equal(await page.locator('#providerModal').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#providerName').inputValue(), 'Updated provider');
    assert.equal(await page.evaluate(() => config.providers[0].name), 'Test provider');
    await page.evaluate(() => {
      window.__failSave = false;
    });
    await page.locator('#providerSaveBtn').click();
    await page.waitForFunction(() => !document.querySelector('#providerModal').open);
    assert.equal(
      await page.evaluate(() => window.__storage.sync.config.providers[0].name),
      'Updated provider'
    );
    assert.equal(await page.evaluate(() => window.__storage.sync.config.providers.length), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'dirty dialogs confirm discard, trap focus, and return focus to the opener',
  async () => {
    const { page, errors } = await openPage('options');
    await openSettingsSection(page, 'roles');
    await page.locator('#addPromptBtn').click();
    assert.equal(
      await page.locator('#promptName').evaluate((node) => node === document.activeElement),
      true
    );
    await page.locator('#promptName').fill('Unsaved role');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#confirmModal').evaluate((node) => node.open), true);
    await page.locator('#confirmCancel').click();
    assert.equal(await page.locator('#promptModal').evaluate((node) => node.open), true);
    for (let index = 0; index < 10; index++) {
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .locator('#promptModal')
          .evaluate((node) => node.contains(document.activeElement)),
        true
      );
    }
    await page.locator('#promptCancelBtn').click();
    await page.locator('#confirmAccept').click();
    assert.equal(await page.locator('#promptModal').evaluate((node) => node.open), false);
    assert.equal(
      await page.locator('#addPromptBtn').evaluate((node) => node === document.activeElement),
      true
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest('wide markdown tables and code remain inside a 320px transcript', async () => {
  const { page, errors } = await openPage();
  await page.setViewportSize({ width: 320, height: 600 });
  await startResponse(page);
  await page.evaluate(() =>
    window.__stream.delta(
      '| One | Two | Three | Four |\n| --- | --- | --- | --- |\n| a | b | c | d |\n\n```javascript\nconst extremelyLongLine = "' +
        'text'.repeat(40) +
        '";\n```'
    )
  );
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('.table-scroll').count(), 1);
  assert.equal(await page.locator('.code-copy-btn').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page.locator('.table-scroll').evaluate((node) => node.scrollWidth > node.clientWidth),
    true
  );
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest(
  'import previews replacement and leaves current settings intact on failure',
  async () => {
    const { page, errors } = await openPage('options');
    const imported = structuredClone(fixtureConfig);
    imported.providers[0].name = 'Imported service';
    imported.providers[0].apiKey = '';
    await page
      .locator('#importFile')
      .setInputFiles({
        name: 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(imported))
      });
    await page.waitForFunction(() => document.querySelector('#confirmModal').open);
    assert.match(await page.locator('#confirmDescription').textContent(), /need an API key/);
    await page.evaluate(() => {
      window.__failSave = true;
    });
    await page.locator('#confirmAccept').click();
    await page.waitForFunction(() =>
      document.querySelector('#notifications').textContent.includes('could not be saved')
    );
    assert.equal(await page.evaluate(() => config.providers[0].name), 'Test provider');
    await page.evaluate(() => {
      window.__failSave = false;
    });
    await page
      .locator('#importFile')
      .setInputFiles({
        name: 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(imported))
      });
    await page.waitForFunction(() => document.querySelector('#confirmModal').open);
    await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => config.providers[0].name === 'Imported service');
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'new chat awaits stream abort, persists partial reply and restores per-chat drafts',
  async () => {
    const { page, errors } = await openPage();
    await startResponse(page);
    await delta(page, 'An answer in the original conversation.');
    const oldId = await page.evaluate(() => state.currentSessionId);
    await page.locator('#messageInput').fill('Original chat draft');
    await page.locator('#newChatBtn').click();
    await page.waitForFunction(
      (oldId) => state.currentSessionId !== oldId && !state.isStreaming,
      oldId
    );
    assert.equal(await page.locator('#messageInput').inputValue(), '');
    assert.equal(
      await page.evaluate((oldId) => state.sessions[oldId].messages[1].stopped, oldId),
      true
    );
    await page.locator('#chatHistoryBtn').click();
    await page
      .locator('.chat-history-content')
      .filter({ hasText: 'Explain this carefully.' })
      .click();
    assert.equal(await page.locator('#messageInput').inputValue(), 'Original chat draft');
    assert.equal(await page.locator('.message.assistant').count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'editing a previous question explains the effect and undo restores the complete transcript',
  async () => {
    const timestamp = new Date().toISOString();
    const originalMessages = [
      { id: 'q1', role: 'user', content: 'Original question', timestamp },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Original answer',
        timestamp,
        modelUsed: fixtureConfig.selectedModel
      },
      { id: 'q2', role: 'user', content: 'Followup question', timestamp },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Followup answer',
        timestamp,
        modelUsed: fixtureConfig.selectedModel
      }
    ];
    const { page, errors } = await openPage('sidebar', fixtureConfig, {
      currentSessionId: 'chat',
      sessions: { chat: { title: 'Original question', timestamp, messages: originalMessages } }
    });
    await page.locator('.message.user').first().hover();
    await page.locator('.edit-btn').first().click();
    assert.match(await page.locator('.edit-warning').textContent(), /3 later messages/);
    await page.locator('.message-edit-input').fill('Revised question');
    await page.locator('.edit-submit-btn').click();
    await page.waitForFunction(() => state.isStreaming);
    assert.equal(await page.locator('.message').count(), 2);
    await page.locator('#undoBtn').click();
    await page.waitForFunction(
      () => !state.isStreaming && state.sessions.chat.messages.length === 4
    );
    assert.deepEqual(
      await page.evaluate(() => state.sessions.chat.messages.map((message) => message.content)),
      originalMessages.map((message) => message.content)
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'reasoning toggles by keyboard and remains open when the user is reading it',
  async () => {
    const { page, errors } = await openPage();
    await startResponse(page);
    await page.evaluate(() => window.__stream.reasoning('Some useful reasoning summary.'));
    await page.waitForFunction(() => document.querySelector('.reasoning-header'));
    assert.equal(await page.locator('.reasoning-header').getAttribute('aria-expanded'), 'false');
    await page.locator('.reasoning-header').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.reasoning-header').getAttribute('aria-expanded'), 'true');
    await delta(page, 'The final answer follows.');
    await page.evaluate(() => window.__stream.complete());
    await page.waitForFunction(() => !state.isStreaming);
    assert.equal(await page.locator('.reasoning-header').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest('Markdown cannot inject page controls, styles, or executable URLs', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() =>
    window.__stream.delta(
      '<form><input autofocus id="intruder"></form><style>body{display:none}</style><script>alert(1)</script>\n\n[Unsafe](javascript:alert(1))\n\n**Readable content**'
    )
  );
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(
    await page
      .locator(
        '.message-content form, .message-content input, .message-content style, .message-content script'
      )
      .count(),
    0
  );
  assert.equal(await page.locator('.message-content a').getAttribute('href'), null);
  assert.match(await page.locator('.message.assistant').textContent(), /Readable content/);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest(
  'configuration exports omit API keys by default and include them only when selected',
  async () => {
    const { page, errors } = await openPage('options');
    await openSettingsSection(page, 'data');
    const download = page.waitForEvent('download');
    await page.locator('#exportBtn').click();
    const exported = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
    assert.equal(exported.providers[0].apiKey, '');
    await page.locator('#exportKeys').check();
    const withKeys = page.waitForEvent('download');
    await page.locator('#exportBtn').click();
    assert.equal(
      JSON.parse(readFileSync(await (await withKeys).path(), 'utf8')).providers[0].apiKey,
      'fixture-key'
    );
    assert.equal(await page.evaluate(() => config.providers[0].apiKey), 'fixture-key');
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest(
  'real MV3 extension pages load under CSP and sync appearance between settings and chat',
  async () => {
    const { mkdtempSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const profile = mkdtempSync(resolve(tmpdir(), 'sidemind-mv3-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
      });
      const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).host;
      await worker.evaluate((config) => chrome.storage.sync.set({ config }), fixtureConfig);
      const errors = [];
      const chat = await context.newPage();
      chat.on('pageerror', (error) => errors.push(error.message));
      await chat.goto(`chrome-extension://${id}/sidebar/sidebar.html`);
      await chat.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
      const settings = await context.newPage();
      settings.on('pageerror', (error) => errors.push(error.message));
      await settings.goto(`chrome-extension://${id}/options/options.html`);
      await settings.waitForFunction(() => document.querySelector('#versionBadge').textContent);
      await settings.waitForFunction(() => document.querySelector('.settings-nav .ui-icon').getBBox().width > 0);
      await chat.waitForFunction(() => document.querySelector('#newChatBtn .ui-icon').getBBox().width > 0);
      await setTheme(settings, 'dark');
      await settings.locator('#fontSizeSelector').selectOption('16px');
      await chat.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark-theme') &&
          getComputedStyle(document.querySelector('#messageInput')).fontSize === '16px'
      );
      assert.equal(
        await settings.locator('#versionBadge').textContent(),
        `v${JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')).version}`
      );
      await chat.locator('#messageInput').fill('Persistent local draft');
      await chat.waitForFunction(async () =>
        Boolean((await chrome.storage.local.get(['drafts'])).drafts?.[state.currentSessionId])
      );
      await chat.reload();
      await chat.waitForFunction(
        () => document.querySelector('#messageInput').value === 'Persistent local draft'
      );
      await chat.evaluate(async () => {
        const currentWindow = await chrome.windows.getCurrent();
        await chrome.storage.session.set({
          [`selection:${currentWindow.id}`]: { text: 'A page excerpt', title: 'Source article', url: 'https://example.com/article' }
        });
      });
      await chat.waitForFunction(() => document.querySelector('#messageInput').value.includes('A page excerpt'));
      assert.match(await chat.locator('#messageInput').inputValue(), /^Persistent local draft/);
      await chat.waitForFunction(async () => {
        const currentWindow = await chrome.windows.getCurrent();
        return !(await chrome.storage.session.get([`selection:${currentWindow.id}`]))[`selection:${currentWindow.id}`];
      });
      await chat.locator('#attachmentInput').setInputFiles(attachmentPng);
      await chat.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 1);
      await chat.evaluate(() => persistDrafts());
      await chat.reload();
      await chat.waitForFunction(() => storageReady && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 1);
      assert.match(await chat.locator('#messageInput').inputValue(), /^Persistent local draft/);
      assert.equal(await chat.evaluate(async () => {
        const ref = normalizeDraft(state.drafts[state.currentSessionId]).attachments[0];
        return (await AttachmentStore.get(ref)).size === ref.size;
      }), true);
      await chat.getByRole('button', { name: 'View pixel.png', exact: true }).click();
      await chat.waitForFunction(() => document.querySelector('#attachmentPreviewDialog img').naturalWidth > 0);
      await chat.getByRole('button', { name: 'Close image preview', exact: true }).click();
      assert.deepEqual(errors, []);
    } finally {
      await context?.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
);

browserTest(
  'pending preference changes merge with external model selections and transactional saves',
  async () => {
    const { page, errors } = await openPage('options');
    await openSettingsSection(page, 'appearance');
    await page.locator('#fontSizeSelector').selectOption('16px');
    await page.evaluate(async () => {
      const latest = structuredClone(window.__storage.sync.config);
      latest.selectedModel = null;
      latest.selectedProvider = null;
      await chrome.storage.sync.set({ config: latest });
    });
    await page.waitForFunction(() => window.__storage.sync.config.fontSize === '16px');
    assert.equal(await page.evaluate(() => window.__storage.sync.config.selectedModel), null);
    // Opening a transaction while a preference save is pending must save both.
    await setTheme(page, 'dark');
    await openSettingsSection(page, 'roles');
    await page.locator('#addPromptBtn').click();
    await page.locator('#promptName').fill('Concise');
    await page.locator('#promptContent').fill('Keep answers concise.');
    await page.locator('#promptSaveBtn').click();
    await page.waitForFunction(() => !document.querySelector('#promptModal').open);
    assert.equal(await page.evaluate(() => window.__storage.sync.config.theme), 'dark');
    assert.equal(await page.evaluate(() => window.__storage.sync.config.systemPrompts.length), 2);
    assert.deepEqual(errors, []);
    await page.close();
  }
);

browserTest('a pending sidebar model selection survives incoming appearance settings', async () => {
  const settings = structuredClone(fixtureConfig);
  settings.providers[0].models.push({ id: 'other', name: 'Other model' });
  const { page, errors } = await openPage('sidebar', settings);
  await chooseModel(page, 'other - provider');
  await page.evaluate(async () => {
    const latest = structuredClone(window.__storage.sync.config);
    latest.theme = 'dark';
    await chrome.storage.sync.set({ config: latest });
  });
  assert.equal(await page.locator('#modelName').textContent(), 'Other model');
  assert.equal(await page.evaluate(() => state.config.selectedModel), 'other - provider');
  await page.waitForFunction(
    () => window.__storage.sync.config.selectedModel === 'other - provider'
  );
  assert.equal(await page.evaluate(() => window.__storage.sync.config.theme), 'dark');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('the model picker searches groups and selects with the keyboard without losing a draft', async () => {
  const settings = structuredClone(fixtureConfig);
  settings.providers.push({
    ...settings.providers[0], id: 'second', name: 'Research service', apiType: 'responses',
    models: [{ id: 'model', name: 'Research model' }, { id: 'deep-thinking', name: 'Deep research' }]
  });
  const { page, errors } = await openPage('sidebar', settings);
  await page.locator('#messageInput').fill('Keep my draft');
  await page.locator('#modelSelector').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#modelSearch').evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.locator('#modelOptions').getByRole('option').count(), 3);
  assert.equal(await page.locator('#modelOptions').getByRole('option', { selected: true }).count(), 1);
  await page.locator('#modelSearch').fill('research SERVICE');
  assert.equal(await page.locator('#modelOptions').getByRole('option').count(), 2);
  assert.match(await page.locator('.model-option-group-label').textContent(), /Responses/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => state.config.selectedModel), 'deep-thinking - second');
  assert.equal(await page.locator('#modelName').textContent(), 'Deep research');
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep my draft');
  assert.equal(await page.locator('#modelSelector').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#modelSelector').evaluate((node) => node === document.activeElement), true);
  await page.waitForFunction(() => window.__storage.sync.config.selectedModel === 'deep-thinking - second');
  await page.locator('#modelSelector').click();
  await page.locator('#modelSearch').fill('not-a-model');
  assert.equal(await page.locator('#modelOptions').getByRole('option').count(), 0);
  assert.equal(await page.locator('#modelPickerEmpty').isVisible(), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => state.config.selectedModel), 'deep-thinking - second');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('the model picker handles mouse selection, outside focus, IME and generation locking', async () => {
  const settings = structuredClone(fixtureConfig);
  settings.providers[0].models.push({ id: 'other', name: 'Other model' });
  const { page, errors } = await openPage('sidebar', settings);
  await chooseModel(page, 'other - provider');
  assert.equal(await page.locator('#modelName').textContent(), 'Other model');
  await page.locator('#modelSelector').click();
  await page.locator('#modelSearch').evaluate((input) => input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  ));
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), true);
  await page.locator('#messageInput').click();
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), false);
  await page.locator('#modelSelector').click();
  await page.keyboard.press('Shift+Escape');
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), false);
  assert.equal(await page.locator('#messageInput').evaluate((node) => node === document.activeElement), true);
  await page.locator('#modelSelector').click();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#manageModelsBtn').evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), false);
  await startResponse(page);
  assert.equal(await page.locator('#modelSelector').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('#modelSelector').isEnabled(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('the model picker refreshes external changes and guides an empty configuration to settings', async () => {
  const { page, errors } = await openPage();
  await page.locator('#modelSelector').click();
  await page.evaluate(async () => {
    await chrome.storage.sync.set({ config: { ...state.config, providers: [], selectedProvider: null, selectedModel: null } });
  });
  assert.equal(await page.locator('#modelOptions').getByRole('option').count(), 0);
  assert.match(await page.locator('#modelPickerEmpty').textContent(), /Add a provider/);
  assert.equal(await page.locator('#modelSearch').getAttribute('aria-activedescendant'), null);
  await page.locator('#manageModelsBtn').click();
  assert.equal(await page.evaluate(() => window.__openedOptions), true);
  assert.equal(await page.locator('#modelPickerPanel').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('unsaved drafts remain visible and retry persists the complete current chat', async () => {
  const { page, errors } = await openPage();
  await page.evaluate(() => { window.__failLocalSave = true; });
  await page.locator('#messageInput').fill('A draft that must not disappear');
  await page.evaluate(() => persistDrafts());
  assert.equal(await page.locator('#storageStatus').isVisible(), true);
  assert.equal(await page.locator('#messageInput').inputValue(), 'A draft that must not disappear');
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.locator('#retryStorageBtn').click();
  await page.waitForFunction(() => document.querySelector('#storageStatus').classList.contains('hidden'));
  assert.equal(await page.evaluate(() => normalizeDraft(window.__storage.local.drafts[state.currentSessionId]).text), 'A draft that must not disappear');
  assert.equal(await page.evaluate(() => Boolean(window.__storage.local[`session:${state.currentSessionId}`])), true);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a failed transcript load never overwrites existing history', async () => {
  const existing = { old: { title: 'Keep this chat', timestamp: new Date().toISOString(), messages: [] } };
  const { page, errors } = await openPage('sidebar', fixtureConfig, { sessions: existing, __failLoad: true });
  assert.equal(await page.locator('#storageStatus').isVisible(), true);
  assert.equal(await page.locator('#retryStorageBtn').textContent(), 'Reload');
  await page.locator('#messageInput').fill('New draft');
  await page.evaluate(() => saveToStorage());
  assert.deepEqual(await page.evaluate(() => Object.keys(window.__storage.local).filter((key) => key.startsWith('session:'))), ['session:old']);
  assert.equal(await page.evaluate(() => window.__writes.filter((write) => write.area === 'local').length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('folded reasoning skips parsing and catches up immediately on expansion', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() => {
    const parse = marked.parse;
    window.__parseCalls = 0;
    window.marked = { ...marked, parse: (...args) => { window.__parseCalls++; return parse(...args); } };
    for (let i = 0; i < 30; i++) {
      state.currentStreamingMessage.reasoning = `**Reasoning ${i}**\n\n` + 'Detailed explanation. '.repeat(4000);
      updateMessageDisplay(state.currentStreamingMessage.id);
    }
  });
  assert.equal(await page.evaluate(() => window.__parseCalls), 0);
  await page.locator('.reasoning-header').click();
  assert.match(await page.locator('.reasoning-content').textContent(), /Reasoning 29/);
  assert.equal(await page.evaluate(() => window.__parseCalls), 1);
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('long code can expand and copy completely after horizontal scrolling', async () => {
  const { page, errors } = await openPage();
  await page.setViewportSize({ width: 320, height: 640 });
  const code = Array.from({ length: 40 }, (_, i) => `const line${i} = '${'long text '.repeat(30)}';`).join('\n');
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text) => { window.__copiedText = text; } });
  });
  await startResponse(page);
  await page.evaluate((code) => { window.__stream.delta(`\`\`\`javascript\n${code}\n\`\`\``); window.__stream.complete(); }, code);
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('.code-expand-btn').getAttribute('aria-expanded'), 'false');
  await page.locator('.code-expand-btn').click();
  assert.equal(await page.locator('.code-expand-btn').getAttribute('aria-expanded'), 'true');
  await page.locator('.code-block pre').evaluate((pre) => { pre.scrollLeft = pre.scrollWidth; });
  await page.locator('.code-copy-btn').click();
  assert.equal((await page.evaluate(() => window.__copiedText)).trimEnd(), code);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => updateMessageDisplay(state.sessions[state.currentSessionId].messages.at(-1).id));
  assert.equal(await page.locator('.code-expand-btn').getAttribute('aria-expanded'), 'true');
  if (process.env.UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/code-block.png` });
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('an unconfirmed completion stays visible in the transcript and Markdown export', async () => {
  const { page, errors } = await openPage();
  await startResponse(page, 'A useful discussion');
  await delta(page, 'Partial answer');
  await page.evaluate(() => window.__stream.unconfirmed());
  await page.waitForFunction(() => !state.isStreaming);
  assert.match(await page.locator('.message.assistant .response-status').textContent(), /Completion not confirmed/);
  assert.equal(await page.locator('#sessionTitle').textContent(), 'A useful discussion');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('#chatHistoryBtn').click();
  assert.equal(await page.evaluate(() => document.querySelector('#chatHistoryDropdown').scrollWidth <= document.querySelector('#chatHistoryDropdown').clientWidth), true);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chat' }).click();
  const file = await download;
  const markdown = readFileSync(await file.path(), 'utf8');
  assert.equal(file.suggestedFilename(), 'A useful discussion.md');
  assert.match(markdown, /Partial answer/);
  assert.match(markdown, /Completion not confirmed/);
  assert.match(markdown, /Test provider \/ Test model/);
  assert.equal(markdown.includes('fixture-key'), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('keyboard shortcuts focus input and preserve drafts across new chats', async () => {
  const { page, errors } = await openPage();
  const first = await page.evaluate(() => state.currentSessionId);
  await page.locator('#messageInput').fill('Keep my first draft');
  await page.locator('#newChatBtn').focus();
  await page.keyboard.press('Shift+Escape');
  assert.equal(await page.locator('#messageInput').evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction((first) => state.currentSessionId !== first, first);
  assert.equal(await page.locator('#messageInput').inputValue(), '');
  await page.evaluate((first) => switchSession(first), first);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep my first draft');
  await page.locator('#chatHistoryBtn').click();
  const current = await page.evaluate(() => state.currentSessionId);
  await page.keyboard.press('Control+Shift+O');
  assert.equal(await page.evaluate(() => state.currentSessionId), current);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('selected text and source append to a draft once and never auto-send', async () => {
  const { page, errors } = await openPage();
  await page.locator('#messageInput').fill('My existing question');
  await page.evaluate(async () => {
    await chrome.storage.session.set({ 'selection:2': { text: 'Another window' } });
    await chrome.storage.session.set({ 'selection:1': { text: 'Quoted passage', title: 'Example article', url: 'https://example.com/article' } });
    await selectionImportQueue;
    await importSelectedText();
  });
  const draft = await page.locator('#messageInput').inputValue();
  assert.match(draft, /^My existing question/);
  assert.match(draft, /> Quoted passage/);
  assert.match(draft, /Source: Example article\nhttps:\/\/example.com\/article/);
  assert.equal(draft.split('Quoted passage').length, 2);
  assert.equal(draft.includes('Another window'), false);
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
  assert.equal(await page.evaluate(() => normalizeDraft(window.__storage.local.drafts[state.currentSessionId]).text), draft);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('UTF-8 sync quota errors keep role edits available for correction', async () => {
  const { page, errors } = await openPage('options');
  await openSettingsSection(page, 'roles');
    await page.locator('#addPromptBtn').click();
  await page.locator('#promptName').fill('Large role');
  await page.locator('#promptContent').fill('中文'.repeat(2500));
  await page.locator('#promptSaveBtn').click();
  await page.waitForFunction(() => document.querySelector('#promptModal .modal-error').textContent.includes('8 KB'));
  assert.equal(await page.locator('#promptModal').evaluate((dialog) => dialog.open), true);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.systemPrompts.length), 1);
  await page.locator('#promptContent').fill('A concise role');
  await page.locator('#promptSaveBtn').click();
  await page.waitForFunction(() => !document.querySelector('#promptModal').open);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.systemPrompts.length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('idle timeout keeps the partial answer and the next draft usable', async () => {
  const { page, errors } = await openPage();
  await page.evaluate(() => {
    const schedule = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => schedule(callback,
      delay === REQUEST_TIMEOUT_MS || delay === STREAM_IDLE_TIMEOUT_MS ? 500 : delay, ...args);
  });
  await startResponse(page);
  await delta(page, 'Keep this partial reply');
  await page.locator('#messageInput').fill('My next question');
  await page.waitForFunction(() => !state.isStreaming);
  assert.match(await page.locator('.message.assistant .response-status').textContent(), /stopped arriving/);
  assert.match(await page.locator('.message.assistant .message-content').textContent(), /Keep this partial reply/);
  assert.equal(await page.locator('#messageInput').inputValue(), 'My next question');
  assert.equal(await page.locator('#sendBtn').isEnabled(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('HTTP failures offer the relevant action and redact credentials from details', async () => {
  const { page, errors } = await openPage();
  await page.evaluate(() => { window.__httpFailure = { status: 401, message: 'Invalid API key fixture-key' }; });
  await page.locator('#messageInput').fill('A question');
  await page.locator('#messageInput').press('Enter');
  await page.waitForFunction(() => document.querySelector('.message.assistant .response-status.error'));
  assert.match(await page.locator('.message.assistant .response-status').textContent(), /Access denied/);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__openedOptions), true);
  await page.locator('.response-details summary').click();
  assert.match(await page.locator('.response-details pre').textContent(), /\[redacted\]/);
  assert.equal(await page.evaluate(() => sessionMarkdown(state.sessions[state.currentSessionId]).includes('fixture-key')), false);
  await page.evaluate(() => { window.__httpFailure = { status: 400, message: 'context_length_exceeded' }; });
  await page.getByRole('button', { name: 'Retry response' }).click();
  await page.waitForFunction(() => document.querySelector('.message.assistant .response-status')?.textContent.includes('context limit'));
  await page.getByRole('button', { name: 'Start new chat' }).click();
  await page.waitForFunction(() => state.sessions[state.currentSessionId].messages.length === 0);
  assert.equal(await page.evaluate(() => Object.keys(state.sessions).length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('queued local writes preserve the latest draft when an earlier write is delayed', async () => {
  const { page, errors } = await openPage();
  await page.evaluate(async () => {
    await storageWriteQueue;
    const set = chrome.storage.local.set;
    let first = true;
    chrome.storage.local.set = async (data) => {
      if (first) {
        first = false;
        await new Promise((resolve) => { window.__releaseWrite = resolve; });
      }
      return set(data);
    };
  });
  await page.locator('#messageInput').fill('Earlier draft');
  await page.evaluate(() => { window.__firstWrite = persistDrafts(); });
  await page.waitForFunction(() => Boolean(window.__releaseWrite));
  await page.locator('#messageInput').fill('Latest draft');
  await page.evaluate(async () => {
    const latest = saveToStorage();
    window.__releaseWrite();
    await window.__firstWrite;
    await latest;
  });
  assert.equal(await page.evaluate(() => normalizeDraft(window.__storage.local.drafts[state.currentSessionId]).text), 'Latest draft');
  assert.deepEqual(errors, []);
  await page.close();
});

// Two sidebar pages in one browser context share localStorage (backing the
// storage mock) and the real Web Locks manager, like two extension pages do.
// A write by one page reaches the other's chrome.storage.onChanged listeners
// through the `storage` event, as it would in the browser.
async function openSharedPages(initialConfig = fixtureConfig) {
  const context = await browser.newContext({ viewport: { width: 380, height: 800 }, reducedMotion: 'reduce' });
  await context.addInitScript((initialConfig) => {
    // JSON with sorted keys, like the real thing (see openPage).
    const stored = (value) =>
      JSON.parse(
        JSON.stringify(value, (key, item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : item
        )
      );
    const listeners = [];
    const area = (name) => ({
      get: async (keys) => {
        const snapshot = JSON.parse(localStorage.getItem(`fixture-${name}`) || 'null') || (name === 'sync' ? { config: initialConfig } : {});
        // Widen the read-to-write window so an unlocked merge would lose updates.
        if (name === 'local') await new Promise((resolve) => setTimeout(resolve, 40));
        return Object.fromEntries((keys || Object.keys(snapshot)).filter((key) => key in snapshot).map((key) => [key, snapshot[key]]));
      },
      set: async (data) => {
        const before = localStorage.getItem(`fixture-${name}`);
        const snapshot = JSON.parse(before || 'null') || {};
        localStorage.setItem(`fixture-${name}`, JSON.stringify(stored({ ...snapshot, ...data })));
        if (name === 'local') announce(before, localStorage.getItem('fixture-local'));
      },
      remove: async (keys) => {
        if (localStorage.getItem('fixture-fail-remove')) throw new Error('Fixture remove failure');
        const failures = Number(localStorage.getItem('fixture-fail-remove-count') || 0);
        if (failures > 0) {
          localStorage.setItem('fixture-fail-remove-count', String(failures - 1));
          throw new Error('Fixture remove failure');
        }
        const before = localStorage.getItem(`fixture-${name}`);
        const snapshot = JSON.parse(before || '{}');
        for (const key of keys) delete snapshot[key];
        localStorage.setItem(`fixture-${name}`, JSON.stringify(snapshot));
        if (name === 'local') announce(before, localStorage.getItem('fixture-local'));
      }
    });
    // Only the local area is shared with listeners: settings sync is not under
    // test here. The writing page hears its own writes too, like in Chrome.
    const announce = (oldValue, newValue) => {
      const [before, after] = [JSON.parse(oldValue || '{}'), JSON.parse(newValue || '{}')];
      const changes = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { oldValue: before[key], newValue: after[key] };
      }
      if (Object.keys(changes).length) listeners.forEach((listener) => listener(changes, 'local'));
    };
    window.addEventListener('storage', (event) => {
      if (event.key === 'fixture-local') announce(event.oldValue, event.newValue);
    });
    window.chrome = {
      storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: { addListener: (listener) => listeners.push(listener) } },
      permissions: { contains: async () => true, request: async () => true },
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: { getManifest: () => ({ version: '0' }), openOptionsPage() {} }
    };
  }, initialConfig);
  const ready = (page) =>
    page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId && document.querySelector('#generationStatus').textContent);
  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/sidebar/sidebar.html`);
    await ready(page);
    // The startup save of a first-run chat must land before the test acts or
    // the next page opens; the races under test start from a settled store.
    await page.evaluate(() => storageWriteQueue);
    return page;
  };
  const a = await open();
  const b = await open();
  return { context, a, b, open, ready };
}

const readShared = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('fixture-local')));

// The shared storage with the chats unwrapped from their `session:<id>` keys.
const readChats = async (page) => {
  const raw = await readShared(page);
  const sessions = Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => key.startsWith('session:'))
      .map(([key, entry]) => [key.slice('session:'.length), entry.session])
  );
  return { ...raw, sessions };
};
const pendingIn = (raw) => Object.keys(raw).filter((key) => key.startsWith('pending:'));
const waitForPending = (page) =>
  page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pending:')));

browserTest('concurrent side panels keep each other\'s sessions, drafts and deletions', async () => {
  const { context, a, b } = await openSharedPages();
  const shared = await a.evaluate(() => state.currentSessionId);
  assert.equal(await b.evaluate(() => state.currentSessionId), shared);

  // A starts a new chat that B has never seen; B's snapshot is now stale.
  const fresh = await a.evaluate(async () => {
    // New chat reuses a blank chat, so give this one a draft first
    state.drafts[state.currentSessionId] = 'kept';
    await createNewSession();
    state.drafts[state.currentSessionId] = 'draft from A';
    await saveToStorage();
    return state.currentSessionId;
  });

  // Both pages save at the same moment: B edits the old chat and its draft.
  await Promise.all([
    a.evaluate(() => {
      state.sessions[state.currentSessionId].messages.push({ id: 'a1', role: 'user', content: 'from A' });
      return saveToStorage();
    }),
    b.evaluate((shared) => {
      state.sessions[shared].messages.push({ id: 'b1', role: 'user', content: 'from B' });
      state.drafts[shared] = 'draft from B';
      return saveToStorage();
    }, shared)
  ]);
  let stored = await readChats(a);
  assert.deepEqual(Object.keys(stored.sessions).sort(), [fresh, shared].sort());
  assert.equal(stored.sessions[fresh].messages[0].content, 'from A');
  assert.equal(stored.sessions[shared].messages[0].content, 'from B');
  assert.equal(stored.drafts[fresh], 'draft from A');
  assert.equal(stored.drafts[shared], 'draft from B');
  assert.equal(stored.currentSessionId, fresh);

  // B deletes only its chat; A's chat and draft survive, and the deletion sticks.
  await b.evaluate((shared) => deleteSession(shared), shared);
  await b.evaluate(() => storageWriteQueue);
  stored = await readChats(a);
  assert.equal(shared in stored.sessions, false);
  assert.equal(shared in stored.drafts, false);
  assert.equal(fresh in stored.sessions, true);
  assert.equal(stored.drafts[fresh], 'draft from A');
  await context.close();
});

browserTest('a reply streamed into a chat and saved again and again stays one chat', async () => {
  // Regression: the storage returns objects with their keys reordered, and every
  // save of the growing reply used to take its own previous save for another
  // window's edit, spawning a "(conflicting copy)" chat per save.
  const { page, errors } = await openPage();
  await startResponse(page);
  for (const part of ['First part. ', 'Second part. ', 'Third part.']) {
    await delta(page, part);
    await page.evaluate(() => saveToStorage());
  }
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  await page.evaluate(() => storageWriteQueue);
  const chats = await page.evaluate(() =>
    Object.entries(window.__storage.local)
      .filter(([key]) => key.startsWith('session:'))
      .map(([, entry]) => entry.session)
  );
  assert.equal(chats.length, 1);
  assert.doesNotMatch(chats[0].title, /conflicting/);
  assert.equal(chats[0].messages.at(-1).content, 'First part. Second part. Third part.');
  assert.equal(await page.evaluate(() => Object.keys(state.sessions).length), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('two panels follow each other\'s messages without reloading', async () => {
  const { context, a, b } = await openSharedPages();
  const add = (page, id, content) =>
    page.evaluate(([id, content]) => {
      state.sessions[state.currentSessionId].messages.push({ id, role: 'user', content });
      return saveToStorage();
    }, [id, content]);
  const sees = (page, id) =>
    page.waitForFunction((id) => state.sessions[state.currentSessionId].messages.some((m) => m.id === id), id);
  await add(a, 'a1', 'from A');
  await sees(b, 'a1');
  await add(b, 'b1', 'from B');
  await sees(a, 'b1');
  const chosen = await a.evaluate(() => state.currentSessionId);
  const stored = await readChats(a);
  assert.deepEqual(stored.sessions[chosen].messages.map((m) => m.content), ['from A', 'from B']);
  assert.deepEqual(Object.keys(stored.sessions), [chosen]);
  assert.match(await b.locator('#messagesList').textContent(), /from A/);
  await context.close();
});

browserTest('a panel with unsaved messages merges in what the other panel saved', async () => {
  const { context, a, b } = await openSharedPages();
  const chosen = await a.evaluate(() => state.currentSessionId);
  // B has typed into the chat but not saved when A's message lands.
  await b.evaluate(() => state.sessions[state.currentSessionId].messages.push({ id: 'b1', role: 'user', content: 'from B' }));
  await a.evaluate(() => {
    state.sessions[state.currentSessionId].messages.push({ id: 'a1', role: 'user', content: 'from A' });
    return saveToStorage();
  });
  assert.deepEqual(await b.evaluate(() => state.sessions[state.currentSessionId].messages.map((m) => m.id)), ['b1'], 'unsaved work is not replaced');
  await b.evaluate(() => saveToStorage());
  const stored = await readChats(a);
  assert.deepEqual(stored.sessions[chosen].messages.map((m) => m.id), ['a1', 'b1']);
  assert.deepEqual(await b.evaluate(() => state.sessions[state.currentSessionId].messages.map((m) => m.id)), ['a1', 'b1']);
  await a.waitForFunction(() => state.sessions[state.currentSessionId].messages.length === 2);
  assert.deepEqual(Object.keys(stored.sessions), [chosen]);
  await context.close();
});

browserTest('when both panels edit the same message the later save wins, in one chat', async () => {
  const { context, a, b } = await openSharedPages();
  const chosen = await a.evaluate(async () => {
    state.sessions[state.currentSessionId].messages.push({ id: 'm1', role: 'user', content: 'original' });
    await saveToStorage();
    return state.currentSessionId;
  });
  await b.waitForFunction(() => state.sessions[state.currentSessionId].messages.length === 1);
  await b.evaluate(() => { state.sessions[state.currentSessionId].messages[0].content = 'B edit'; });
  await a.evaluate(() => { state.sessions[state.currentSessionId].messages[0].content = 'A edit'; return saveToStorage(); });
  assert.equal((await readChats(a)).sessions[chosen].messages[0].content, 'A edit');
  assert.equal(await b.evaluate(() => state.sessions[state.currentSessionId].messages[0].content), 'B edit', 'unsaved edit is kept');
  await b.evaluate(() => saveToStorage());
  const stored = await readChats(a);
  assert.deepEqual(Object.keys(stored.sessions), [chosen]);
  assert.equal(stored.sessions[chosen].messages[0].content, 'B edit');
  assert.doesNotMatch(stored.sessions[chosen].title, /conflicting/);
  await a.waitForFunction(() => state.sessions[state.currentSessionId].messages[0].content === 'B edit');
  assert.equal(await a.evaluate(() => Object.keys(state.sessions).length), 1);
  await context.close();
});

browserTest('a deleted chat stays deleted when a panel reloads', async () => {
  const { context, a, b, ready } = await openSharedPages();
  const [old, fresh] = await a.evaluate(async () => {
    state.drafts[state.currentSessionId] = 'keeps the first chat';
    const old = state.currentSessionId;
    await createNewSession();
    await saveToStorage();
    return [old, state.currentSessionId];
  });
  await b.waitForFunction((fresh) => fresh in state.sessions, fresh);
  await a.evaluate((old) => deleteSession(old), old);
  await a.evaluate(() => storageWriteQueue);
  assert.deepEqual(Object.keys((await readChats(a)).sessions), [fresh]);
  await b.reload();
  await ready(b);
  assert.equal(await b.evaluate((old) => old in state.sessions, old), false);
  await context.close();
});

browserTest('chats saved by the one-table layout are converted, and streaming-bug copies fold back', async () => {
  const timestamp = new Date().toISOString();
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const copy1 = `conflict-${root}-11111111-1111-4111-8111-111111111111`;
  const copy2 = `conflict-${copy1}-22222222-2222-4222-8222-222222222222`;
  const suffix = ' (conflicting copy)';
  const reply = (content, title) => ({
    title,
    timestamp,
    messages: [
      { id: 'u1', role: 'user', content: 'Explain it', timestamp },
      { id: 'a1', role: 'assistant', content, timestamp }
    ]
  });
  const old = {
    [root]: reply('Sure', 'Explain it'),
    [copy1]: reply('Sure, here is', `Explain it${suffix}`),
    [copy2]: reply('Sure, here is the whole explanation.', `Explain it${suffix}${suffix}`),
    other: { title: 'Other', timestamp, messages: [{ id: 'o1', role: 'user', content: 'Unrelated', timestamp }] }
  };
  const { page, errors } = await openPage('sidebar', fixtureConfig, {
    __legacyLayout: true,
    sessions: old,
    currentSessionId: copy2,
    drafts: { [copy2]: 'half-typed' }
  });
  assert.deepEqual(await page.evaluate(() => Object.keys(state.sessions).sort()), [root, 'other'].sort());
  assert.equal(await page.evaluate(() => state.currentSessionId), root);
  assert.match(await page.locator('#messagesList').textContent(), /the whole explanation/);
  assert.equal(await page.locator('#messageInput').inputValue(), 'half-typed');
  assert.match(await page.locator('.notification').textContent(), /Merged 2 duplicate chats/);
  const local = await page.evaluate(() => window.__storage.local);
  assert.equal('sessions' in local, false);
  assert.deepEqual(Object.keys(local['backup:sessions-v1']).sort(), Object.keys(old).sort());
  assert.deepEqual(Object.keys(local).filter((key) => key.startsWith('session:')).sort(), [`session:${root}`, 'session:other'].sort());
  assert.equal(local[`session:${root}`].session.title, 'Explain it');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a panel that stays open folds in what a closing panel left behind', async () => {
  const { context, a, b, open } = await openSharedPages();
  const p = await open();
  await p.evaluate(() => {
    state.sessions.closing = { title: 'Closing chat', timestamp: new Date().toISOString(), messages: [{ id: 'm1', role: 'user', content: 'written just before closing' }] };
    state.drafts.closing = 'unsent';
    window.dispatchEvent(new Event('pagehide'));
  });
  // The open panels fold the stash the moment it appears.
  await p.close();
  for (const page of [a, b]) await page.waitForFunction(() => 'closing' in state.sessions);
  await a.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pending:')));
  const stored = await readChats(a);
  assert.equal(stored.sessions.closing.messages[0].content, 'written just before closing');
  assert.equal(stored.drafts.closing, 'unsent');
  assert.deepEqual(pendingIn(stored), []);
  assert.equal('appliedPending' in stored, false);
  await context.close();
});

browserTest('a stash whose cleanup keeps failing is not replayed over a newer saved draft', async () => {
  const { context, a, open } = await openSharedPages();
  const id = await a.evaluate(() => state.currentSessionId);
  const p = await open();
  // Whatever page folds the stash writes it and then cannot delete it.
  await a.evaluate(() => localStorage.setItem('fixture-fail-remove', '1'));
  await p.evaluate((id) => { state.drafts[id] = 'P pending draft'; window.dispatchEvent(new Event('pagehide')); }, id);
  await waitForPending(p);
  await p.close();
  await a.waitForFunction((id) => JSON.parse(localStorage.getItem('fixture-local')).drafts?.[id] === 'P pending draft', id);
  await a.evaluate(() => storageWriteQueue);

  // A newer draft is saved while the stash is still around.
  await a.evaluate((id) => { state.drafts[id] = 'A newer saved draft'; return saveToStorage(); }, id);
  assert.equal((await readShared(a)).drafts[id], 'A newer saved draft');
  assert.equal(pendingIn(await readShared(a)).length, 1);

  // The next page to start removes the stash without replaying it.
  await a.evaluate(() => localStorage.removeItem('fixture-fail-remove'));
  const c = await open();
  const stored = await readShared(c);
  assert.equal(stored.drafts[id], 'A newer saved draft');
  assert.deepEqual(pendingIn(stored), []);
  await context.close();
});

browserTest('a closing page never rewrites shared tables over a paused locked write', async () => {
  const { context, a, b, open } = await openSharedPages();
  // A takes the lock, reads the shared tables, and pauses before writing.
  await a.evaluate(() => {
    const get = chrome.storage.local.get;
    window.__gate = new Promise((resolve) => { window.__openGate = resolve; });
    chrome.storage.local.get = async (...args) => { const value = await get(...args); await window.__gate; return value; };
    state.drafts.fromA = 'draft A';
    window.__aSave = saveToStorage();
  });
  // B creates a chat and a draft, then is closed (pagehide) while A is paused.
  await b.evaluate(async () => {
    await storageWriteQueue;
    state.sessions.fromB = { messages: [{ id: 'b', role: 'user', content: 'B chat' }], title: 'B chat', timestamp: new Date().toISOString() };
    state.drafts.fromB = 'draft B';
    window.dispatchEvent(new Event('pagehide'));
  });
  await waitForPending(b);
  assert.equal('session:fromB' in (await readShared(a)), false, 'the stash did not touch the shared tables');
  await a.evaluate(async () => { window.__openGate(); await window.__aSave; });
  await b.close();
  // A new page folds the closed page's changes in; nothing was lost.
  const c = await open();
  assert.equal(await c.evaluate(() => state.sessions.fromB?.messages[0].content), 'B chat');
  assert.equal(await c.evaluate(() => state.drafts.fromB), 'draft B');
  assert.equal(await c.evaluate(() => state.drafts.fromA), 'draft A');
  await c.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pending')));
  await context.close();
});

browserTest('remote Markdown images wait for a click and load without a referrer', async () => {
  const requested = [];
  const seeded = {
    currentSessionId: 'history',
    sessions: {
      history: {
        title: 'History',
        timestamp: new Date().toISOString(),
        messages: [
          { id: 'u', role: 'user', content: 'Show me' },
          {
            id: 'img', role: 'assistant', content: 'Body ![body](https://review-external.invalid/pixel?q=SECRET)\n\n![js](javascript:alert(1))',
            reasoning: 'Idea ![r](https://review-external.invalid/reasoning?q=SECRET)'
          }
        ]
      }
    }
  };
  // The interceptor is installed before the first render of the saved chat.
  const { page, errors } = await openPage('sidebar', fixtureConfig, seeded, (page) =>
    page.route('https://review-external.invalid/**', (route) => {
      requested.push(route.request().url());
      return route.abort();
    })
  );
  assert.equal(await page.evaluate(() => state.currentSessionId), 'history');
  await page.locator('.message.assistant .reasoning-header, .message.assistant .message-toggle').first().click().catch(() => {});
  assert.equal(await page.locator('.message.assistant img[src]').count(), 0);
  assert.equal(await page.locator('.message.assistant .remote-image-btn').count(), 2);
  await page.waitForTimeout(150);
  assert.deepEqual(requested, []);
  await page.locator('.message-content .remote-image-btn').click();
  await page.waitForFunction(() => document.querySelector('.message-content img[src]'));
  await page.waitForTimeout(150);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/pixel\?q=SECRET$/);
  assert.equal(await page.locator('.message-content img[src]').getAttribute('referrerpolicy'), 'no-referrer');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('welcome prompt suggestions keep an existing draft', async () => {
  const { page, errors } = await openPage();
  await page.locator('#messageInput').fill('My unsent thought');
  await page.locator('.prompt-suggestion').first().click();
  const value = await page.locator('#messageInput').inputValue();
  assert.equal(value.startsWith('My unsent thought\n\nPlease help me polish'), true);
  await page.waitForFunction(() => normalizeDraft(state.drafts[state.currentSessionId]).text.startsWith('My unsent thought'));
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('inline think tags stream into the reasoning panel and leave a clean answer', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() => window.__stream.delta('<think>Planning the steps'));
  await page.waitForFunction(() => document.querySelector('.message.assistant .reasoning-header'));
  assert.equal(await page.locator('.message.assistant .message-content').textContent(), '');
  await page.locator('.reasoning-header').click();
  assert.match(await page.locator('.reasoning-content').textContent(), /Planning the steps/);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/inline-think.png` });
  await page.evaluate(() => window.__stream.delta(' carefully.</think>\n\nHere is the answer.'));
  await page.waitForFunction(() =>
    document.querySelector('.message.assistant .message-content').textContent.includes('Here is the answer'));
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  const stored = await page.evaluate(() => state.sessions[state.currentSessionId].messages.at(-1));
  assert.equal(stored.content, 'Here is the answer.');
  assert.equal(stored.reasoning, 'Planning the steps carefully.');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a reply stopped mid-thought keeps its thinking as reasoning', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() => window.__stream.delta('<think>Still weighing'));
  await page.waitForFunction(() => document.querySelector('.message.assistant .reasoning-header'));
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming);
  const stored = await page.evaluate(() => state.sessions[state.currentSessionId].messages.at(-1));
  assert.equal(stored.reasoning, 'Still weighing');
  assert.equal(stored.content, '');
  assert.equal(stored.stopped, true);
  // The empty answer is not replayed as an assistant turn
  await page.locator('#messageInput').fill('Go on');
  await page.locator('#messageInput').press('Enter');
  await page.waitForFunction(() => window.__fetchCalls.length === 2);
  const roles = await page.evaluate(() => window.__fetchCalls[1].messages.map((m) => m.role));
  assert.deepEqual(roles, ['system', 'user', 'user']);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('New chat reuses a blank chat, and blank chats stay out of history', async () => {
  const timestamp = new Date().toISOString();
  const { page, errors } = await openPage('sidebar', fixtureConfig, {
    currentSessionId: 'kept',
    sessions: {
      kept: { title: 'Kept', timestamp, messages: [{ id: 'k1', role: 'user', content: 'Hi', timestamp }] },
      leftover: { title: 'New Chat', timestamp, messages: [] }
    }
  });
  await page.locator('#newChatBtn').click();
  const blank = await page.evaluate(() => state.currentSessionId);
  assert.notEqual(blank, 'kept');
  await page.locator('#newChatBtn').click();
  assert.equal(await page.evaluate(() => state.currentSessionId), blank);
  await page.locator('#chatHistoryBtn').click();
  // The open blank chat is listed; the one left over from before is not
  assert.equal(await page.locator('.chat-history-item').count(), 2);
  await page.locator('.chat-history-content', { hasText: 'Kept' }).click();
  assert.equal(await page.evaluate((blank) => blank in state.sessions, blank), false);
  await page.waitForFunction((blank) => !(`session:${blank}` in window.__storage.local), blank);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('undoing the deletion of the open chat returns to it', async () => {
  const timestamp = new Date().toISOString();
  const { page, errors } = await openPage('sidebar', fixtureConfig, {
    currentSessionId: 'only',
    sessions: { only: { title: 'Only chat', timestamp, messages: [{ id: 'o1', role: 'user', content: 'Hello there', timestamp }] } }
  });
  await page.locator('#chatHistoryBtn').click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  assert.notEqual(await page.evaluate(() => state.currentSessionId), 'only');
  await page.locator('#historyUndoBtn').click();
  assert.equal(await page.evaluate(() => state.currentSessionId), 'only');
  // The blank chat created to replace it is gone again
  assert.deepEqual(await page.evaluate(() => Object.keys(state.sessions)), ['only']);
  assert.match(await page.locator('#messagesList').textContent(), /Hello there/);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a provider blocked for lack of host access offers to allow it and retries', async () => {
  const { page, errors } = await openPage();
  await page.evaluate(() => {
    chrome.permissions.contains = async () => false;
    chrome.permissions.request = async ({ origins }) => {
      window.__requested = origins;
      chrome.permissions.contains = async () => true;
      return true;
    };
    const fixtureFetch = window.fetch;
    window.__blocked = true;
    window.fetch = async (url, options) => {
      if (window.__blocked) throw new TypeError('Failed to fetch');
      return fixtureFetch(url, options);
    };
  });
  await page.locator('#messageInput').fill('Hello');
  await page.locator('#messageInput').press('Enter');
  await page.waitForFunction(() => document.querySelector('.message.assistant .response-status.error'));
  assert.match(await page.locator('.message.assistant .response-status').textContent(), /permission to connect to provider\.test/);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/host-access.png` });
  await page.evaluate(() => { window.__blocked = false; });
  await page.getByRole('button', { name: 'Allow access' }).click();
  await page.waitForFunction(() => window.__fetchCalls.length === 1 && state.isStreaming);
  assert.deepEqual(await page.evaluate(() => window.__requested), ['https://provider.test/*']);
  await delta(page, 'Connected answer');
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('.message.assistant').count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('task lists keep their state and tables keep their alignment', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() => window.__stream.delta('- [x] Done\n- [ ] Todo\n\n| L | C |\n| - | :-: |\n| a | b |\n\n* [x] Loose\n\n* [ ] items'));
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('.message-content input').count(), 0);
  assert.deepEqual(await page.locator('.task-checkbox').allTextContents(), ['☑', '☐', '☑', '☐']);
  assert.equal(await page.locator('li.task-item').count(), 4);
  assert.equal(await page.locator('.message-content td').nth(1).evaluate((td) => getComputedStyle(td).textAlign), 'center');
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/task-list.png` });
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('settings check a provider connection and suggest its model IDs', async () => {
  const { page, errors } = await openPage('options');
  await page.evaluate(() => {
    const fixtureFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url) !== 'https://provider.test/v1/models') return fixtureFetch(url, options);
      window.__modelsAuth = options.headers.Authorization;
      return Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] });
    };
  });
  await page.getByRole('button', { name: 'Edit Test provider' }).click();
  await page.locator('#checkConnectionBtn').click();
  await page.waitForFunction(() => document.querySelector('#connectionStatus').dataset.state === 'saved');
  assert.match(await page.locator('#connectionStatus').textContent(), /2 models available/);
  assert.equal(await page.evaluate(() => window.__modelsAuth), 'Bearer fixture-key');
  assert.deepEqual(
    await page.locator('#modelSuggestions option').evaluateAll((options) => options.map((o) => o.value)),
    ['model-a', 'model-b']
  );
  await page.locator('#addModelBtn').click();
  await page.locator('.model-id').last().fill('model-b');
  await page.locator('.model-id').last().dispatchEvent('change');
  assert.equal(await page.locator('.model-name').last().inputValue(), 'model-b');
  if (process.env.UI_SCREENSHOTS)
    await page.locator('#providerModal .modal-panel').screenshot({ path: `${process.env.UI_SCREENSHOTS}/connection-check.png` });
  await page.locator('#providerApiKey').fill('changed');
  assert.equal(await page.locator('#connectionStatus').textContent(), '');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('changing connection details discards an older check result', async () => {
  const { page, errors } = await openPage('options');
  await page.evaluate(() => {
    window.fetch = () => new Promise((resolve) => {
      window.__finishCheck = () => resolve(Response.json({ data: [{ id: 'outdated-model' }] }));
    });
  });
  await page.getByRole('button', { name: 'Edit Test provider' }).click();
  await page.locator('#checkConnectionBtn').click();
  await page.waitForFunction(() => Boolean(window.__finishCheck));
  await page.locator('#providerApiKey').fill('new-key');
  await page.evaluate(async () => {
    window.__finishCheck();
    await new Promise(requestAnimationFrame);
  });
  assert.equal(await page.locator('#connectionStatus').textContent(), '');
  assert.equal(await page.locator('#modelSuggestions option').count(), 0);
  assert.equal(await page.locator('#checkConnectionBtn').isEnabled(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('role deletion confirms intent and keeps failed deletion visible in the editor', async () => {
  const { page, errors } = await openPage('options', {
    ...fixtureConfig,
    selectedSystemPrompt: 'custom',
    systemPrompts: [...fixtureConfig.systemPrompts, { id: 'custom', name: 'My role', content: 'Be concise.' }]
  });
  await openSettingsSection(page, 'roles');
  await page.getByRole('button', { name: 'Edit My role' }).click();
  await page.getByRole('button', { name: 'Delete My role', exact: true }).click();
  await page.locator('#confirmCancel').click();
  assert.equal(await page.locator('#promptModal').evaluate((node) => node.open), true);
  await page.evaluate(() => { window.__failSave = true; });
  await page.getByRole('button', { name: 'Delete My role', exact: true }).click();
  await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => document.querySelector('#promptModal .modal-error').textContent.includes('not deleted'));
  assert.equal(await page.locator('#promptModal .modal-error').isVisible(), true);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.systemPrompts.length), 2);
  await page.evaluate(() => { window.__failSave = false; });
  await page.getByRole('button', { name: 'Delete My role', exact: true }).click();
  await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => !document.querySelector('#promptModal').open);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.selectedSystemPrompt), 'default');
  assert.equal(await page.evaluate(() => window.__storage.sync.config.systemPrompts.length), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a provider not yet allowed on this device can be allowed from its row', async () => {
  const { page, errors } = await openPage('options');
  await page.evaluate(() => {
    chrome.permissions.contains = async () => false;
    chrome.permissions.request = async () => {
      chrome.permissions.contains = async () => true;
      return true;
    };
    renderProviders();
  });
  const allow = page.getByRole('button', { name: 'Allow access to Test provider' });
  await allow.waitFor();
  if (process.env.UI_SCREENSHOTS)
    await page.locator('#providers').screenshot({ path: `${process.env.UI_SCREENSHOTS}/provider-access.png` });
  await allow.click();
  await page.waitForFunction(() => document.querySelector('.provider-access').classList.contains('hidden'));
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('deleting a provider releases host access no other provider uses', async () => {
  const shared = {
    ...fixtureConfig,
    providers: [
      fixtureConfig.providers[0],
      { ...fixtureConfig.providers[0], id: 'twin', name: 'Twin provider' },
      { ...fixtureConfig.providers[0], id: 'other', name: 'Other provider', baseUrl: 'https://other.test/v1' }
    ]
  };
  const { page, errors } = await openPage('options', shared);
  await page.evaluate(() => {
    window.__removed = [];
    chrome.permissions.remove = async ({ origins }) => { window.__removed.push(...origins); return true; };
  });
  for (const name of ['Twin provider', 'Other provider']) {
    if (name === 'Twin provider') {
      await page.getByRole('button', { name: `Edit ${name}` }).click();
      await page.locator('#providerDeleteBtn').click();
    } else {
      await page.locator('#providers').getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    }
    await page.locator('#confirmAccept').click();
    await page.waitForFunction((name) => !window.__storage.sync.config.providers.some((p) => p.name === name), name);
  }
  // provider.test is still used by the first provider
  assert.deepEqual(await page.evaluate(() => window.__removed), ['https://other.test/*']);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('deleting from the provider list supports cancellation and a failed-save retry', async () => {
  const { page, errors } = await openPage('options');
  const remove = page.getByRole('button', { name: 'Delete Test provider', exact: true });
  await remove.click();
  await page.locator('#confirmCancel').click();
  assert.equal(await page.locator('.provider-item').count(), 1);
  await page.evaluate(() => { window.__failSave = true; });
  await remove.click();
  await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => document.querySelector('#notifications').textContent.includes('not deleted'));
  assert.equal(await remove.isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.providers.length), 1);
  await page.evaluate(() => { window.__failSave = false; });
  await remove.click();
  await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => window.__storage.sync.config.providers.length === 0);
  assert.equal(await page.locator('#providerModal').evaluate((node) => node.open), false);
  assert.equal(await page.locator('.provider-item').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('appending messages preserves attached transcript nodes and regeneration releases discarded nodes', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await delta(page, 'The original answer.');
  await page.evaluate(() => window.__stream.complete());
  await page.waitForFunction(() => !state.isStreaming);
  const unchanged = await page.evaluate(() => {
    const list = elements.messagesList;
    const observer = new MutationObserver(() => {});
    observer.observe(list, { childList: true });
    renderMessages();
    const count = observer.takeRecords().length;
    observer.disconnect();
    window.__firstQuestion = list.firstElementChild;
    return count;
  });
  assert.equal(unchanged, 0, 'rendering unchanged messages does not detach them');
  for (let i = 0; i < 4; i++) {
    await page.locator('.message.assistant .regenerate-btn').click();
    await page.waitForFunction(() => state.isStreaming);
    await delta(page, `Replacement ${i}.`);
    await page.evaluate(() => window.__stream.complete());
    await page.waitForFunction(() => !state.isStreaming);
    assert.deepEqual(await page.evaluate(() => ({
      cache: messageElementCache.size,
      messages: state.sessions[state.currentSessionId].messages.length,
      detached: [...messageElementCache.values()].filter((node) => !node.isConnected).length,
      sameQuestion: elements.messagesList.firstElementChild === window.__firstQuestion
    })), { cache: 2, messages: 2, detached: 0, sameQuestion: true });
  }
  await page.locator('#undoBtn').click();
  await page.waitForFunction(() => document.querySelector('.message.assistant .message-content').textContent.trim() === 'Replacement 2.');
  assert.equal(await page.evaluate(() => messageElementCache.size), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('streaming preserves completed Markdown blocks and applies late reference definitions', async () => {
  const { page, errors } = await openPage();
  await page.route('https://images.example.test/**', (route) => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
  }));
  await startResponse(page);
  await page.evaluate(() => window.__stream.delta('Stable paragraph.\n\n[Reference][target]\n\n| Left | Right |\n| - | - |\n| a | b |\n\n![Example](https://images.example.test/preview.svg)\n\n```javascript\nconst value = 1;'));
  await page.waitForFunction(() => document.querySelector('.message.assistant pre code')?.textContent.includes('const value = 1;'));
  await page.locator('.message-content .remote-image-btn').click();
  await page.evaluate(() => {
    const content = document.querySelector('.message.assistant .message-content');
    window.__stableParagraph = content.firstElementChild;
    window.__loadedImage = content.querySelector('img[src]');
    window.__table = content.querySelector('.table-scroll');
    window.__table.querySelector('table').style.width = '1000px';
    window.__table.scrollLeft = 120;
  });
  await page.evaluate(() => window.__stream.delta('\n```\n\n[target]: https://example.com/late\n\nA final paragraph.'));
  await page.waitForFunction(() => document.querySelector('.message.assistant a')?.href === 'https://example.com/late');
  assert.equal(await page.evaluate(() => document.querySelector('.message.assistant .message-content').firstElementChild === window.__stableParagraph), true);
  assert.equal(await page.locator('.message.assistant pre').count(), 1);
  assert.deepEqual(await page.evaluate(() => ({
    sameImage: document.querySelector('.message-content img[src]') === window.__loadedImage,
    sameTable: document.querySelector('.table-scroll') === window.__table,
    scrollLeft: window.__table.scrollLeft
  })), { sameImage: true, sameTable: true, scrollLeft: 120 });
  await page.evaluate(() => {
    const parse = marked.parse;
    window.__finalParseCalls = 0;
    window.marked = { ...marked, parse: (...args) => { window.__finalParseCalls++; return parse(...args); } };
    window.__stream.complete();
  });
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.evaluate(() => window.__finalParseCalls), 0, 'finishing unchanged Markdown does not parse it again');
  assert.equal(await page.evaluate(() => document.querySelector('.message.assistant .message-content').firstElementChild === window.__stableParagraph), true);
  assert.equal(await page.locator('.message.assistant .code-copy-btn').count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('history pages remain searchable and renaming an inactive chat persists without evicting other search entries', async () => {
  const timestamp = new Date().toISOString();
  const sessions = Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`h${i}`, {
    title: `Conversation ${i}`, timestamp, messages: [{ id: `q${i}`, role: 'user', content: i === 124 ? 'A rare pineapple.' : 'An ordinary question.', timestamp }]
  }]));
  const { page, errors } = await openPage('sidebar', fixtureConfig, { sessions, currentSessionId: 'h0' });
  await page.locator('#chatHistoryBtn').click();
  assert.equal(await page.locator('.chat-history-item').count(), 50);
  await page.getByRole('button', { name: 'Show more conversations' }).click();
  assert.equal(await page.locator('.chat-history-item').count(), 100);
  await page.locator('#historySearch').fill('pineapple');
  await page.waitForFunction(() => document.querySelectorAll('.chat-history-item').length === 1);
  assert.match(await page.locator('.chat-history-title').textContent(), /124/);
  await page.evaluate(() => sessionSearchText('h1'));
  await page.getByRole('button', { name: 'Rename chat' }).click();
  await page.locator('.history-rename-input').fill('Renamed conversation');
  await page.locator('.history-rename-input').press('Enter');
  await page.evaluate(() => storageWriteQueue);
  assert.equal(await page.evaluate(() => window.__storage.local['session:h124'].session.title), 'Renamed conversation');
  assert.equal(await page.evaluate(() => sessionSearchCache.has('h1')), true);
  await page.locator('#historySearch').fill('renamed conversation');
  await page.waitForFunction(() => document.querySelector('.chat-history-title')?.textContent === 'Renamed conversation');
  assert.equal(await page.locator('.chat-history-item').count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

// Opt-in measurements, without timing assertions that depend on the host CPU.
if (process.env.SIDEMIND_BENCHMARK) {
  browserTest('sidebar performance benchmark', async (t) => {
    const { page, errors } = await openPage();
    await startResponse(page);
    const report = await page.evaluate(async () => {
      const measure = (run, count = 7) => {
        run();
        const samples = Array.from({ length: count }, () => {
          const started = performance.now();
          run();
          return performance.now() - started;
        }).sort((a, b) => a - b);
        return +samples[Math.floor(samples.length / 2)].toFixed(2);
      };
      const paragraph = '### Example\n\nA paragraph with **bold text**, `inline code`, and a [link](https://example.com).\n\n- First point\n- Second point\n\n';
      const message = state.currentStreamingMessage;
      const results = { userAgent: navigator.userAgent, streamRender: [], storageDiff: [], history: [], conversation: [] };
      for (const chars of [10000, 50000, 100000]) {
        const text = paragraph.repeat(Math.ceil(chars / paragraph.length)).slice(0, chars);
        let suffix = 0;
        const medianMs = measure(() => {
          message.content = text + (++suffix);
          updateMessageDisplay(message.id);
        });
        results.streamRender.push({ chars, medianMs });
      }
      await handleStopGeneration();
      await storageWriteQueue;
      for (const count of [10, 100, 500]) {
        const content = 'Historical content. '.repeat(5000);
        state.sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, {
          title: `Chat ${i}`, timestamp: new Date().toISOString(), messages: [{ id: `q${i}`, role: 'user', content }]
        }]));
        state.currentSessionId = 's0';
        rememberSaved(state.sessions, {}, {}, 's0');
        results.storageDiff.push({ count, charsPerSession: content.length, medianMs: measure(() => collectChanges(true), 5) });
        elements.historySearch.value = '';
        results.history.push({ count, medianMs: measure(() => renderChatHistory(), 5), rows: elements.chatHistoryList.querySelectorAll('.chat-history-item').length });
      }
      for (const count of [50, 200, 500]) {
        state.sessions = { chat: { title: 'Bench', timestamp: new Date().toISOString(), messages: Array.from({ length: count }, (_, i) => ({
          id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: paragraph.repeat(4), timestamp: new Date().toISOString()
        })) } };
        state.currentSessionId = 'chat';
        messageElementCache.clear();
        const started = performance.now();
        renderMessages();
        const coldMs = +(performance.now() - started).toFixed(2);
        results.conversation.push({ count, coldMs, cachedMedianMs: measure(() => renderMessages(), 5) });
      }
      return results;
    });
    t.diagnostic(JSON.stringify(report));
    assert.deepEqual(errors, []);
    await page.close();
  });
}

const attachmentPng = { name: 'pixel.png', mimeType: 'image/png', buffer: readFileSync(resolve(root, 'icons/icon16.png')) };
const attachmentText = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment contract: original text.') };

function serverConversationConfig() {
  const config = structuredClone(fixtureConfig);
  Object.assign(config.providers[0], { apiType: 'responses', serverConversation: true });
  config.temperature = null;
  config.stream = false;
  return config;
}

async function useServerConversationFixture(page) {
  await page.evaluate(() => {
    window.__serverCalls = [];
    window.__serverBehavior = 'complete';
    window.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      window.__serverCalls.push({ url: String(url), body });
      if (String(url).endsWith('/conversations')) {
        if (window.__serverBehavior === 'missing-id') return Response.json({ object: 'conversation' });
        return Response.json({ id: `conv_${window.__serverCalls.filter((call) => call.url.endsWith('/conversations')).length}` });
      }
      if (window.__serverBehavior === 'network') throw new TypeError('Connection lost after submission');
      const response = {
        id: `resp_${window.__serverCalls.length}`, status: 'completed', conversation: { id: body.conversation },
        output: [{ id: 'msg_server', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Server answer', annotations: [] }] }]
      };
      if (window.__serverBehavior === 'stall') {
        let writer;
        const stream = new ReadableStream({ start(controller) { writer = controller; } });
        writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\n`));
        options.signal.addEventListener('abort', () => writer.error(options.signal.reason), { once: true });
        window.__finishServer = () => {
          writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`));
          writer.close();
        };
        return new Response(stream);
      }
      return body.stream
        ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
        : Response.json(response);
    };
  });
}

browserTest('server conversation option defaults off, follows protocol and survives editing', async () => {
  const { page, errors } = await openPage('options');
  await page.getByRole('button', { name: 'Edit Test provider' }).click();
  assert.equal(await page.locator('#providerServerConversationGroup').isVisible(), false);
  await page.locator('#providerApiType').selectOption('responses');
  assert.equal(await page.locator('#providerServerConversationGroup').isVisible(), true);
  assert.equal(await page.locator('#providerServerConversation').isChecked(), false);
  await page.locator('#providerServerConversation').check();
  await page.locator('#providerSaveBtn').click();
  await page.waitForFunction(() => !document.querySelector('#providerModal').open);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.providers[0].serverConversation), true);
  assert.match(await page.locator('.provider-api').textContent(), /Server session/);
  await page.getByRole('button', { name: 'Edit Test provider' }).click();
  assert.equal(await page.locator('#providerServerConversation').isChecked(), true);
  await page.locator('#providerApiType').selectOption('chat');
  assert.equal(await page.locator('#providerServerConversation').isDisabled(), true);
  await page.locator('#providerSaveBtn').click();
  await page.waitForFunction(() => !document.querySelector('#providerModal').open);
  assert.equal(await page.evaluate(() => window.__storage.sync.config.providers[0].serverConversation), false);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('server conversations keep local history but send only new attachments and reuse the ID after reload', async () => {
  const { page, errors } = await openPage('sidebar', serverConversationConfig());
  await useServerConversationFixture(page);
  assert.equal(await page.locator('#systemPromptSelector').isDisabled(), false);
  await page.locator('#attachmentInput').setInputFiles([attachmentPng, attachmentText]);
  await page.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 2);
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 2);
  const first = await page.evaluate(() => window.__serverCalls);
  assert.match(first[0].url, /\/conversations$/);
  assert.deepEqual(first[0].body, {});
  assert.equal(first[1].body.conversation, 'conv_1');
  assert.equal(first[1].body.input.length, 1);
  assert.deepEqual(first[1].body.input[0].content.map((part) => part.type), ['input_image', 'input_file']);
  assert.equal(first[1].body.instructions, 'Be helpful.', 'instructions apply per response, so every server turn sends them');
  assert.equal(await page.locator('.edit-btn').isDisabled(), true);
  assert.equal(await page.locator('.regenerate-btn').isDisabled(), true);
  await page.evaluate(async () => {
    await saveToStorage();
    sessionStorage.setItem('sidemind-fixture-reload', JSON.stringify(window.__storage));
  });
  await page.reload();
  await page.waitForFunction(() => state.currentSessionId && document.querySelector('#generationStatus').textContent);
  await useServerConversationFixture(page);
  await page.locator('#messageInput').fill('Follow up after reload');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__serverCalls[0].body.input), [{ role: 'user', content: 'Follow up after reload' }]);
  assert.equal(await page.evaluate(() => window.__serverCalls[0].body.conversation), 'conv_1');
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages.length), 4);
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages[0].attachments.length), 2);
  await page.locator('#newChatBtn').click();
  await page.locator('#messageInput').fill('A separate conversation');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 3);
  assert.match(await page.evaluate(() => window.__serverCalls[1].url), /\/conversations$/);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('server preparation failure keeps draft and attachments without dispatching user input', async () => {
  const { page, errors } = await openPage('sidebar', serverConversationConfig());
  await useServerConversationFixture(page);
  await page.evaluate(() => { window.__serverBehavior = 'missing-id'; });
  await page.locator('#messageInput').fill('Keep this draft');
  await page.locator('#attachmentInput').setInputFiles(attachmentText);
  await page.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 1);
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 1);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages.length), 0);
  assert.equal(await page.evaluate(() => normalizeDraft(state.drafts[state.currentSessionId]).attachments.length), 1);
  await page.evaluate(() => { window.__serverBehavior = 'complete'; window.__failLocalSave = true; });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => document.querySelector('#storageStatus').classList.contains('hidden') === false);
  assert.equal(await page.evaluate(() => window.__serverCalls.filter((call) => call.url.endsWith('/responses')).length), 0,
    'an empty remote conversation is harmless; failed persistence must prevent user input from being dispatched');
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('server turns stopped or disconnected remain blocked after reload and cannot be regenerated', async () => {
  for (const behavior of ['stall', 'network']) {
    const config = serverConversationConfig();
    config.stream = behavior === 'stall';
    const { page, errors } = await openPage('sidebar', config);
    await useServerConversationFixture(page);
    await page.evaluate((value) => { window.__serverBehavior = value; }, behavior);
    await page.locator('#messageInput').fill('Submit once');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => window.__serverCalls.length === 2);
    if (behavior === 'stall') {
      await page.waitForFunction(() => state.sessions[state.currentSessionId].serverConversation.status === 'pending');
      await page.locator('#sendBtn').click();
    }
    await page.waitForFunction(() => !state.isStreaming);
    assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].serverConversation.status), 'unconfirmed');
    await page.locator('#messageInput').fill('Do not send without confirmation');
    assert.equal(await page.locator('#sendBtn').isDisabled(), true);
    await page.evaluate(async () => {
      await regenerateMessage(state.sessions[state.currentSessionId].messages[0]);
      await saveToStorage();
      sessionStorage.setItem('sidemind-fixture-reload', JSON.stringify(window.__storage));
    });
    assert.equal(await page.evaluate(() => window.__serverCalls.length), 2);
    await page.reload();
    await page.waitForFunction(() => state.currentSessionId && document.querySelector('#generationStatus').textContent);
    await page.locator('#messageInput').fill('Still blocked');
    assert.equal(await page.locator('#sendBtn').isDisabled(), true);
    assert.match(await page.locator('#generationStatus').textContent(), /unconfirmed/);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

browserTest('server mode blocks old local history, provider changes and disabling the mode on a bound chat', async () => {
  const config = serverConversationConfig();
  const local = { currentSessionId: 'old', sessions: { old: { title: 'Old chat', messages: [{ id: 'u', role: 'user', content: 'Old context' }] } } };
  const { page, errors } = await openPage('sidebar', config, local);
  await useServerConversationFixture(page);
  await page.locator('#messageInput').fill('Do not lose my old context silently');
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  await page.locator('#newChatBtn').click();
  await page.locator('#messageInput').fill('Start server chat');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 2);
  await page.evaluate(() => { state.config.providers[0].baseUrl = 'https://other.test/v1'; updateInputState(); });
  await page.locator('#messageInput').fill('Wrong server');
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  await page.evaluate(() => { state.config.providers[0].baseUrl = 'https://provider.test/v1'; state.config.providers[0].serverConversation = false; updateInputState(); });
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  assert.equal(await page.locator('.edit-btn').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__serverCalls.length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('server preflight keeps the draft if the provider changes during an asynchronous storage read', async () => {
  const { page, errors } = await openPage('sidebar', serverConversationConfig());
  await useServerConversationFixture(page);
  await page.evaluate(() => {
    const save = queueLocalSave;
    queueLocalSave = async (...args) => {
      await new Promise((resolve) => { window.__releasePreflight = resolve; });
      queueLocalSave = save;
      return save(...args);
    };
  });
  await page.locator('#messageInput').fill('Keep my selected destination');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => typeof window.__releasePreflight === 'function');
  await page.evaluate(() => {
    state.config.providers[0].baseUrl = 'https://other.test/v1';
    window.__releasePreflight();
  });
  await page.waitForFunction(() => document.querySelector('#notifications').textContent.includes('changed while preparing'));
  assert.equal(await page.evaluate(() => window.__serverCalls.length), 0);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep my selected destination');
  await page.evaluate(() => { state.config.providers[0].baseUrl = 'https://provider.test/v1'; });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('a persisted pending server turn after a closed panel requires a new chat', async () => {
  const config = serverConversationConfig();
  const local = { currentSessionId: 'pending', sessions: {
    pending: {
      title: 'Interrupted chat', messages: [{ id: 'u_pending', role: 'user', content: 'Possibly submitted' }],
      serverConversation: { id: 'conv_pending', providerId: 'provider', baseUrl: 'https://provider.test/v1', modelId: 'model', status: 'pending' }
    }
  } };
  const { page, errors } = await openPage('sidebar', config, local);
  await useServerConversationFixture(page);
  await page.locator('#messageInput').fill('Do not retry automatically');
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  await page.evaluate(async () => { await sendMessageToAPI({ content: 'Do not bypass the block', attachments: [] }); });
  assert.equal(await page.evaluate(() => window.__serverCalls.length), 0);
  await page.locator('#newChatBtn').click();
  await page.locator('#messageInput').fill('A fresh chat');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__serverCalls.length === 2);
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].serverConversation.status), 'ready');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('two sidebars serialize server turns and refresh the saved conversation before sending', async () => {
  const config = serverConversationConfig();
  config.stream = true;
  const { context, a, b } = await openSharedPages(config);
  try {
    await useServerConversationFixture(a);
    await useServerConversationFixture(b);
    // Simulate a panel that missed storage notifications. The send path must
    // reload the binding under the lock rather than create another thread.
    await b.evaluate(() => { followStoredSession = () => {}; });
    await a.evaluate(() => { window.__serverBehavior = 'stall'; });
    await a.locator('#messageInput').fill('First sidebar');
    await a.locator('#sendBtn').click();
    await a.waitForFunction(() => typeof window.__finishServer === 'function');
    await b.evaluate(async () => { await sendMessageToAPI({ content: 'Second sidebar', attachments: [] }); });
    assert.equal(await b.evaluate(() => window.__serverCalls.length), 0, 'another sidebar cannot append while the first turn is active');
    await a.evaluate(() => window.__finishServer());
    await a.waitForFunction(() => !state.isStreaming);
    assert.equal(await b.evaluate(() => state.sessions[state.currentSessionId].serverConversation), undefined);
    await b.evaluate(async () => {
      state.config.stream = false;
      await sendMessageToAPI({ content: 'Second sidebar', attachments: [] });
    });
    assert.equal(await b.evaluate(() => window.__serverCalls.length), 1, 'the second sidebar reuses the saved ID');
    assert.equal(await b.evaluate(() => window.__serverCalls[0].body.conversation), 'conv_1');
    assert.deepEqual(await b.evaluate(() => window.__serverCalls[0].body.input), [{ role: 'user', content: 'Second sidebar' }]);
    const saved = await readChats(b);
    const sessionId = await b.evaluate(() => state.currentSessionId);
    assert.equal(saved.sessions[sessionId].messages.length, 4);
    assert.equal(saved.sessions[sessionId].serverConversation.status, 'ready');
  } finally {
    await context.close();
  }
});

async function useCompleteFixture(page) {
  await page.evaluate(() => {
    window.__fetchCalls = [];
    window.fetch = async (url, options) => {
      window.__fetchCalls.push(JSON.parse(options.body));
      const output = [{ id: 'msg_answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '<think>literal answer</think>', annotations: [] }] }];
      return String(url).endsWith('/responses')
        ? Response.json({ id: 'resp_answer', status: 'completed', output })
        : Response.json({ choices: [{ message: { content: 'Complete answer' }, finish_reason: 'stop' }] });
    };
  });
}

browserTest('Responses attachments survive reload, follow-up, editing, undo and original download', async () => {
  const config = structuredClone(fixtureConfig);
  config.providers[0].apiType = 'responses';
  config.stream = false;
  const { page, errors } = await openPage('sidebar', config);
  await useCompleteFixture(page);
  await page.locator('#attachmentInput').setInputFiles([attachmentPng, attachmentText]);
  await page.waitForFunction(() => normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 2 && attachmentJobs.size === 0);
  await page.waitForFunction(() => window.__storage.local.drafts[state.currentSessionId]?.attachments.length === 2);
  assert.equal(await page.locator('#sendBtn').isEnabled(), true, 'attachment-only messages can be sent');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 1);
  const first = await page.evaluate(() => window.__fetchCalls[0]);
  assert.deepEqual(first.input[0].content.map(part => part.type), ['input_image', 'input_file']);
  assert.equal(first.input[0].content[1].filename, 'notes.txt');
  assert.equal(Buffer.from(first.input[0].content[1].file_data.split(',')[1], 'base64').toString(), attachmentText.buffer.toString());
  assert.equal((await page.locator('.assistant .message-content').textContent()).trim(), '<think>literal answer</think>');
  assert.equal(await page.locator('.assistant .reasoning-section').count(), 0);
  await page.evaluate(async () => {
    await saveToStorage();
    sessionStorage.setItem('sidemind-fixture-reload', JSON.stringify(window.__storage));
  });
  const local = await page.evaluate(() => JSON.stringify(window.__storage.local));
  assert.equal(local.includes('data:image/'), false);
  assert.equal(local.includes('file_data'), false);
  await page.reload();
  await page.waitForFunction(() => storageReady && state.sessions[state.currentSessionId]?.messages.length === 2);
  await useCompleteFixture(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download notes.txt', exact: true }).click();
  assert.equal(readFileSync(await (await download).path(), 'utf8'), attachmentText.buffer.toString());
  await page.locator('#messageInput').fill('Follow up');
  await page.evaluate(() => {
    const build = API_ADAPTERS.responses.buildRequestBody;
    API_ADAPTERS.responses.buildRequestBody = (context) => {
      API_ADAPTERS.responses.buildRequestBody = build;
      return new Promise((resolve) => { window.__releasePreparation = resolve; }).then(() => build(context));
    };
  });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => state.isPreparing && typeof window.__releasePreparation === 'function');
  await page.evaluate(async () => {
    await chrome.storage.session.set({ 'selection:1': { text: 'An excerpt imported during preparation', title: 'Source' } });
    await selectionImportQueue;
    window.__releasePreparation();
  });
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 1);
  assert.match(await page.locator('#messageInput').inputValue(), /An excerpt imported during preparation/);
  assert.equal(await page.evaluate(() => window.__fetchCalls[0].input.at(-1).content), 'Follow up', 'only the captured draft is sent');
  assert.equal(await page.evaluate(() => typeof window.__fetchCalls[0].input[0].content), 'string');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fetchCalls[0]).includes('file_data')), false);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fetchCalls[0]).includes('data:image/')), false);
  assert.equal(await page.locator('#inputHint').textContent(), 'Enter to send · Shift + Enter for a new line');
  await page.locator('.message.user .edit-btn').first().click();
  await page.locator('.message-edit-input').fill('Updated image question');
  await page.evaluate(() => { state.config.providers[0].apiType = 'chat'; });
  await page.locator('.edit-submit-btn').click();
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages.length), 4, 'failed edit preparation preserves later turns');
  assert.equal(await page.locator('.message-edit-input').inputValue(), 'Updated image question');
  await page.evaluate(() => { state.config.providers[0].apiType = 'responses'; });
  await page.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
  await page.locator('.message-edit-input').fill('Updated image question');
  await page.locator('.edit-submit-btn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__fetchCalls[1].input[0].content.map(part => part.type)), ['input_text', 'input_image']);
  await page.locator('#undoBtn').click();
  await page.waitForFunction(() => state.sessions[state.currentSessionId].messages.length === 4);
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages[0].attachments.length), 2);
  assert.equal(await page.locator('.message.user').first().getByRole('button', { name: 'Download notes.txt', exact: true }).count(), 1);
  await page.locator('.message.assistant .regenerate-btn').first().click();
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__fetchCalls[2].input[0].content.map(part => part.type)), ['input_image', 'input_file']);
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages[0].attachments.length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('Chat attachment parts and preflight failures preserve the unsent draft and history', async () => {
  const config = structuredClone(fixtureConfig);
  config.stream = false;
  const { page, errors } = await openPage('sidebar', config);
  await useCompleteFixture(page);
  const pdf = { name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF') };
  await page.locator('#attachmentInput').setInputFiles([attachmentPng, pdf]);
  await page.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 2);
  await page.locator('#messageInput').fill('Read these');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__fetchCalls[0].messages.find(message => message.role === 'user').content.map(part => part.type)), ['text', 'image_url', 'file']);
  await page.locator('#messageInput').fill('A text-only follow-up');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && window.__fetchCalls.length === 2);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fetchCalls[1]).includes('file_data')), false);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fetchCalls[1]).includes('data:image/')), false);
  await page.evaluate(() => { state.config.providers[0].apiType = 'responses'; });
  await page.locator('#attachmentInput').setInputFiles(attachmentText);
  await page.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 1);
  await page.locator('#messageInput').fill('Keep this draft');
  await page.evaluate(() => { state.config.providers[0].apiType = 'chat'; });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming && document.querySelector('#generationStatus').textContent.includes('could not be prepared'));
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => state.sessions[state.currentSessionId].messages.length), 4);
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 2);
  await page.evaluate(async () => {
    state.config.providers[0].apiType = 'responses';
    const ref = normalizeDraft(state.drafts[state.currentSessionId]).attachments[0];
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('sidemind-attachments', 1);
      request.onsuccess = () => {
        const tx = request.result.transaction(['files'], 'readwrite');
        tx.objectStore('files').delete(ref.id);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 2, 'missing bytes never become a request containing only the filename');
  await page.evaluate(() => {
    const build = API_ADAPTERS.responses.buildRequestBody;
    API_ADAPTERS.responses.buildRequestBody = async (context) => {
      await new Promise((resolve) => { window.__releasePreparation = resolve; });
      return build(context);
    };
  });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => state.isPreparing && typeof window.__releasePreparation === 'function');
  await page.locator('#sendBtn').click();
  await page.evaluate(() => window.__releasePreparation());
  await page.waitForFunction(() => !state.isStreaming);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 2, 'cancelling local preparation does not send a request');
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('attachment collection respects references, another page pin and the full orphan grace period', async () => {
  const shared = await browser.newContext();
  const { page, errors } = await openPage('sidebar', fixtureConfig, {}, undefined, shared);
  const refs = await page.evaluate(async () => {
    const files = [new File(['keep'], 'keep.txt', { type: 'text/plain' }), new File(['undo'], 'undo.txt', { type: 'text/plain' })];
    const refs = [];
    for (const file of files) {
      const ref = await AttachmentStore.validate(file);
      await AttachmentStore.put(file, ref, 'publication');
      refs.push(ref);
    }
    return refs;
  });
  const other = await page.context().newPage();
  await other.goto(`${baseUrl}/attachment-fixture.html`);
  await other.addScriptTag({ url: `${baseUrl}/sidebar/attachments.js` });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  await page.evaluate(async ({ refs, now }) => {
    await AttachmentStore.collect(new Set([refs[0].id]), now);
    await AttachmentStore.get(refs[1]);
  }, { refs, now: now + 2 * day });
  await other.evaluate(({ ref, duration }) => AttachmentStore.pin('other-page:undo', [ref], duration), { ref: refs[1], duration: 5 * day });
  await page.evaluate(async ({ refs, now }) => {
    await AttachmentStore.collect(new Set([refs[0].id]), now);
    await AttachmentStore.get(refs[1]);
  }, { refs, now: now + 3 * day });
  await other.close();
  await page.evaluate(({ refs, now }) => AttachmentStore.collect(new Set([refs[0].id]), now), { refs, now: now + 6 * day });
  const result = await page.evaluate(async ({ refs, now }) => {
    await AttachmentStore.collect(new Set([refs[0].id]), now);
    const retained = await (await AttachmentStore.get(refs[0])).text();
    let removed = false;
    try { await AttachmentStore.get(refs[1]); } catch { removed = true; }
    return { retained, removed };
  }, { refs, now: now + 7 * day + 1 });
  assert.deepEqual(result, { retained: 'keep', removed: true });
  assert.deepEqual(errors, []);
  await shared.close();
});

browserTest('generation settings save model overrides without leaking into a sibling model', async () => {
  const config = structuredClone(fixtureConfig);
  config.providers[0].models.push({ id: 'other', name: 'Other' });
  const { page, errors } = await openPage('options', config);
  await openSettingsSection(page, 'conversation');
  await page.locator('#conversation .advanced-settings summary').click();
  await page.locator('#generationScope').selectOption(JSON.stringify(['provider', 'model']));
  await page.getByRole('combobox', { name: 'reasoning effort override', exact: true }).selectOption('custom');
  await page.locator('#reasoningEffortSelector').selectOption('max');
  await page.getByRole('combobox', { name: 'temperature override', exact: true }).selectOption('default');
  await page.waitForFunction(() => window.__storage.sync.config.providers[0].models[0].parameters?.reasoning_effort === 'max');
  await page.waitForFunction(() => window.__storage.sync.config.providers[0].models[0].parameters?.temperature === null);
  await page.locator('#generationScope').selectOption(JSON.stringify(['provider', 'other']));
  assert.equal(await page.locator('#reasoningEffortSelector').inputValue(), '');
  assert.equal(await page.locator('#reasoningEffortSelector').isDisabled(), true);
  const resolved = await page.evaluate(() => {
    const provider = config.providers[0];
    return [GenerationSettings.resolve(config, provider, 'model').values, GenerationSettings.resolve(config, provider, 'other').values];
  });
  assert.equal(resolved[0].reasoning_effort, 'max');
  assert.equal(resolved[0].temperature, null);
  assert.equal(resolved[1].reasoning_effort, null);
  assert.equal(resolved[1].temperature, 0.7);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('paste and drop retain unsaved attachments until retry and reject a disguised image', async () => {
  const config = structuredClone(fixtureConfig);
  config.providers[0].apiType = 'responses';
  const { page, errors } = await openPage('sidebar', config);
  await page.locator('#attachmentInput').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.waitForFunction(() => attachmentJobs.size === 0);
  assert.equal(await page.locator('#draftAttachments .attachment-card').count(), 0);
  await page.evaluate(() => {
    window.__failLocalSave = true;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Dropped text'], 'dropped.txt', { type: 'text/plain' }));
    document.querySelector('#composer').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => attachmentJobs.size === 0 && attachmentSaveFailed);
  await page.evaluate((base64) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    document.querySelector('#messageInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, attachmentPng.buffer.toString('base64'));
  await page.waitForFunction(() => attachmentJobs.size === 0 && normalizeDraft(state.drafts[state.currentSessionId]).attachments.length === 2);
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  assert.equal(await page.locator('#storageStatus').isVisible(), true);
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.locator('#retryStorageBtn').click();
  await page.waitForFunction(() => !attachmentSaveFailed && window.__storage.local.drafts[state.currentSessionId]?.attachments.length === 2);
  assert.equal(await page.locator('#sendBtn').isEnabled(), true);
  assert.equal(await page.evaluate(async () => {
    const refs = normalizeDraft(state.drafts[state.currentSessionId]).attachments;
    return (await (await AttachmentStore.get(refs[0])).text()) === 'Dropped text';
  }), true);
  assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
