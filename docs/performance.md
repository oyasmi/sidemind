# Sidebar performance

## Changes

- Transcript rendering reconciles attached nodes rather than detaching the
  whole conversation. Editing and regeneration also release discarded DOM
  cache entries; Undo reconstructs those nodes from the retained message data.
- Streaming still parses and sanitizes the full Markdown source to preserve
  reference links, tables, lists and incomplete fences. Sanitized fragments
  attach directly, and unchanged top-level blocks remain attached, preserving
  table scroll positions and images the user has already loaded.
- Stream refresh delays adapt between 60 and 240 ms based on the preceding
  render cost. Each new generation resets that measurement. Completion and
  stopping still display the latest accumulated text immediately.
- Completion decorates unchanged Markdown in place. Thinking-tag extraction
  runs once during cleanup and skips the lexer when no opening tag exists.
- Saves serialize the active chat, marked background edits and new/replaced
  chats. Unchanged inactive transcripts are skipped. A mutation to an inactive
  chat must call `markSessionDirty(id)` or `saveToStorage(id)`; switching chats
  marks the outgoing chat before changing the selection. The existing lock,
  revision checks, merge rules and pagehide recovery remain in use.
- Startup reuses the recovered storage scan instead of reading all local data
  a second time. Matching storage revisions skip serialization on change events.
- History initially displays 50 rows, with a button to show further pages.
  Search still covers every conversation, yields between batches, and abandons
  superseded queries. Search caching is bounded to 500 entries and one million
  characters, with invalidation scoped to changed chats.
- Textarea resize requests are coalesced into one animation-frame callback.

## Measurements

Local Linux, headless Chromium 153, 380 × 800 viewport, synthetic fixture
providers. Each median has one warmup followed by seven samples for Markdown
or five samples for other operations. These measure synchronous main-thread
work, excluding provider latency and real Chrome storage I/O. They are examples,
not CI timing thresholds.

| Workload | Before | After |
| --- | ---: | ---: |
| 50,000-character Markdown update | 62.7 ms | 26.6 ms |
| 100,000-character Markdown update | 113.5 ms | 53.1 ms |
| Save diff: 500 chats, 100,000 characters each | 25.8 ms | 0.2 ms |
| Repeated transcript render: 500 messages | 230.8 ms | 0.2 ms |
| Regenerate 10 times, with 2 live messages | 12 cached nodes | 2 cached nodes |

Timings vary with the machine and workload. Initial rendering of all messages
in a long conversation remains expensive. Startup still reads all transcripts
once and retains them in memory. Streaming still performs a full parse and
sanitization, and very large code blocks are highlighted synchronously on
completion. Loading older messages/transcripts on demand and moving parsing or
highlighting off the main thread remain possible follow-up work.

## Reproduction

Install development-only Playwright as described in the README, then run:

```bash
SIDEMIND_BENCHMARK=1 \
PLAYWRIGHT_MODULE=/tmp/sidemind-browser-tests/node_modules/playwright \
  node --test --test-name-pattern="sidebar performance benchmark" tests/ui.test.cjs
```

Set `CHROMIUM_PATH` to a full Chromium executable if necessary. The real MV3
browser check needs an executable that supports loading extensions; the
headless-shell executable does not provide that capability.

The regular regression suites additionally check attached-node preservation,
cache cleanup and Undo, late Markdown references and fences, table scroll and
loaded-image preservation, background chat saves, storage recovery, history
pagination, and searching beyond the first page.
