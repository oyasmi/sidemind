# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SideMind** is a production-ready Chrome Extension (Manifest V3) that provides a sidebar interface for chatting with Large Language Models (LLMs). It's built with vanilla HTML/CSS/JavaScript following the KISS principle - no frameworks, no build tools, just pure web technologies.

### Current Status
- **Version**: 1.3.0 (Production Ready)
- **Chrome Web Store**: Published and available for installation
- **License**: Apache 2.0
- **Total Development Time**: ~3-4 hours
- **Lines of Code**: ~2000+ lines across 15+ files

### Key Design Philosophy
- **No Frameworks**: Pure vanilla JavaScript - no React, Vue, or build tools
- **Self-Contained**: All assets (FontAwesome, icons) are local - no CDN dependencies
- **KISS Principle**: Simple, straightforward code that's easy to understand and modify
- **OpenAI-Compatible API**: Works with any LLM provider that supports the OpenAI chat completions format

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
- **LLM Parameters**: Temperature and max_completion_tokens configuration

#### 3. Storage Schema
```javascript
// Chrome Storage API (sync for config, local for sessions)
{
  config: {
    providers: [...],           // OpenAI-compatible API providers
    selectedProvider: string,   // Currently selected provider (ID)
    selectedModel: string,      // Currently selected model (composite key: "modelId - providerId")
    selectedSystemPrompt: string,
    temperature: number,
    max_completion_tokens: string,
    stream: boolean,
    systemPrompts: [...],       // Custom system prompts
    theme: string               // 'light', 'dark', or 'system'
  },
  sessions: {
    [sessionId]: {
      messages: [...],          // Chat history with reasoning content
      title: string,
      timestamp: string,
      modelUsed: string,
      systemPromptId: string
    }
  },
  currentSessionId: string
}
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

### Streaming API Integration
- **Server-Sent Events (SSE)**: Real-time streaming using OpenAI-compatible format
- **Dual Reasoning Format Support**: Handles `reasoning_content` field and `<think>`/`<thinking>` tags
- **AbortController**: Proper cancellation of in-flight requests with stop button
- **360s Timeout**: Configurable timeout for complex reasoning tasks
- **Key functions**: `streamResponse()`, `processStream()`, `processStreamLine()` in sidebar.js:971-1070

### Message Rendering & Caching
- **Element Cache**: DOM elements cached in `messageElementCache` Map for fast updates
- **Markdown Cache**: Size-limited cache (100 entries) for parsed markdown output
- **Debounced Saves**: 1-second debounce on `saveToStorage()` to reduce chrome.storage writes
- **Auto-scroll Detection**: Only auto-scroll when user is at bottom (50px threshold)
- **Incremental Updates**: During streaming, only update changed message content

### Model Selection (Composite Key Pattern)
To support models with identical IDs from different providers, the extension uses a composite key:
- **Storage Format**: `"modelId - providerId"` (e.g., `"gpt-4 - provider123"`)
- **UI Display**: Models grouped by provider in `<optgroup>` elements
- **API Request**: Extracts only `modelId` when building request body (sidebar.js:1140)
- **Key Functions**: `updateModelSelector()`, `handleModelChange()`, `buildRequestBody()`

### Configuration Management
- **Provider CRUD**: Full create/read/update/delete for LLM providers
- **System Prompts**: Custom prompt management with default prompt
- **Import/Export**: JSON-based config backup/restore (options.js:700-749)
- **Validation**: Schema validation on import via `validateConfig()`
- **Permissions**: Optional host_permissions for `<all_urls>` - user must grant when needed

### Storage Strategy
- **Config**: Stored in `chrome.storage.sync` (synced across devices, 100KB limit)
- **Sessions**: Stored in `chrome.storage.local` (local only, ~5MB limit)
- **Session IDs**: Timestamp-based strings (`Date.now().toString()`)
- **Message IDs**: Timestamp-based strings with role (user/assistant) and content
- **Auto-titles**: First user message truncated to 50 chars as session title

### Theme System
- **CSS Variables**: Theme colors defined in `:root` (light) and `[data-theme="dark"]` (dark)
- **System Detection**: Uses `prefers-color-scheme` media query for automatic theme
- **Manual Override**: User can select light/dark/system in options page
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
│   ├── sidebar.js            # Core application logic (~800 lines)
│   └── marked.umd.js         # Markdown parsing library
├── options/                  # Configuration page
│   ├── options.html          # Options UI
│   ├── options.css           # Options styling
│   └── options.js            # Configuration management (~800 lines)
├── assets/                   # Static assets
│   ├── css/
│   │   └── fontawesome.min.css # FontAwesome 6 icons
│   ├── icons.svg             # UI icon library
│   └── webfonts/             # FontAwesome font files
├── icons/                    # Extension icons (16/48/128px)
├── build.sh                  # Chrome extension package builder
└── local/                    # Internal documentation (excluded from build)
```

## Common Tasks

### Adding a New Provider
1. Right-click extension → Options
2. Click "Add Provider" button
3. Fill in provider details (name, base URL, API key)
4. Add models with display names
5. Save

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

- **marked.js**: Markdown parsing (sidebar/marked.umd.js) - local file, ~40KB
- **FontAwesome 6**: Icon library (assets/) - self-hosted for offline use
- No CDN dependencies - fully self-contained

## Browser Compatibility

- **Chrome 114+** (Side Panel API requirement)
- Uses modern JavaScript features (async/await, fetch, CSS Grid/Flexbox)
- Modern CSS features: CSS variables, Grid, Flexbox, transitions
