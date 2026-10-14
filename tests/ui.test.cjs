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

async function openPage(kind = 'sidebar', config = fixtureConfig, local = {}) {
  const page = await browser.newPage({
    viewport: { width: kind === 'sidebar' ? 380 : 1160, height: 800 },
    reducedMotion: 'reduce'
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ initialConfig, initialLocal, version }) => {
      const listeners = [];
      window.__writes = [];
      window.__failSave = false;
      window.__storage = { sync: { config: initialConfig }, local: initialLocal };
      const storageArea = (area) => ({
        get: async (keys) =>
          Object.fromEntries(
            keys
              .filter((key) => key in window.__storage[area])
              .map((key) => [key, structuredClone(window.__storage[area][key])])
          ),
        set: async (data) => {
          if (window.__failSave && area === 'sync') throw new Error('Fixture storage failure');
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
          onChanged: { addListener: (listener) => listeners.push(listener) }
        },
        permissions: { contains: async () => true, request: async () => true },
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
          complete: close,
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
    await page.locator('.advanced-settings summary').click();
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
