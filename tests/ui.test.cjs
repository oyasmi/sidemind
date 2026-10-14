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
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openPage(kind = 'sidebar', config = fixtureConfig, local = {}, prepare) {
  const page = await browser.newPage({
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
      window.__storage = { sync: { config: initialConfig }, local: initialLocal, session: {} };
      const storageArea = (area) => ({
        get: async (keys) => {
          if (area === 'local' && window.__storage.local.__failLoad) throw new Error('Fixture read failure');
          return Object.fromEntries(
            (keys || Object.keys(window.__storage[area]))
              .filter((key) => key in window.__storage[area])
              .map((key) => [key, structuredClone(window.__storage[area][key])])
          );
        },
        set: async (data) => {
          if (window.__failSave && area === 'sync') throw new Error('Fixture storage failure');
          if (window.__failLocalSave && area === 'local') throw new Error('Fixture local storage failure');
          const changes = {};
          for (const [key, value] of Object.entries(data)) {
            changes[key] = {
              oldValue: window.__storage[area][key],
              newValue: structuredClone(value)
            };
            window.__storage[area][key] = structuredClone(value);
          }
          window.__writes.push({ area, data: structuredClone(data) });
          listeners.forEach((listener) => listener(changes, area));
        },
        remove: async (keys) => {
          for (const key of keys) delete window.__storage[area][key];
        }
      });
      window.chrome = {
        storage: {
          sync: storageArea('sync'),
          local: storageArea('local'),
          session: storageArea('session'),
          onChanged: { addListener: (listener) => listeners.push(listener) }
        },
        permissions: { contains: async () => true, request: async () => true },
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
      await page.locator('#themeSelector').selectOption('dark');
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
    await page.locator('#conversation .advanced-settings summary').click();
    for (const value of ['1', '12', '120'])
      await page.locator('#maxCompletionTokensInput').fill(value);
    await page.waitForFunction(() => window.__storage.sync.config.max_completion_tokens === '120');
    assert.equal(
      await page.evaluate(() => window.__writes.filter((write) => write.area === 'sync').length),
      1
    );
    await page.locator('#maxCompletionTokensInput').fill('1.5');
    assert.equal(
      await page.locator('#maxCompletionTokensInput').getAttribute('aria-invalid'),
      'true'
    );
    assert.equal(
      await page.evaluate(() => window.__storage.sync.config.max_completion_tokens),
      '120'
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
    await page.waitForFunction(() => window.__storage.sync.config.max_completion_tokens === '240');
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
      await settings.locator('#themeSelector').selectOption('dark');
      await settings.locator('#fontSizeSelector').selectOption('16px');
      await chat.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark-theme') &&
          getComputedStyle(document.body).fontSize === '16px'
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
    await page.locator('#themeSelector').selectOption('dark');
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
  await page.locator('#modelSelector').selectOption('other - provider');
  await page.evaluate(async () => {
    const latest = structuredClone(window.__storage.sync.config);
    latest.theme = 'dark';
    await chrome.storage.sync.set({ config: latest });
  });
  assert.equal(await page.locator('#modelSelector').inputValue(), 'other - provider');
  await page.waitForFunction(
    () => window.__storage.sync.config.selectedModel === 'other - provider'
  );
  assert.equal(await page.evaluate(() => window.__storage.sync.config.theme), 'dark');
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
  assert.equal(await page.evaluate(() => window.__storage.local.drafts[state.currentSessionId]), 'A draft that must not disappear');
  assert.equal(await page.evaluate(() => Boolean(window.__storage.local.sessions[state.currentSessionId])), true);
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
  assert.deepEqual(await page.evaluate(() => window.__storage.local.sessions), existing);
  assert.equal(await page.evaluate(() => window.__writes.filter((write) => write.area === 'local').length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('folded reasoning skips parsing and catches up immediately on expansion', async () => {
  const { page, errors } = await openPage();
  await startResponse(page);
  await page.evaluate(() => {
    const parse = renderMarkdown;
    window.__parseCalls = 0;
    renderMarkdown = (...args) => { window.__parseCalls++; return parse(...args); };
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
  assert.equal(await page.evaluate(() => window.__storage.local.drafts[state.currentSessionId]), draft);
  assert.deepEqual(errors, []);
  await page.close();
});

browserTest('UTF-8 sync quota errors keep role edits available for correction', async () => {
  const { page, errors } = await openPage('options');
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
  assert.equal(await page.evaluate(() => window.__storage.local.drafts[state.currentSessionId]), 'Latest draft');
  assert.deepEqual(errors, []);
  await page.close();
});

// Two sidebar pages in one browser context share localStorage (backing the
// storage mock) and the real Web Locks manager, like two extension pages do.
async function openSharedPages() {
  const context = await browser.newContext({ viewport: { width: 380, height: 800 }, reducedMotion: 'reduce' });
  await context.addInitScript((initialConfig) => {
    const area = (name) => ({
      get: async (keys) => {
        const snapshot = JSON.parse(localStorage.getItem(`fixture-${name}`) || 'null') || (name === 'sync' ? { config: initialConfig } : {});
        // Widen the read-to-write window so an unlocked merge would lose updates.
        if (name === 'local') await new Promise((resolve) => setTimeout(resolve, 40));
        return Object.fromEntries((keys || Object.keys(snapshot)).filter((key) => key in snapshot).map((key) => [key, snapshot[key]]));
      },
      set: async (data) => {
        const snapshot = JSON.parse(localStorage.getItem(`fixture-${name}`) || 'null') || {};
        localStorage.setItem(`fixture-${name}`, JSON.stringify({ ...snapshot, ...data }));
      },
      remove: async (keys) => {
        if (localStorage.getItem('fixture-fail-remove')) throw new Error('Fixture remove failure');
        const failures = Number(localStorage.getItem('fixture-fail-remove-count') || 0);
        if (failures > 0) {
          localStorage.setItem('fixture-fail-remove-count', String(failures - 1));
          throw new Error('Fixture remove failure');
        }
        const snapshot = JSON.parse(localStorage.getItem(`fixture-${name}`) || '{}');
        for (const key of keys) delete snapshot[key];
        localStorage.setItem(`fixture-${name}`, JSON.stringify(snapshot));
      }
    });
    window.chrome = {
      storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: { addListener() {} } },
      permissions: { contains: async () => true, request: async () => true },
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: { getManifest: () => ({ version: '0' }), openOptionsPage() {} }
    };
  }, fixtureConfig);
  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/sidebar/sidebar.html`);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId && document.querySelector('#generationStatus').textContent);
    // The startup save of a first-run chat must land before the test acts or
    // the next page opens; the races under test start from a settled store.
    await page.evaluate(() => storageWriteQueue);
    return page;
  };
  const a = await open();
  const b = await open();
  return { context, a, b };
}

const readShared = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('fixture-local')));

browserTest('concurrent side panels keep each other\'s sessions, drafts and deletions', async () => {
  const { context, a, b } = await openSharedPages();
  const shared = await a.evaluate(() => state.currentSessionId);
  assert.equal(await b.evaluate(() => state.currentSessionId), shared);

  // A starts a new chat that B has never seen; B's snapshot is now stale.
  const fresh = await a.evaluate(async () => {
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
  let stored = await readShared(a);
  assert.deepEqual(Object.keys(stored.sessions).sort(), [fresh, shared].sort());
  assert.equal(stored.sessions[fresh].messages[0].content, 'from A');
  assert.equal(stored.sessions[shared].messages[0].content, 'from B');
  assert.equal(stored.drafts[fresh], 'draft from A');
  assert.equal(stored.drafts[shared], 'draft from B');
  assert.equal(stored.currentSessionId, fresh);

  // B deletes only its chat; A's chat and draft survive, and the deletion sticks.
  await b.evaluate((shared) => deleteSession(shared), shared);
  await b.evaluate(() => storageWriteQueue);
  stored = await readShared(a);
  assert.equal(shared in stored.sessions, false);
  assert.equal(shared in stored.drafts, false);
  assert.equal(fresh in stored.sessions, true);
  assert.equal(stored.drafts[fresh], 'draft from A');
  await context.close();
});

browserTest('two pages adding messages to one chat keep both; incompatible edits become a copy', async () => {
  const { context, a, b } = await openSharedPages();
  const shared = await a.evaluate(() => state.currentSessionId);
  const add = (page, id, content) =>
    page.evaluate(([id, content]) => {
      state.sessions[state.currentSessionId].messages.push({ id, role: 'user', content });
      return saveToStorage();
    }, [id, content]);
  await add(a, 'a1', 'from A');
  await add(b, 'b1', 'from B'); // B never saw a1
  let stored = await readShared(a);
  assert.deepEqual(stored.sessions[shared].messages.map((m) => m.content), ['from A', 'from B']);

  // Both change the same message differently: nothing may be dropped.
  for (const page of [a, b]) {
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId && document.querySelector('#generationStatus').textContent);
  }
  await a.evaluate(() => { state.sessions[state.currentSessionId].messages[0].content = 'A edit'; return saveToStorage(); });
  await b.evaluate(() => { state.sessions[state.currentSessionId].messages[0].content = 'B edit'; return saveToStorage(); });
  stored = await readShared(a);
  assert.equal(stored.sessions[shared].messages[0].content, 'A edit');
  const copyId = await b.evaluate(() => state.currentSessionId);
  assert.notEqual(copyId, shared);
  assert.equal(stored.sessions[copyId].messages[0].content, 'B edit');
  assert.match(stored.sessions[copyId].title, /conflicting copy/);
  await b.evaluate(() => storageWriteQueue);
  await b.waitForFunction(async () => JSON.parse(localStorage.getItem('fixture-local')).currentSessionId === state.currentSessionId);
  // B keeps working in its copy without producing further copies.
  await add(b, 'b2', 'more from B');
  stored = await readShared(a);
  assert.equal(Object.keys(stored.sessions).length, 2);
  assert.equal(stored.sessions[copyId].messages.at(-1).content, 'more from B');
  assert.equal(stored.sessions[shared].messages[0].content, 'A edit');
  await context.close();
});

// Two pages share a chat with one message; A saves an edit first, so B's
// differing edit of the same message cannot be merged.
async function conflictingPages({ reply = false } = {}) {
  const shared = await openSharedPages();
  const { a, b } = shared;
  const id = await a.evaluate(async (reply) => {
    state.sessions[state.currentSessionId].messages.push({ id: 'm1', role: 'user', content: 'original', timestamp: 1 });
    if (reply) state.sessions[state.currentSessionId].messages.push({ id: 'm2', role: 'assistant', content: 'original reply', timestamp: 2 });
    await saveToStorage();
    return state.currentSessionId;
  }, reply);
  for (const page of [a, b]) {
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId && document.querySelector('#generationStatus').textContent);
  }
  await a.evaluate(() => { state.sessions[state.currentSessionId].messages[0].content = 'A edit'; return saveToStorage(); });
  return { ...shared, id };
}

browserTest('edits made while a conflicting copy is being written are saved afterwards', async () => {
  const { context, b, id } = await conflictingPages();
  await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages[0].content = 'B edit';
    const set = chrome.storage.local.set;
    window.__gate = new Promise((resolve) => { window.__openGate = resolve; });
    chrome.storage.local.set = async (data) => { window.__setReached = true; await window.__gate; return set(data); };
    window.__firstSave = saveToStorage();
  });
  await b.waitForFunction(() => window.__setReached);
  // The page keeps working while the copy is being written.
  await b.evaluate(() => {
    const live = state.sessions[state.currentSessionId];
    live.messages[0].content = 'B edit, continued';
    live.messages.push({ id: 'late', role: 'user', content: 'typed during the write', timestamp: 2 });
  });
  await b.evaluate(async () => { window.__openGate(); await window.__firstSave; await saveToStorage(); });
  const stored = await readShared(b);
  const copyId = Object.keys(stored.sessions).find((key) => key !== id);
  assert.deepEqual(stored.sessions[copyId].messages.map((m) => m.content), ['B edit, continued', 'typed during the write']);
  assert.equal(stored.sessions[id].messages[0].content, 'A edit');
  await context.close();
});

browserTest('a conflicting copy and its original show and act on their own messages', async () => {
  const { context, b, id } = await conflictingPages();
  await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages[0].content = 'B edit';
    messageElementCache.clear();
    renderMessages();
    return saveToStorage();
  });
  const copyId = await b.evaluate(() => state.currentSessionId);
  assert.notEqual(copyId, id);
  const shown = () => b.locator('.message.user .message-content').first().textContent();
  const editing = async () => {
    await b.locator('.message.user .edit-btn').first().click();
    const value = await b.locator('.message.user textarea').inputValue();
    await b.keyboard.press('Escape');
    return value;
  };
  assert.equal(await shown(), 'B edit');
  assert.equal(await editing(), 'B edit');
  await b.evaluate((id) => switchSession(id), id);
  assert.equal(await shown(), 'A edit');
  assert.equal(await editing(), 'A edit');
  await b.evaluate((id) => switchSession(id), copyId);
  assert.equal(await shown(), 'B edit');
  assert.equal(await editing(), 'B edit');
  await context.close();
});

browserTest('after a conflict both pages keep their own drafts, also across later saves', async () => {
  const { context, a, b, id } = await conflictingPages();
  await a.evaluate((id) => { state.drafts[id] = 'A saved draft'; return saveToStorage(); }, id);
  await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages[0].content = 'B edit';
    state.drafts[state.currentSessionId] = 'B first draft';
    const set = chrome.storage.local.set;
    window.__gate = new Promise((resolve) => { window.__openGate = resolve; });
    chrome.storage.local.set = async (data) => { window.__setReached = true; await window.__gate; return set(data); };
    window.__firstSave = saveToStorage();
  });
  await b.waitForFunction(() => window.__setReached);
  await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages[0].content = 'B edit, continued';
    state.drafts[state.currentSessionId] = 'B latest draft';
  });
  await b.evaluate(async () => { window.__openGate(); await window.__firstSave; await saveToStorage(); await saveToStorage(); });
  const stored = await readShared(b);
  const copyId = await b.evaluate(() => state.currentSessionId);
  assert.notEqual(copyId, id);
  assert.equal(stored.drafts[id], 'A saved draft');
  assert.equal(stored.drafts[copyId], 'B latest draft');
  assert.equal(stored.sessions[copyId].messages[0].content, 'B edit, continued');
  await context.close();
});

browserTest('Undo after a conflict restores this page\'s copy and leaves the other page\'s chat alone', async () => {
  const { context, a, b, id } = await conflictingPages({ reply: true });
  await a.evaluate(() => {
    state.sessions[state.currentSessionId].messages.push({ id: 'a-extra', role: 'user', content: 'A saved extra', timestamp: 3 });
    return saveToStorage();
  });
  await b.evaluate(() => { sendMessageToAPI = async () => {}; });
  await b.locator('.message.user .edit-btn').first().click();
  await b.locator('.message.user textarea').fill('B edit');
  await b.locator('.edit-submit-btn').click();
  await b.waitForFunction((id) => state.currentSessionId !== id, id);
  await b.evaluate(() => storageWriteQueue);
  await b.locator('#undoBtn').click();
  await b.waitForFunction(() => state.sessions[state.currentSessionId].messages.length === 2);
  await b.evaluate(() => storageWriteQueue);
  const stored = await readShared(b);
  const copyId = await b.evaluate(() => state.currentSessionId);
  assert.deepEqual(stored.sessions[id].messages.map((m) => m.content), ['A edit', 'original reply', 'A saved extra']);
  assert.deepEqual(stored.sessions[copyId].messages.map((m) => m.content), ['original', 'original reply']);
  await context.close();
});

browserTest('replaying a pending conflict never duplicates or rolls back its copy', async () => {
  const { context, a, b, id } = await conflictingPages();
  await b.evaluate((id) => {
    state.sessions[id].messages[0].content = 'B edit';
    state.drafts[id] = 'B draft';
    window.dispatchEvent(new Event('pagehide'));
  }, id);
  await b.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await b.close();
  const open = async () => {
    const page = await context.newPage();
    await page.goto(a.url());
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
    return page;
  };
  await a.evaluate(() => localStorage.setItem('fixture-fail-remove', '1'));
  await (await open()).close();
  const copies = async () => Object.keys((await readShared(a)).sessions).filter((key) => key.startsWith('conflict-'));
  const [copyId] = await copies();
  // The copy gets newer work, and the original chat moves on, before the retry.
  await a.evaluate(([copyId]) => {
    const tables = JSON.parse(localStorage.getItem('fixture-local'));
    tables.sessions[copyId].messages.push({ id: 'later', role: 'user', content: 'added to the copy' });
    tables.drafts[copyId] = 'newer copy draft';
    tables.sessions[Object.keys(tables.sessions).find((key) => !key.startsWith('conflict-') && tables.sessions[key].messages.length)].messages[0].content = 'A edit again';
    localStorage.setItem('fixture-local', JSON.stringify(tables));
    localStorage.removeItem('fixture-fail-remove');
  }, [copyId]);
  await (await open()).close();
  const stored = await readShared(a);
  assert.deepEqual(await copies(), [copyId]);
  assert.deepEqual(stored.sessions[copyId].messages.map((m) => m.content), ['B edit', 'added to the copy']);
  assert.equal(stored.drafts[copyId], 'newer copy draft');
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
  await context.close();
});

browserTest('a replayed pending conflict leaves a reverted or deleted original chat alone', async () => {
  for (const mode of ['reverted', 'deleted']) {
    const { context, a, b, id } = await conflictingPages();
    await b.evaluate((id) => {
      state.sessions[id].messages[0].content = 'B edit';
      state.drafts[id] = 'B draft';
      window.dispatchEvent(new Event('pagehide'));
    }, id);
    await b.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
    await b.close();
    const open = async () => {
      const page = await context.newPage();
      await page.goto(a.url());
      await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
      return page;
    };
    await a.evaluate(() => localStorage.setItem('fixture-fail-remove', '1'));
    await (await open()).close();
    // The original chat goes back to the state B started from, or is deleted,
    // and its page has a newer draft; the retry must not undo any of that.
    await a.evaluate(([mode, id]) => {
      const tables = JSON.parse(localStorage.getItem('fixture-local'));
      if (mode === 'reverted') tables.sessions[id].messages[0].content = 'original';
      else delete tables.sessions[id];
      tables.drafts[id] = 'A later draft';
      localStorage.setItem('fixture-local', JSON.stringify(tables));
      localStorage.removeItem('fixture-fail-remove');
    }, [mode, id]);
    await (await open()).close();
    const stored = await readShared(a);
    const copies = Object.keys(stored.sessions).filter((key) => key.startsWith('conflict-'));
    assert.equal(copies.length, 1, mode);
    assert.equal(stored.sessions[copies[0]].messages[0].content, 'B edit', mode);
    if (mode === 'reverted') assert.equal(stored.sessions[id].messages[0].content, 'original');
    else assert.equal(id in stored.sessions, false);
    assert.equal(stored.drafts[id], 'A later draft', mode);
    assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), [], mode);
    await context.close();
  }
});

browserTest('a save whose pending cleanup failed still adopts its copy, so a retry keeps what others added', async () => {
  const { context, a, b, id } = await conflictingPages();
  const open = async () => {
    const page = await context.newPage();
    await page.goto(a.url());
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
    return page;
  };
  // A closed page leaves a pending record, which B's next save has to fold in.
  const p = await open();
  await p.evaluate(() => { state.drafts.unrelated = 'draft from the closed page'; window.dispatchEvent(new Event('pagehide')); });
  await p.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await p.close();

  // B's conflicting save writes its copy, then deleting the pending record fails.
  await b.evaluate(() => localStorage.setItem('fixture-fail-remove-count', '1'));
  const saved = await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages[0].content = 'B edit';
    return saveToStorage();
  });
  assert.equal(saved, false);
  const copyId = await b.evaluate(() => state.currentSessionId);
  assert.notEqual(copyId, id);

  // Another page opens the copy and saves a new message and draft to it.
  const c = await open();
  assert.equal(await c.evaluate(() => state.currentSessionId), copyId);
  await c.evaluate(() => {
    state.sessions[state.currentSessionId].messages.push({ id: 'c1', role: 'user', content: 'C saved new message' });
    state.drafts[state.currentSessionId] = 'C new draft';
    return saveToStorage();
  });

  // B retries, with one more edit of its own made in the meantime.
  await b.evaluate(() => {
    state.sessions[state.currentSessionId].messages.push({ id: 'b-later', role: 'user', content: 'B later message' });
    return saveToStorage();
  });
  const stored = await readShared(b);
  assert.deepEqual(stored.sessions[copyId].messages.map((m) => m.content), ['B edit', 'C saved new message', 'B later message']);
  assert.equal(stored.drafts[copyId], 'C new draft');
  assert.equal(stored.sessions[id].messages[0].content, 'A edit');
  assert.equal(stored.drafts.unrelated, 'draft from the closed page');
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
  await context.close();
});

browserTest('a stash whose cleanup keeps failing is not replayed over a newer saved draft', async () => {
  const { context, a } = await openSharedPages();
  const id = await a.evaluate(() => state.currentSessionId);
  const p = await context.newPage();
  await p.goto(a.url());
  await p.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
  await p.evaluate((id) => { state.drafts[id] = 'P pending draft'; window.dispatchEvent(new Event('pagehide')); }, id);
  await p.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await p.close();

  // Two saves write successfully but cannot delete the stash.
  await a.evaluate(() => localStorage.setItem('fixture-fail-remove-count', '2'));
  const save = (text) => a.evaluate(([id, text]) => { state.drafts[id] = text; return saveToStorage(); }, [id, text]);
  assert.equal(await save('A first draft'), false);
  assert.equal(await save('A newer saved draft'), false);
  assert.equal((await readShared(a)).drafts[id], 'A newer saved draft');

  // The retry removes the stash without replaying it.
  await a.evaluate(() => { retryStorageSave(); return storageWriteQueue; });
  const stored = await readShared(a);
  assert.equal(stored.drafts[id], 'A newer saved draft');
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
  await context.close();
});

browserTest('a pending conflict moves an unchanged selection and saved draft to the copy', async () => {
  const { context, a, b, id } = await conflictingPages();
  // B's selection and draft were persisted earlier; only a message changes before it closes.
  await b.evaluate(async (id) => { state.drafts[id] = 'B saved draft'; await saveToStorage(); }, id);
  await a.evaluate((id) => { state.drafts[id] = 'A draft'; return saveToStorage(); }, id);
  await b.evaluate((id) => {
    state.sessions[id].messages[0].content = 'B edit';
    window.dispatchEvent(new Event('pagehide'));
  }, id);
  await b.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await b.close();
  const c = await context.newPage();
  await c.goto(a.url());
  await c.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
  const stored = await readShared(a);
  const copyId = Object.keys(stored.sessions).find((key) => key.startsWith('conflict-'));
  assert.equal(stored.currentSessionId, copyId);
  assert.equal(stored.drafts[copyId], 'B saved draft');
  assert.equal(stored.drafts[id], 'A draft');
  await context.close();
});

browserTest('a closed page\'s conflicting changes are restored once, with its selection and draft', async () => {
  const { context, a, b, id } = await conflictingPages();
  // B had moved to another chat and back; its unsent draft belongs to the chat it edited.
  await b.evaluate(async (id) => {
    await createNewSession();
    await storageWriteQueue;
    state.currentSessionId = id;
    state.sessions[id].messages[0].content = 'B edit';
    state.drafts[id] = 'draft for B';
    window.dispatchEvent(new Event('pagehide'));
  }, id);
  await b.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await b.close();
  const open = async () => {
    const page = await context.newPage();
    await page.goto(a.url());
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
    return page;
  };
  // The first replay writes the tables but fails to delete the pending record.
  await a.evaluate(() => localStorage.setItem('fixture-fail-remove', '1'));
  await (await open()).close();
  const copies = async () => Object.keys((await readShared(a)).sessions).filter((key) => key.startsWith('conflict-'));
  assert.equal((await copies()).length, 1);
  await a.evaluate(() => localStorage.removeItem('fixture-fail-remove'));
  const c = await open();
  const stored = await readShared(a);
  const [copyId] = await copies();
  assert.equal((await copies()).length, 1);
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
  assert.equal(stored.sessions[copyId].messages[0].content, 'B edit');
  assert.equal(stored.sessions[id].messages[0].content, 'A edit');
  assert.equal(stored.currentSessionId, copyId);
  assert.equal(stored.drafts[copyId], 'draft for B');
  assert.equal(stored.drafts[id], undefined);
  assert.equal(await c.evaluate(() => state.currentSessionId), copyId);
  assert.equal(await c.locator('#messageInput').inputValue(), 'draft for B');
  await context.close();
});

browserTest('a pagehide stash written after a save read its snapshot survives that save, and colliding drafts both apply', async () => {
  const { context, a } = await openSharedPages();
  const id = await a.evaluate(() => state.currentSessionId);
  // Open the second page before the stash exists, so startup cannot consume it.
  const q = await context.newPage();
  await q.goto(a.url());
  await q.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
  const p = await context.newPage();
  await p.goto(a.url());
  await p.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId);
  // 'draft-0001r' and 'draft-00030' had the same 32-bit fingerprint.
  await p.evaluate((id) => { state.drafts[id] = 'draft-0001r'; window.dispatchEvent(new Event('pagehide')); }, id);
  await p.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await p.close();
  // A's locked save has read the stash when the other page's newer stash lands.
  await a.evaluate(() => {
    const get = chrome.storage.local.get;
    chrome.storage.local.get = async (...args) => { const value = await get(...args); chrome.storage.local.get = get; await new Promise((r) => { window.__release = r; window.__paused = true; }); return value; };
    window.__save = saveToStorage();
  });
  await a.waitForFunction(() => window.__paused);
  await q.evaluate((id) => { state.drafts[id] = 'draft-00030'; window.dispatchEvent(new Event('pagehide')); }, id);
  await q.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).filter((key) => key.startsWith('pendingSave:')).length >= 2);
  await a.evaluate(async () => { window.__release(); await window.__save; });
  const pendingNow = Object.keys(await readShared(a)).filter((key) => key.startsWith('pendingSave:'));
  assert.equal(pendingNow.length, 1, 'the newer stash must still be pending');
  await q.close();
  await a.evaluate(async () => { state.drafts.other = 'x'; await saveToStorage(); });
  const stored = await readShared(a);
  assert.equal(stored.drafts[id], 'draft-00030');
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
  await context.close();
});

browserTest('a closing page never rewrites shared tables over a paused locked write', async () => {
  const { context, a, b } = await openSharedPages();
  // A takes the lock, reads the shared tables, and pauses before writing.
  await a.evaluate(() => {
    const get = chrome.storage.local.get;
    window.__gate = new Promise((resolve) => { window.__openGate = resolve; });
    chrome.storage.local.get = async (...args) => { const value = await get(...args); await window.__gate; return value; };
    state.drafts.fromA = 'draft A';
    window.__aSave = saveToStorage();
  });
  await a.waitForFunction(() => document.querySelector('#storageStatus') !== null);
  // B creates a chat and a draft, then is closed (pagehide) while A is paused.
  const bSession = await b.evaluate(async () => {
    await storageWriteQueue;
    state.sessions.fromB = { messages: [{ id: 'b', role: 'user', content: 'B chat' }], title: 'B chat', timestamp: new Date().toISOString() };
    state.drafts.fromB = 'draft B';
    window.dispatchEvent(new Event('pagehide'));
    return 'fromB';
  });
  await b.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fixture-local'))).some((key) => key.startsWith('pendingSave:')));
  await a.evaluate(async () => { window.__openGate(); await window.__aSave; });
  await b.close();
  // A new page folds the closed page's changes in; nothing was lost.
  const c = await context.newPage();
  await c.goto(a.url());
  await c.waitForFunction(() => typeof state !== 'undefined' && state.currentSessionId && document.querySelector('#generationStatus').textContent);
  assert.equal(await c.evaluate((id) => state.sessions[id]?.messages[0].content, bSession), 'B chat');
  assert.equal(await c.evaluate(() => state.drafts.fromB), 'draft B');
  assert.equal(await c.evaluate(() => state.drafts.fromA), 'draft A');
  const stored = await readShared(c);
  assert.deepEqual(Object.keys(stored).filter((key) => key.startsWith('pendingSave:')), []);
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
  await page.waitForFunction(() => state.drafts[state.currentSessionId]?.startsWith('My unsent thought'));
  assert.deepEqual(errors, []);
  await page.close();
});
