# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SideMind** is a production-ready Chrome Extension (Manifest V3) that provides a sidebar interface for chatting with Large Language Models (LLMs). It's built with vanilla HTML/CSS/JavaScript following the KISS principle - no frameworks, no build tools, just pure web technologies.

### Current Status
- **Version**: 1.5.0 (Production Ready)
- **Chrome Web Store**: Published and available for installation
- **License**: Apache 2.0
- **Total Development Time**: ~3-4 hours
- **Lines of Code**: ~2000+ lines across 15+ files

### Key Design Philosophy
- **No Frameworks**: Pure vanilla JavaScript - no React, Vue, or build tools
- **Self-Contained**: All assets (FontAwesome, icons) are local - no CDN dependencies
- **KISS Principle**: Simple, straightforward code that's easy to understand and modify
- **OpenAI-Compatible API**: Works with any LLM provider that supports the OpenAI Chat Completions *or* Responses format

## Key Architecture

### Extension Structure
- **Manifest V3 Chrome Extension** using Side Panel API
- **Service Worker** (`background.js`) handles extension lifecycle
- **Sidebar Interface** (`sidebar/`) provides main chat UI
- **Options Page** (`options/`) handles configuration management
- **Chrome Storage API** for persistent data storage

### Core Components

#### 1. Sidebar Chat Interface (`sidebar/`)
- **`sidebar.html`**: Main chat UI layout with header, message area, and input section
- **`sidebar.js`**: Core application logic (~800 lines) handles:
  - State management for sessions and configuration
  - Streaming API calls using Server-Sent Events
  - Message rendering with markdown support (marked.js)
  - Session management and history
  - Real-time UI updates during streaming
- **`sidebar.css`**: Complete theming system with light/dark modes

#### 2. Configuration Management (`options/`)
- **Provider Management**: CRUD operations for LLM service providers
- **System Prompts**: Pre-configured and custom prompt management
- **Import/Export**: Configuration backup and restore functionality
- **LLM Parameters**: Temperature (optional), max_completion_tokens, streaming and reasoning effort/summary

#### 3. Storage Schema
```javascript
// Chrome Storage API (sync for config, local for chats)
{
  config: {
    providers: [...],           // OpenAI-compatible API providers
                                // each: { id, name, baseUrl, apiKey, apiType, models: [...] }
                                // apiType: 'chat' (default) | 'responses'
    selectedProvider: string,   // Currently selected provider (ID)
    selectedModel: string,      // Currently selected model (composite key: "modelId - providerId")
    selectedSystemPrompt: string,
    temperature: number|null,   // null = omit the parameter (reasoning models reject it)
    max_completion_tokens: string,
    stream: boolean,
    reasoning_effort: string,   // '' = not sent | minimal | low | medium | high
    reasoning_summary: string,  // Responses API only: off (default) | auto | concise | detailed
    systemPrompts: [...],       // Custom system prompts
    theme: string               // 'light', 'dark', or 'system' (default)
  },
  // one key per chat: "session:<id>" -> { rev, session }
  // rev is an opaque token replaced by every write (see Chat storage below)
  "session:<id>": {
    rev: string,
    session: {
      messages: [...],          // Chat history with reasoning content
      title: string,
      timestamp: string,
      modelUsed: string,        // Composite key "modelId - providerId"
      systemPromptId: string
    }
  },
  currentSessionId: string,
  drafts: {
    [sessionId]: string         // Unsent input; the side panel unloads on close
  }
}

Assistant messages additionally carry streaming metadata: `startedAt`,
`thinkingMs`, `durationMs`, `reasoningCollapsed` and `reasoningTouched`
(set once the user opens or closes the reasoning panel by hand, which
disables auto-collapse for that message).
```

**Note**: Model selection uses a composite key format `"modelId - providerId"` to support models with the same ID from different providers. When making API requests, only the `modelId` portion is extracted and sent.

## Development Workflow

### Loading the Extension for Development
```bash
# No build step required - just load the extension
1. Open chrome://extensions/
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the sidemind directory
```

### Debugging
- **Sidebar UI**: Right-click in sidebar → Inspect (opens DevTools for sidebar)
- **Background Script**: Go to `chrome://extensions/` → Service worker → inspect
- **Options Page**: Right-click on options page → Inspect

