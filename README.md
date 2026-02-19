# Neural Deck

A sleek Electron desktop client for [Ollama](https://ollama.com) with a Linux terminal–inspired UI.

![Electron](https://img.shields.io/badge/Electron-34-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

![Neural Deck](screenshot.png)

## Features

- **Streaming chat** — real-time token streaming with stop/cancel support
- **Vision model detection** — 👁 icon in the model dropdown for models with image capabilities
- **Image & file attachments** — attach images (base64 for vision models) or text files to your prompts
- **Performance stats** — tokens/sec and token count displayed on every response
- **Configurable parameters** — temperature, max tokens, context length, chunk size, system prompt
- **Agent naming** — customize the assistant's display name
- **Auto-persistence** — settings saved automatically to a local config file
- **Terminal aesthetic** — monospace font, green accent, scanline overlay, dark theme

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally (or on a reachable server)

## Quick Start

```bash
# Clone / copy the project
git clone <repo-url> neural-deck
cd neural-deck

# Install dependencies
npm install

# Launch
npm start
```

The app will auto-connect to `http://localhost:11434` and fetch available models on startup.

## Usage

1. **Connect** — enter your Ollama server URL in the top bar and click the refresh button
2. **Select a model** — pick from the dropdown (👁 = vision-capable)
3. **Chat** — type a message and press Enter or click Send
4. **Attach files** — use the 📷 (image) or 📎 (file) buttons next to the input
5. **Tune parameters** — open the settings sidebar with the gear icon

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |

## Project Structure

```
neural-deck/
├── main.js          # Electron main process (window, IPC handlers, file dialogs)
├── preload.js       # Bridge between main & renderer (Ollama API calls)
├── renderer.js      # Frontend logic (chat, markdown, attachments, settings)
├── index.html       # App layout & structure
├── styles.css       # Terminal-themed styling
├── ndlogo.jpg       # App logo
└── package.json
```

## Configuration

Settings are auto-saved to `<userData>/config.json` and restored on launch:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://localhost:11434` | Ollama API endpoint |
| Temperature | `0.7` | Sampling temperature (0 = precise, 2 = creative) |
| Max Tokens | `2048` | Maximum tokens to generate |
| Context Length | `4096` | Context window size (`num_ctx`) |
| Chunk Size | `512` | Prompt batch size (`num_batch`) |
| Stream | `true` | Stream tokens in real-time |
| Agent Name | `Assistant` | Display name for the AI |
| System Prompt | *(empty)* | System message prepended to conversations |

## API

The client communicates with Ollama via its REST API:

- `GET /api/tags` — list models (with vision detection via `details.families`)
- `POST /api/chat` — chat completion (streaming or non-streaming)

## License

MIT
