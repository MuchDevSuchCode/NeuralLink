/* ================================================================
   Neural Deck — Renderer (frontend logic)
   ================================================================ */

// ── DOM refs ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const serverUrl = $('#server-url');
const modelSelect = $('#model-select');
const btnRefresh = $('#btn-refresh');
const btnSettings = $('#btn-toggle-settings');
const sidebar = $('#sidebar');
const tempSlider = $('#temperature');
const tempValue = $('#temp-value');
const maxTokensEl = $('#max-tokens');
const ctxLengthEl = $('#context-length');
const streamToggle = $('#stream-toggle');
const chunkSizeEl = $('#chunk-size');
const agentNameEl = $('#agent-name');
const systemPrompt = $('#system-prompt');
const messagesEl = $('#messages');
const userInput = $('#user-input');
const btnSend = $('#btn-send');
const btnStop = $('#btn-stop');
const btnClear = $('#btn-clear');
const btnAttachImage = $('#btn-attach-image');
const btnAttachFile = $('#btn-attach-file');
const attachPreview = $('#attachments-preview');
const statusText = $('#status-text');
const statusBar = $('#status-bar');

// ── State ───────────────────────────────────────────────────────
let chatHistory = []; // { role, content, images? }
let isGenerating = false;
let pendingImages = []; // { name, base64 }
let pendingFiles = [];  // { name, content }

// ── Simple markdown renderer ────────────────────────────────────
function renderMarkdown(text) {
    let html = text;

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const escaped = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<pre><code class="language-${lang}">${escaped}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Collapse adjacent </ul><ul>
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr/>');

    // Paragraphs: wrap non-tag lines
    html = html
        .split('\n\n')
        .map((block) => {
            const trimmed = block.trim();
            if (!trimmed) return '';
            if (/^<[a-z]/.test(trimmed)) return trimmed;
            return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
        })
        .join('\n');

    return html;
}

// ── Helpers ─────────────────────────────────────────────────────
function setStatus(text, connected = false) {
    statusText.textContent = text;
    statusBar.classList.toggle('connected', connected);
}

function showError(msg) {
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

function clearWelcome() {
    const welcome = messagesEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();
}

function addMessageBubble(role, content, duration, images, files) {
    clearWelcome();
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;

    const nameLabel = document.createElement('span');
    nameLabel.className = 'message-name';
    nameLabel.textContent = role === 'user' ? 'You' : agentNameEl.value || 'Assistant';
    wrapper.appendChild(nameLabel);

    const div = document.createElement('div');
    div.className = `message ${role}`;

    // Show inline images for user messages with attachments
    if (role === 'user' && images && images.length > 0) {
        const imgContainer = document.createElement('div');
        imgContainer.className = 'message-images';
        images.forEach((img) => {
            const imgEl = document.createElement('img');
            imgEl.src = `data:image/png;base64,${img.base64}`;
            imgEl.alt = img.name;
            imgEl.title = img.name;
            imgContainer.appendChild(imgEl);
        });
        div.appendChild(imgContainer);
    }

    // Show inline file attachment chips for user messages
    if (role === 'user' && files && files.length > 0) {
        const fileContainer = document.createElement('div');
        fileContainer.className = 'message-files';
        files.forEach((f) => {
            const chip = document.createElement('span');
            chip.className = 'message-file-chip';
            chip.textContent = `📎 ${f.name}`;
            chip.title = f.name;
            fileContainer.appendChild(chip);
        });
        div.appendChild(fileContainer);
    }

    if (role === 'assistant') {
        div.innerHTML = renderMarkdown(content);
    } else {
        const textNode = document.createElement('span');
        textNode.textContent = content;
        div.appendChild(textNode);
    }
    wrapper.appendChild(div);

    const meta = document.createElement('span');
    meta.className = 'message-meta';
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let metaText = timeStr;
    if (duration !== undefined && role === 'assistant') {
        metaText += ` · ${formatDuration(duration)}`;
    }
    meta.textContent = metaText;
    wrapper.appendChild(meta);

    messagesEl.appendChild(wrapper);
    scrollToBottom();
    return div;
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
}

function setGenerating(val) {
    isGenerating = val;
    btnSend.classList.toggle('hidden', val);
    btnStop.classList.toggle('hidden', !val);
    userInput.disabled = val;
}

// ── Auto-resize textarea ────────────────────────────────────────
userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
});

// ── Temperature slider ──────────────────────────────────────────
tempSlider.addEventListener('input', () => {
    tempValue.textContent = parseFloat(tempSlider.value).toFixed(2);
});

// ── Toggle settings ─────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
    sidebar.classList.toggle('open');
});

// ── Populate model dropdown ─────────────────────────────────────
function populateModels(models) {
    modelSelect.innerHTML = '';
    if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models found</option>';
        return;
    }
    models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.vision ? `👁 ${m.name}` : m.name;
        modelSelect.appendChild(opt);
    });
}