### Making Changes
- **No build process** - just edit files and click "Reload" on `chrome://extensions/`
- Changes take effect immediately after reload
- For CSS/JS changes, you may need to close and reopen the sidebar

### Building Release Package
```bash
./build.sh
```
Creates `sidemind-vX.X.X.zip` (version read from manifest.json) containing only essential files for Chrome Web Store submission.

## Key Implementation Details

### API Adapters (Chat Completions + Responses)
Two request/response shapes are supported, selected **per provider** via `provider.apiType`:

| apiType | Endpoint | Request | Text delta | Reasoning delta |
|---|---|---|---|---|
| `chat` (default) | `/chat/completions` | `messages[]`, `max_completion_tokens`, `reasoning_effort` | `choices[0].delta.content` | `choices[0].delta.reasoning_content` |
| `responses` | `/responses` | `input[]` + `instructions`, `max_output_tokens`, `reasoning:{effort,summary}`, `store:false` | `response.output_text.delta` | `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` |

- **`API_ADAPTERS`** (sidebar.js) maps each type to `{ endpoint, buildRequestBody, applyStreamEvent, applyResponse }`; everything outside the adapters is API-agnostic.
- **Responses is stateless here**: `store: false` and the full history is replayed as `input` on every turn — no `previous_response_id`.
- **Reasoning visibility**: OpenAI reasoning models only emit a chain of thought when `reasoning.summary` is requested. It is opt-in (`reasoning_summary: 'off'` by default) because not every model accepts reasoning options.
- **Chat reasoning fields**: `readReasoningField()` reads `reasoning_content` (DeepSeek, LM Studio, older vLLM) or `reasoning` (OpenRouter, Ollama, newer vLLM) - one of them, never both, since some servers send the same text in each.
- **History**: `buildHistory()` drops assistant turns without answer text (failed, or stopped while reasoning) - many providers reject an empty assistant message.
- **Base URL normalization**: `buildEndpointUrl()` strips trailing slashes and a pasted `/chat/completions` or `/responses` suffix, so one base URL works for both.

### Streaming API Integration
- **Server-Sent Events (SSE)**: Real-time streaming for both APIs. `event:` lines are ignored — both formats carry a discriminator inside the `data:` payload.
- **Reasoning Format Support**: Handles `reasoning_content`/`reasoning`, Responses reasoning events, and `<think>`/`<thinking>` tags.
  While streaming, `displayParts(message)` shows a leading inline think block as reasoning (the sanitizer would otherwise drop the
  unknown tag and its text); `processThinkTags()` moves it out for good in `cleanupStreaming()`, after any outcome. A leading tag
  that never closes (stopped mid-thought) is all reasoning.
- **Error events**: `error` / `response.failed` / streamed `{"error":...}` abort the stream with the provider's own message
- **AbortController**: Proper cancellation of in-flight requests with stop button
- **Timeouts** (`createRequestWatchdog`): 120s for headers when streaming, 600s without streaming (headers only arrive with the
  finished answer), then 180s idle between chunks
- **Key functions**: `streamResponse()`, `processStream()`, `processStreamLine()` in `sidebar/sidebar.js`

### Message Rendering & Caching
- **Element Cache**: DOM elements cached in `messageElementCache` Map for fast updates
- **Throttled Streaming**: Deltas are coalesced by `scheduleMessageDisplay()` into one repaint
  per `STREAM_RENDER_INTERVAL` (60ms). `flushMessageDisplays()` forces a pending frame out —
  call it before any final render.
- **Markdown Cache**: Size-limited cache (100 entries). `renderMarkdown(text, cache)` is called
  with `cache: false` while streaming, otherwise every intermediate prefix of the growing
  message would be stored and would evict the finished messages that are actually re-read.
- **Debounced Saves**: 1-second debounce on `saveToStorage()` to reduce chrome.storage writes
- **Auto-scroll Detection**: Only auto-scroll when user is at bottom (50px threshold);
  `scrollToBottom(true)` forces a smooth jump for the jump-to-latest button
