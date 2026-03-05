# AGENTS.md - SideMind Chrome Extension

## Project Overview

SideMind is a production-ready Chrome Extension (Manifest V3) providing a sidebar AI chat interface. Built with pure vanilla HTML/CSS/JavaScript following the KISS principle - no frameworks, no build tools.

## Build Commands

```bash
# Build release package for Chrome Web Store
./build.sh

# No other build steps required - pure static files
```

## Development Workflow

1. **Load for Development**:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `sidemind` directory

2. **Reload after changes**:
   - Click "Reload" button on `chrome://extensions/`
   - Close and reopen sidebar for CSS/JS changes

3. **Debugging**:
   - Sidebar: Right-click → Inspect
   - Background: `chrome://extensions/` → Service worker → Inspect
   - Options: Right-click → Inspect

## Code Style Guidelines

### JavaScript

- **Language**: Vanilla ES6+ JavaScript, no transpilation
- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Naming**:
  - Variables/functions: camelCase (`messageInput`, `handleSendMessage`)
  - Constants: UPPER_SNAKE_CASE for true constants
  - DOM elements: Store in `elements` object with camelCase keys
- **Comments**: Use `//` for inline, `/* */` for blocks, section headers with `=======`
- **Error handling**: Wrap async operations in try/catch, log errors with context
- **Storage**: Use `chrome.storage.sync` for config, `chrome.storage.local` for sessions

### CSS

- **Approach**: Vanilla CSS with CSS variables for theming
- **Indentation**: 2 spaces
- **Naming**: kebab-case for class names (`.message-input`, `.chat-container`)
- **Variables**: Use CSS custom properties in `:root` for theming
- **Comments**: Use `/* ===== Section Name ===== */` style headers

### HTML

- **Indentation**: 2 spaces
- **Quotes**: Double quotes for attributes
- **Structure**: Semantic HTML5 elements (`<header>`, `<main>`, `<footer>`)

### File Organization

```
sidemind/
├── manifest.json          # Extension manifest
├── background.js          # Service worker (keep minimal)
├── sidebar/               # Main chat interface
│   ├── sidebar.html
│   ├── sidebar.css
│   ├── sidebar.js         # Core app logic
│   └── marked.umd.js      # Markdown parser (vendor)
├── options/               # Configuration page
│   ├── options.html
│   ├── options.css
│   └── options.js
├── assets/                # Static assets (FontAwesome)
└── icons/                 # Extension icons
```

## Architecture Patterns

### State Management
- Single global `state` object as source of truth
- Direct mutation, then debounced save via `saveToStorage()`
- Reactive rendering: call render functions after state changes

### DOM Handling
- Cache elements in `elements` object on init
- Use `document.getElementById()` and `document.querySelector()`
- Create elements via `document.createElement()`, not innerHTML for dynamic content

### Storage Pattern
```javascript
// Config in sync storage (cross-device)
await chrome.storage.sync.set({ config: state.config });

// Sessions in local storage (privacy)
await chrome.storage.local.set({ sessions: state.sessions });
```

### Event Handling
- Separate `setupEventListeners()` function
- Use named handler functions (not inline)
- Debounce frequent operations (saves, input handling)

## Key Conventions

- **No dependencies**: All assets self-hosted, no CDN
- **No frameworks**: Pure vanilla JS only
- **Privacy-first**: All data stored locally
- **Chrome APIs**: Use Manifest V3 APIs (`chrome.storage`, `chrome.sidePanel`)
- **Error messages**: User-friendly notifications via `showNotification()`