// ── Refresh models ──────────────────────────────────────────────
btnRefresh.addEventListener('click', async () => {
    const base = serverUrl.value.replace(/\/+$/, '');
    btnRefresh.classList.add('spinning');
    setStatus('Fetching models…');

    try {
        const models = await window.ollama.fetchModels(base);
        populateModels(models);
        if (models.length === 0) {
            setStatus('No models found');
            return;
        }
        setStatus(`Connected — ${models.length} model(s)`, true);
    } catch (err) {
        showError(`Connection failed: ${err.message}`);
        setStatus('Connection failed');
    } finally {
        btnRefresh.classList.remove('spinning');
    }
});

// ── Send message ────────────────────────────────────────────────
async function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isGenerating) return;

    const model = modelSelect.value;
    if (!model) {
        showError('Please select a model first.');
        return;
    }

    // Gather attachments
    const images = [...pendingImages];
    const files = [...pendingFiles];
    clearAttachments();

    // Build full user content (append file contents if any)
    let fullContent = text;
    if (files.length > 0) {
        const fileBlock = files.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n');
        fullContent += '\n\n' + fileBlock;
    }

    // Add user message
    const userMsg = { role: 'user', content: fullContent };
    if (images.length > 0) {
        userMsg.images = images.map((img) => img.base64);
    }
    chatHistory.push(userMsg);
    addMessageBubble('user', text, undefined, images, files);
    userInput.value = '';
    userInput.style.height = 'auto';

    // Build messages array
    const messages = [];
    const sysPrompt = systemPrompt.value.trim();
    if (sysPrompt) {
        messages.push({ role: 'system', content: sysPrompt });
    }
    messages.push(...chatHistory);

    // Build options
    const options = {};
    const temp = parseFloat(tempSlider.value);
    if (!isNaN(temp)) options.temperature = temp;

    const maxTok = parseInt(maxTokensEl.value, 10);
    if (!isNaN(maxTok) && maxTok > 0) options.num_predict = maxTok;

    const ctxLen = parseInt(ctxLengthEl.value, 10);
    if (!isNaN(ctxLen) && ctxLen > 0) options.num_ctx = ctxLen;

    const chunkSize = parseInt(chunkSizeEl.value, 10);
    if (!isNaN(chunkSize) && chunkSize > 0) options.num_batch = chunkSize;

    const useStream = streamToggle.checked;

    const payload = { model, messages, options, stream: useStream };
    const base = serverUrl.value.replace(/\/+$/, '');

    // Create assistant bubble with typing indicator
    clearWelcome();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper assistant';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'message-name';
    nameLabel.textContent = agentNameEl.value || 'Assistant';
    wrapper.appendChild(nameLabel);

    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant';
    assistantDiv.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    wrapper.appendChild(assistantDiv);

    messagesEl.appendChild(wrapper);
    scrollToBottom();

    setGenerating(true);
    setStatus('Generating…', true);

    let fullResponse = '';
    const startTime = Date.now();

    try {
        const stats = await window.ollama.chat(base, payload, useStream, (token) => {
            if (!fullResponse) {
                assistantDiv.innerHTML = ''; // remove typing indicator
            }
            fullResponse += token;
            assistantDiv.innerHTML = renderMarkdown(fullResponse);
            scrollToBottom();
        });

        chatHistory.push({ role: 'assistant', content: fullResponse });
        const elapsed = Date.now() - startTime;

        // Calculate tokens/sec from Ollama stats
        let tokensPerSec = null;
        if (stats && stats.eval_count && stats.eval_duration) {
            // eval_duration is in nanoseconds
            tokensPerSec = (stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1);
        }

        // Add meta line under the bubble
        const meta = document.createElement('span');
        meta.className = 'message-meta';
        const now = new Date();
        let metaText = `${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${formatDuration(elapsed)}`;
        if (tokensPerSec) {
            metaText += ` · ${tokensPerSec} tok/s`;
            if (stats.eval_count) metaText += ` (${stats.eval_count} tokens)`;
        }
        meta.textContent = metaText;
        wrapper.appendChild(meta);

        let statusText = `Ready — last response ${formatDuration(elapsed)}`;
        if (tokensPerSec) statusText += ` · ${tokensPerSec} tok/s`;
        setStatus(statusText, true);
    } catch (err) {
        const errStr = String(err.message || err).toLowerCase();
        if (err.name === 'AbortError' || errStr.includes('aborterror') || errStr.includes('abort')) {
            // User cancelled — no error toast
            if (fullResponse) {
                chatHistory.push({ role: 'assistant', content: fullResponse });
            }
            setStatus('Request cancelled', true);
        } else {
            showError(`Error: ${err.message || 'Unknown error'}`);
            setStatus('Error', true);
            // Remove the broken assistant bubble if empty
            if (!fullResponse) assistantDiv.remove();
        }
    } finally {
        setGenerating(false);
    }
}