- **Code Blocks**: `decorateCodeBlocks()` highlights, labels and adds a copy button to each
  block, but only on the final render — mid-stream the whole subtree is replaced on the next
  repaint anyway. Unknown languages are labelled but left untouched (hljs throws on them).

### Streaming UI States
An assistant message moves through four visible states, all driven by `updateMessageDisplay()`:

1. **Waiting** — pulsing dots (`.typing-indicator`), plus an elapsed counter after 3s.
   `message.startedAt` is stamped when the request goes out.
2. **Thinking** — reasoning section appears folded, header ticks `Reasoning… 8s` via
   `startStreamTicker()` (1s interval, updates labels only — no markdown re-render). Opened,
   the panel follows new reasoning unless the reader scrolls up inside it.
3. **Answering** — the first visible token sets `message.thinkingMs` and the header settles on
   `Reasoning · 12s`; the reasoning folds away unless `message.reasoningTouched`
   (the user opened or closed it by hand).
4. **Done** — `cleanupStreaming()` records `message.durationMs`, flushes pending frames, then
   repaints once more so the final markdown is cached and code blocks get their copy buttons.

Screen readers are served by `#srStatus` (`role="status"`), not by a live region on the
transcript — the transcript's content is rewritten on every repaint.

### Model Selection (Composite Key Pattern)
To support models with identical IDs from different providers, the extension uses a composite key:
- **Storage Format**: `"modelId - providerId"` (e.g., `"gpt-4 - provider123"`)
- **UI Display**: Models grouped by provider in `<optgroup>` elements
- **Parsing**: always via `parseModelKey()`, which splits at the *last* `" - "` (provider ids are generated, model ids can contain anything)
- **API Request**: Extracts only `modelId` when building request body (`getSelectedModelId()`)
- **Readiness**: `getReadyProvider()` (model still exists and provider has a key) gates Send; `ensureReadyToSend()`
  gates Regenerate and Edit *before* they truncate the chat
- **Key Functions**: `updateModelSelector()`, `handleModelChange()`, `buildRequestBody()`

### Token Usage
`readUsage()` normalises the two namings (`prompt/completion_tokens` vs
`input/output_tokens`) into `message.usage`. It is read wherever a provider offers it:
`response.completed` on the Responses API, the final chunk on Chat Completions, and the
body of any non-streaming response. `stream_options: {include_usage: true}` is deliberately
**not** sent — OpenAI needs it for streamed Chat Completions usage, but compatible servers
often reject the parameter, so a missing count is preferred over a failed request.

### Editing a User Message
`startEditing()` swaps the bubble's rendered text for a textarea in place (Enter submits,
Shift+Enter is a newline, Escape cancels); `submitEdit()` rewrites `message.content`,
truncates the turns that followed, re-titles the chat when the first message changed, and
replays from there. Only user messages are editable — rewriting an assistant reply is a
different feature. `cancelEditing()` is called at the top of `renderMessages()`, so any
re-render ends an open edit rather than leaving a stale editor behind.

### Destructive Actions
Editing and regenerating both truncate everything after the message, and deleting a chat
removes it outright. All of them hand their removed content to `offerUndo(text, restore)`,
which shows the undo bar for `UNDO_TIMEOUT` (10s). `clearUndo()` is called whenever
the transcript changes for another reason (sending, switching or creating a chat).
Anything that swaps the transcript while a stream is running must first await
`stopStreamingIfActive()` - `createNewSession()` and `deleteSession()` used to skip
this and left the request running against an abandoned session.

`activateSession()` is the one place that changes the visible chat. A *blank* chat (no
messages, no draft - `isBlankSession()`) is reused by New chat, dropped when left, and
hidden from history. Undoing the deletion of the open chat activates it again.

### Chat Storage (several side panels, one storage area)
Every chat is its own key, `session:<id>` = `{ rev, session }`; `rev` is a random token replaced by each write.
A save (`writeLocalChanges()`, inside the `sidemind-local-storage` Web Lock) reads only the chats this page changed:

- **Did this page change a chat?** Decided against the page's own snapshot (`savedSessions`, text from this page's
  own `JSON.stringify`). **Did another page?** Decided by `rev`: the stored `rev` is still the one this page last
  saw (`savedRevs`) -> write straight over it, no merge. Otherwise `mergeSession()` merges three-way by message id;
  for a message both pages changed, the page that saves last wins. A chat deleted by one page survives if another changed it.
