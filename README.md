# SideMind - AI Chat Assistant in Your Browser Sidebar

> **Your private AI companion that lives right in your browser sidebar**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Published-blue.svg)](https://chromewebstore.google.com/detail/sidemind/hhaldjkbgpmkalamncelaoplklphdfnp)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.6.0-orange.svg)](manifest.json)

## ✨ Why SideMind?

**SideMind brings the power of AI to your browsing experience without compromising your privacy.** Unlike web-based AI services, SideMind runs entirely in your browser, keeping your conversations private and secure.

### 🚀 Key Features

- **🎯 Always Accessible** - Chat with LLMs in your browser sidebar, available on any webpage
- **🔐 Privacy First** - All conversations stored locally, no data collection or tracking
- **🤖 Multi-Provider Support** - Works with OpenAI, Claude, and any OpenAI-compatible API (Chat Completions or Responses)
- **⚡ Real-time Streaming** - Watch AI responses appear in real-time with smooth animations
- **🧠 Thinking Display** - See AI reasoning process in collapsible sections
- **💬 Smart Chat Management** - Multiple chat sessions with auto-generated titles
- **🎨 Beautiful Themes** - Light/Dark themes with smooth transitions
- **⚙️ Flexible Configuration** - Custom system prompts, temperature, and token limits

## 🎯 Perfect For

- **Developers** - Quick code assistance while working on projects
- **Writers** - AI writing help without leaving your research tab
- **Researchers** - Summarize and analyze content while browsing
- **Students** - Study assistance and homework help
- **Professionals** - Quick answers and content generation
- **Privacy-conscious users** - AI assistance without data sharing concerns

## 🔒 Security & Privacy

SideMind is designed with your privacy as the top priority:

- **🛡️ Local History** - Conversation history is stored in this browser; messages are sent to your chosen AI provider for replies
- **🔑 Your Configuration** - Providers, API keys and preferences use Chrome sync storage
- **📊 No Analytics** - We don't track, collect, or analyze your usage
- **🌐 No Servers** - Works completely offline (except for API calls)
- **🔍 Open Source** - Fully transparent code you can review yourself
- **🚫 No Permissions** - Only requests necessary API access

## 🚀 Getting Started

### Installation

1. **From Chrome Web Store** (Recommended)
   - Visit SideMind on [Chrome Web Store](https://chromewebstore.google.com/detail/sidemind/hhaldjkbgpmkalamncelaoplklphdfnp)
   - Click "Add to Chrome"
   - Grant necessary permissions

2. **Manual Installation**
   ```bash
   # Clone this repository
   git clone https://github.com/oyasmi/sidemind
   cd sidemind

   # Open Chrome Extensions page
   chrome://extensions/

   # Enable Developer Mode and load unpacked
   # Select the `sidemind` directory
   ```

### Setup

1. **Configure Your AI Provider**
   - Click the SideMind icon in your toolbar
   - Open Options (right-click → Extension Options)
   - Add your AI provider with API key
   - Pick the API type: **Chat Completions** (`/chat/completions`) or **Responses** (`/responses`)
   - Click **Check connection** to verify the URL and key; the provider's model IDs then appear as suggestions
   - Select your preferred model

2. **Start Chatting**
   - Click the SideMind icon to open the sidebar
   - Choose your AI model and system prompt
   - Start chatting with your AI assistant!

## 🔧 Supported Providers

SideMind works with any OpenAI-compatible LLM API - both the classic **Chat Completions**
endpoint and OpenAI's newer **Responses** API. The API type is chosen per provider, so you can
mix both in the same install.

For OpenAI Responses, open **Options → Add Provider** (or edit an existing provider),
set **Base URL** to `https://api.openai.com/v1`, and choose **API Type → Responses**.
Save the provider, then select one of its models in the sidebar. Providers without an
API type continue to use Chat Completions. You can configure the same service twice
to keep both API types available in the model selector.

Both APIs support streaming and complete responses, system prompts, and local
conversation history. Responses requests use `instructions`, `input`, and
`max_output_tokens`, with `store: false` and the local history sent on each turn.
For models that reject temperature, enable **Use model default**. Reasoning summaries
are off by default; enable **Reasoning Summary → Auto** for models that support them.
If a response reaches its output limit, SideMind keeps the partial answer and
shows a message explaining how to increase the limit.
See the [official OpenAI Responses API documentation](https://developers.openai.com/api/reference/responses/overview).

- **OpenAI** - GPT-3/4/5 (Chat Completions or Responses)
- **Anthropic Claude** - Claude family
- **Google Gemini** - Gemini Pro models
- **Alibaba Cloud** - Qwen models
- **DeepSeek** - DeepSeek R1/V3.1/V3.2-Exp
- **Local Models** - Ollama, LM Studio, and more
- **Custom Providers** - Any service with OpenAI-compatible endpoints

## 🎨 Features Overview

### Chat Management
- Multiple chat sessions with auto-titles
- Chat history stays in local storage, with search and inline renaming
- Export any conversation as Markdown, including reasoning, model details and partial-response notices
- Edit any message you sent and replay the conversation from there
- Regenerate a response, with undo

### AI Capabilities
- Real-time streaming responses (Chat Completions + Responses APIs)
- Thinking/reasoning display, including Responses API reasoning summaries, `reasoning_content` /
  `reasoning` fields, and inline `<think>` tags (shown as reasoning while they stream)
- Configurable reasoning effort and summary detail
- Markdown rendering
- Syntax highlighting for 36 languages, with per-block copy buttons
- Code toolbars stay visible during horizontal scrolling; long completed blocks can expand or collapse
- Response time and token usage per message
- Copy message content
- System prompt customization

### User Experience
- Shared light, dark and system themes across chat and settings
- Task-oriented settings with automatic save feedback and a live appearance preview
- Keyboard shortcuts (Enter to send, Shift+Enter for new line, Esc to stop)
- Open the sidebar with Alt+Shift+S, start a chat with Ctrl/Cmd+Shift+O, and focus the input with Shift+Esc
- Right-click selected webpage text to add it and its source to your current draft; review and send when ready
- Current conversation titles and provider names remain visible while chatting
- Unsent drafts are kept per chat; New chat reuses an empty chat instead of piling up blank ones
- Undo for regenerating and for deleting a chat (undoing a deletion returns to that chat)
- Auto-resizing input field
- Long streaming answers preserve your reading position; follow the output when you choose
- Failed requests retain partial answers and offer retry
- Request and stream-idle timeouts restore the input; output limits and unconfirmed completion remain visible in history
- Local save failures offer retry without losing the in-memory draft; failed history loads cannot overwrite stored conversations
- Oversized sync settings receive an actionable size warning while keeping edits available
- Keyboard-accessible dialogs with focus restoration and reduced-motion support
- Configuration backups omit API keys by default, with a preview before importing
- Settings sync between devices but Chrome host access does not: providers not yet allowed on
  this device show an **Allow access** button, and a blocked request offers to allow and retry
- Responsive design for different sidebar widths

The selection context menu uses Chrome's `contextMenus` permission and only receives
text you explicitly select. It does not extract the whole page or send a request
automatically. Chrome 116+ is required. The opening shortcut can be changed at
`chrome://extensions/shortcuts`; in-panel shortcuts leave dialogs and IME input alone.

Streaming uses a two-minute request timeout and a three-minute idle timeout after
headers arrive. With streaming off, the whole answer must be ready before headers
arrive, so complete responses get ten minutes. Incoming stream chunks, including heartbeats, reset the idle timer.
Compatible providers that omit completion markers still display their answer, with
a notice that completion could not be confirmed. API calls are never automatically
retried.

Rendering skips folded reasoning until expansion and preserves unchanged Markdown
subtrees. History search is debounced and caches searchable text; the Markdown cache
is bounded by both entry count and text size. Storage stays on Chrome's existing
sync/local APIs, without a database or new runtime dependencies. Conversations use
the `unlimitedStorage` permission (no install warning), so long histories are not
cut off by the default local storage quota.

## 🛠️ Technical Details

- **Manifest V3** Chrome Extension
- **Side Panel API** for native sidebar integration
- **Pure JavaScript** - No frameworks, no dependencies
- **Chrome Storage API** for secure local data persistence
- **Server-Sent Events** for real-time streaming
- **Content Security Policy** compliant

Run the API regression checks with Node.js 18+ (no dependencies or API key needed):

```bash
node --test tests/api.test.cjs tests/background.test.cjs
```

The checks cover provider selection, request formats, multi-turn history, both
response modes, SSE chunk boundaries, cancellation, request and idle timeouts,
terminal events, output limits, and the selection context menu.
Browser interaction checks use optional Playwright tooling installed outside the
extension (no runtime dependencies or build step):

```bash
npm install --prefix /tmp/sidemind-browser-tests playwright
/tmp/sidemind-browser-tests/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/sidemind-browser-tests/node_modules/playwright \
  node --test tests/ui.test.cjs
```

Set `CHROMIUM_PATH` to an existing Chromium executable to use it instead of the
Playwright download. Set `UI_SCREENSHOTS` to an existing directory to save visual
previews. These checks exercise draft preservation, stream reading, stop/retry,
selection, history, modal focus, local save recovery, configuration size limits,
code expansion/copy, Markdown exports, shortcuts and import previews.
The suite uses fixture providers and makes no real AI requests.

Build the extension package with `./build.sh`.

## 📄 License

SideMind is released under the [Apache License 2.0](LICENSE).

---

**Made with ❤️ for privacy-conscious AI users**

*SideMind is not affiliated with OpenAI, Anthropic, Google, or any AI providers. We provide a user interface for accessing their services.*
