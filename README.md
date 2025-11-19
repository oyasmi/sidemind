# SideMind - AI Chat Assistant in Your Browser Sidebar

> **Your private AI companion that lives right in your browser sidebar**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Published-blue.svg)](https://chromewebstore.google.com/detail/sidemind/hhaldjkbgpmkalamncelaoplklphdfnp)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg)](manifest.json)

## ✨ Why SideMind?

**SideMind brings the power of AI to your browsing experience without compromising your privacy.** Unlike web-based AI services, SideMind runs entirely in your browser, keeping your conversations private and secure.

### 🚀 Key Features

- **🎯 Always Accessible** - Chat with LLMs in your browser sidebar, available on any webpage
- **🔐 Privacy First** - All conversations stored locally, no data collection or tracking
- **🤖 Multi-Provider Support** - Works with OpenAI, Claude, and any OpenAI-compatible API
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

- **🛡️ 100% Local Storage** - Your conversations never leave your browser
- **🔑 Secure API Keys** - API keys stored securely in Chrome storage
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
   - Select your preferred model

2. **Start Chatting**
   - Click the SideMind icon to open the sidebar
   - Choose your AI model and system prompt
   - Start chatting with your AI assistant!

## 🔧 Supported Providers

SideMind works with any OpenAI-compatible LLM chat API:

- **OpenAI** - GPT-3/4/5
- **Anthropic Claude** - Claude family
- **Google Gemini** - Gemini Pro models
- **Alibaba Cloud** - Qwen models
- **DeepSeek** - DeepSeek R1/V3.1/V3.2-Exp
- **Local Models** - Ollama, LM Studio, and more
- **Custom Providers** - Any service with OpenAI-compatible endpoints

## 🎨 Features Overview

### Chat Management
- Multiple chat sessions with auto-titles
- Chat history keep in local storage
- Message regeneration and editing

### AI Capabilities
- Real-time streaming responses
- Thinking/reasoning display
- Markdown rendering
- Code syntax highlighting
- Copy message content
- System prompt customization

### User Experience
- Clean, modern interface
- Keyboard shortcuts (Enter to send, Shift+Enter for new line)
- Auto-resizing input field
- Smooth animations and transitions
- Responsive design for different sidebar widths

## 🛠️ Technical Details

- **Manifest V3** Chrome Extension
- **Side Panel API** for native sidebar integration
- **Pure JavaScript** - No frameworks, no dependencies
- **Chrome Storage API** for secure local data persistence
- **Server-Sent Events** for real-time streaming
- **Content Security Policy** compliant

## 📄 License

SideMind is released under the [Apache License 2.0](LICENSE).

---

**Made with ❤️ for privacy-conscious AI users**

*SideMind is not affiliated with OpenAI, Anthropic, Google, or any AI providers. We provide a user interface for accessing their services.*