- **The rule: never compare content read back from `chrome.storage` with text this page serialised itself.**
  `chrome.storage` reorders object keys alphabetically and drops `undefined` fields, so such a comparison is not a
  statement about content - it once turned every save of a streaming reply into a "conflict with another window" and
  spawned a "(conflicting copy)" chat per save. Compare values with `sameValue()` (`assets/js/ui.js`, key-order
  independent) or with a `rev`. The test fixtures reproduce the reordering; keep them doing so.
- **Following other pages**: `chrome.storage.onChanged` -> `handleStoredChanges()` adopts a changed chat in place
  (`replaceSessionContent()` keeps the live message objects, a running stream holds them) unless this page has unsaved
  changes in it, the chat is streaming/being edited, or it is the open chat removed elsewhere.
- **Closing pages** (`pagehide`) cannot take the lock, so they write one `pending:<pageId>:<uuid>` stash and nothing
  else. The next full scan (`writeLocalChanges(true, { scanAll: true })` at load, or when `onChanged` announces a new
  stash) folds stashes oldest first. The `appliedPending` marker is written in the same `set` as the fold, so a failed
  stash removal is only retried, never replayed.
- **Earlier layouts**: a one-table `sessions` key (and `pendingSave:` stashes) is converted on first load; the old table
  is kept as `backup:sessions-v1`. `mergeCopyFamilies()` folds the `conflict-<id>-<nonce>` chats the streaming bug left
  back into their chat (only when one copy holds all the others as growing prefixes); real divergences are kept.

### Host Permissions
Providers are reached through optional host permissions (`<all_urls>` is only the upper
bound). Settings sync across devices but permissions do not, so a provider can be
configured yet not allowed here. Shared helpers in `assets/js/ui.js`
(`hasProviderAccess`, `requestProviderAccess`) back three recovery paths: the provider row
in Settings shows **Allow access**, import asks for every provider at once, and a fetch
`TypeError` without access becomes an `errorAction: 'permission'` with an **Allow access**
button that grants and retries. `requestProviderAccess` must be called before anything is
awaited in the click handler, or Chrome drops the user gesture.

### Configuration Management
- **Provider CRUD**: Full create/read/update/delete for LLM providers
- **System Prompts**: Custom prompt management with default prompt
- **Import/Export**: JSON-based config backup/restore (options.js:700-749)
- **Validation**: Schema validation on import via `validateConfig()`
- **Permissions**: Optional host_permissions for `<all_urls>` - user must grant when needed

### Storage Strategy
- **Config**: Stored in `chrome.storage.sync` (synced across devices, 8KB per item - see `assertConfigFitsSync()`)
- **Sessions**: Stored in `chrome.storage.local`, one `session:<id>` key per chat (local only; `unlimitedStorage` lifts the 10MB quota)
- **Session IDs**: Timestamp-based strings (`Date.now().toString()`)
- **Message IDs**: Timestamp-based strings with role (user/assistant) and content
- **Auto-titles**: First user message, whitespace collapsed, cut at 50 code points (`titleFromContent()`)

### Theme System
- **CSS Variables**: Theme colors defined in `:root` (light) and `[data-theme="dark"]` (dark)
- **System Detection**: Uses `prefers-color-scheme` media query for automatic theme
- **Manual Override**: User can select light/dark/system in options page (system is the default)
- **No flash**: `assets/js/ui.js` loads in `<head>` and applies the last theme from a localStorage
  mirror (`cacheAppearance()`), since `chrome.storage` only answers after the first paint
- **Smooth Transitions**: 200ms ease transition on theme changes (sidebar.css)

## Code Architecture

### Main Application Flow (sidebar.js)
```
DOMContentLoaded
    ↓
cacheElements() → cache DOM references
    ↓
loadFromStorage() → load config and sessions from chrome.storage
    ↓
renderMessages() → render current session messages
    ↓
updateInputState() → enable/disable send button based on config
```