btnSend.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// ── Stop generation ─────────────────────────────────────────────
btnStop.addEventListener('click', () => {
    window.ollama.cancelRequest();
});

// ── Attachment handlers ─────────────────────────────────────────
function renderAttachmentPreviews() {
    attachPreview.innerHTML = '';
    const all = [
        ...pendingImages.map((img, i) => ({ type: 'image', index: i, ...img })),
        ...pendingFiles.map((f, i) => ({ type: 'file', index: i, ...f })),
    ];
    if (all.length === 0) {
        attachPreview.classList.add('hidden');
        return;
    }
    attachPreview.classList.remove('hidden');

    all.forEach((item) => {
        const chip = document.createElement('div');
        chip.className = `attachment-chip${item.type === 'image' ? ' image-chip' : ''}`;

        if (item.type === 'image') {
            const img = document.createElement('img');
            img.src = `data:image/png;base64,${item.base64}`;
            img.alt = item.name;
            chip.appendChild(img);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'chip-name';
        nameSpan.textContent = item.name;
        chip.appendChild(nameSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'chip-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
            if (item.type === 'image') {
                pendingImages.splice(item.index, 1);
            } else {
                pendingFiles.splice(item.index, 1);
            }
            renderAttachmentPreviews();
        });
        chip.appendChild(removeBtn);

        attachPreview.appendChild(chip);
    });
}

function clearAttachments() {
    pendingImages = [];
    pendingFiles = [];
    renderAttachmentPreviews();
}

btnAttachImage.addEventListener('click', async () => {
    const images = await window.ollama.pickImage();
    if (images.length > 0) {
        pendingImages.push(...images);
        renderAttachmentPreviews();
    }
});

btnAttachFile.addEventListener('click', async () => {
    const files = await window.ollama.pickFile();
    if (files.length > 0) {
        pendingFiles.push(...files);
        renderAttachmentPreviews();
    }
});

// ── Clear chat ──────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
    chatHistory = [];
    messagesEl.innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">
        <img src="ndlogo.png" alt="Neural Deck" />
      </div>
      <h2>Welcome to Neural Deck</h2>
      <p>Connect to your Ollama server, pick a model, and start chatting.</p>
    </div>`;
    setStatus('Chat cleared', statusBar.classList.contains('connected'));
});
// ── Config persistence ──────────────────────────────────────────
function gatherSettings() {
    return {
        serverUrl: serverUrl.value,
        model: modelSelect.value,
        temperature: tempSlider.value,
        maxTokens: maxTokensEl.value,
        contextLength: ctxLengthEl.value,
        stream: streamToggle.checked,
        chunkSize: chunkSizeEl.value,
        agentName: agentNameEl.value,
        systemPrompt: systemPrompt.value,
    };
}

let saveTimeout = null;
function autoSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        window.ollama.saveConfig(gatherSettings());
    }, 500);
}

// Listen for changes on all settings controls
[serverUrl, maxTokensEl, ctxLengthEl, chunkSizeEl, agentNameEl, systemPrompt].forEach((el) => {
    el.addEventListener('input', autoSave);
});
tempSlider.addEventListener('input', autoSave);
streamToggle.addEventListener('change', autoSave);
modelSelect.addEventListener('change', autoSave);

// ── Load config & auto-connect on start ─────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    const cfg = await window.ollama.loadConfig();

    if (cfg.serverUrl) serverUrl.value = cfg.serverUrl;
    if (cfg.temperature) {
        tempSlider.value = cfg.temperature;
        tempValue.textContent = parseFloat(cfg.temperature).toFixed(2);
    }
    if (cfg.maxTokens) maxTokensEl.value = cfg.maxTokens;
    if (cfg.contextLength) ctxLengthEl.value = cfg.contextLength;
    if (cfg.chunkSize) chunkSizeEl.value = cfg.chunkSize;
    if (cfg.agentName) agentNameEl.value = cfg.agentName;
    if (cfg.systemPrompt) systemPrompt.value = cfg.systemPrompt;
    if (cfg.stream !== undefined) streamToggle.checked = cfg.stream;

    // Fetch models, then restore saved model selection
    const base = serverUrl.value.replace(/\/+$/, '');
    btnRefresh.classList.add('spinning');
    setStatus('Fetching models…');

    try {
        const models = await window.ollama.fetchModels(base);
        populateModels(models);
        // Restore saved model if available
        if (cfg.model && models.some((m) => m.name === cfg.model)) {
            modelSelect.value = cfg.model;
        }
        setStatus(`Connected — ${models.length} model(s)`, true);
    } catch (err) {
        showError(`Connection failed: ${err.message}`);
        setStatus('Connection failed');
    } finally {
        btnRefresh.classList.remove('spinning');
    }

    // Show config path in console for reference
    const cfgPath = await window.ollama.getConfigPath();
    console.log(`Config file: ${cfgPath}`);
});