### API Call Flow
```
handleSendMessage()
    ↓
addMessage('user', content)
    ↓
sendMessageToAPI()
    ↓
streamResponse()
    ├─→ makeApiRequest() → fetch with AbortController
    ├─→ processStream() → read SSE stream
    │   └─→ processStreamLine() → parse each data: line
    │       └─→ updateMessageDisplay() → update DOM
    └─→ cleanupStreaming() → final save
```

### State Management Pattern
- **Global `state` object**: Single source of truth (sidebar.js:8-32)
- **Direct mutation**: State mutated directly, then saved via debounced `saveToStorage()`
- **Reactive rendering**: Functions like `renderMessages()` called after state changes
- **No framework**: Pure vanilla JS with manual DOM updates

### Options Page Architecture (options.js)
- **Modal-based editing**: Provider and system prompt CRUD via modal dialogs
- **Check connection**: `GET {baseUrl}/models` verifies URL and key and fills the `#modelSuggestions`
  datalist used by Model ID fields
- **Direct config manipulation**: Load → Modify → Save pattern
- **Notification system**: Simple toast notifications for success/error feedback
- **Export/Import**: JSON file-based config backup/restore

## File Organization

```
sidemind/
├── manifest.json              # Extension configuration
├── background.js              # Service worker (3 lines)
├── sidebar/                  # Main chat interface
│   ├── sidebar.html          # Chat UI structure
│   ├── sidebar.css           # Complete theming system
│   ├── sidebar.js            # Core application logic
│   ├── marked.umd.js         # Markdown parsing library (vendored)
│   └── highlight.min.js      # Syntax highlighting (vendored)
├── options/                  # Configuration page
│   ├── options.html          # Options UI
│   ├── options.css           # Options styling
│   └── options.js            # Configuration management (~800 lines)
├── assets/                   # Static assets
│   ├── css/
│   │   ├── ui.css            # Shared design tokens and controls (both pages)
│   │   └── fontawesome.min.css # FontAwesome 6 icons
│   ├── js/
│   │   └── ui.js             # Shared helpers: theme cache, host access, dialog focus, sync quota
│   ├── icons.svg             # UI icon library
│   └── webfonts/             # FontAwesome font files
├── icons/                    # Extension icons (16/48/128px)
├── tests/                    # node --test suites (api, background; ui needs Playwright, see README)
├── build.sh                  # Chrome extension package builder
└── local/                    # Internal documentation (excluded from build)
```

## Common Tasks

### Adding a New Provider
1. Right-click extension → Options
2. Click "Add Provider" button
3. Fill in provider details (name, base URL, API key)
4. Pick the **API Type** — `Chat Completions` for the classic endpoint, `Responses` for OpenAI's newer API
5. Add models with display names
6. Save

### Using the Responses API
- Set the provider's API Type to `Responses` (base URL stays the root, e.g. `https://api.openai.com/v1`)
- For GPT-5 style reasoning models, tick **Use model default (omit temperature)** — they reject `temperature`
- Set **Reasoning Summary** to `auto` to see the model's thinking; leave it `off` (default) for providers that reject the field

### Debugging Streaming Issues
- Open DevTools in sidebar (right-click → Inspect)
- Check Network tab for API calls
- Verify provider supports OpenAI-compatible streaming
- Check console for JavaScript errors

### Modifying Themes
- Edit CSS variables in `sidebar/sidebar.css`
- `:root` = light theme, `[data-theme="dark"]` = dark theme
- Reload extension after changes

### Updating Version
1. Edit `version` in `manifest.json`
2. Run `./build.sh` to create new package

## External Dependencies

- **marked.js** v17 (MIT): Markdown parsing (sidebar/marked.umd.js) - local file, ~40KB
- **highlight.js** v11 (BSD-3-Clause): Syntax highlighting (sidebar/highlight.min.js) - the
  "common" bundle, 36 languages, ~124KB. Token colours are defined in sidebar.css against the
  app's own CSS variables rather than importing an hljs theme.
- **FontAwesome 6**: Icon library (assets/) - self-hosted for offline use
- No CDN dependencies - fully self-contained

## Browser Compatibility

- **Chrome 114+** (Side Panel API requirement)
- Uses modern JavaScript features (async/await, fetch, CSS Grid/Flexbox)
- Modern CSS features: CSS variables, Grid, Flexbox, transitions
