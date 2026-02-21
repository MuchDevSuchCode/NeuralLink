const { contextBridge, ipcRenderer } = require('electron');

let abortController = null;

contextBridge.exposeInMainWorld('ollama', {
    /**
     * Fetch the list of locally available models.
     * @param {string} baseUrl - e.g. "http://localhost:11434"
     * @param {string} provider - 'ollama' or 'lmstudio'
     * @returns {Promise<{name: string, vision: boolean, tools: boolean}[]>} model info
     */
    async fetchModels(baseUrl, provider = 'ollama') {
        if (provider === 'lmstudio') {
            // LM Studio uses OpenAI-compatible /v1/models
            const res = await fetch(`${baseUrl}/v1/models`);
            if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
            const data = await res.json();
            return (data.data || []).map((m) => ({
                name: m.id,
                vision: false, // LM Studio doesn't expose this in /v1/models
                tools: false,
            }));
        }

        // Ollama: /api/tags + /api/show for capability detection
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
        const data = await res.json();
        const models = (data.models || []).map((m) => ({
            name: m.name,
            vision: !!(m.details && m.details.families && m.details.families.includes('clip')),
            tools: false,
        }));

        // Detect tool-calling support via /api/show (check template for tool tokens)
        await Promise.all(models.map(async (m) => {
            try {
                const showRes = await fetch(`${baseUrl}/api/show`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: m.name }),
                });
                if (showRes.ok) {
                    const info = await showRes.json();
                    const tmpl = (info.template || '').toLowerCase();
                    if (tmpl.includes('tool') || tmpl.includes('function') || tmpl.includes('<|plugin|>')) {
                        m.tools = true;
                    }
                }
            } catch {
                // skip — can't determine tool support
            }
        }));

        return models;
    },

    /**
     * Send a chat completion (streaming or non-streaming).
     * @param {string} baseUrl
     * @param {object} payload  - { model, messages, options, stream, tools? }
     * @param {boolean} useStream - whether to stream tokens
     * @param {function} onToken - called with each token string
     * @param {string} provider - 'ollama' or 'lmstudio'
     * @returns {Promise<object>} stats + optional toolCalls
     */
    async chat(baseUrl, payload, useStream, onToken, provider = 'ollama') {
        abortController = new AbortController();

        if (provider === 'lmstudio') {
            return this._chatOpenAI(baseUrl, payload, useStream, onToken);
        }
        return this._chatOllama(baseUrl, payload, useStream, onToken);
    },

    // ── Ollama native API ────────────────────────────────────────
    async _chatOllama(baseUrl, payload, useStream, onToken) {
        try {
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, stream: useStream }),
                signal: abortController.signal,
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Ollama error ${res.status}: ${text}`);
            }

            if (!useStream) {
                const data = await res.json();
                if (data.message && data.message.content) {
                    onToken(data.message.content);
                }
                abortController = null;
                return {
                    eval_count: data.eval_count,
                    eval_duration: data.eval_duration,
                    prompt_eval_count: data.prompt_eval_count,
                    prompt_eval_duration: data.prompt_eval_duration,
                    toolCalls: data.message && data.message.tool_calls ? data.message.tool_calls : null,
                };
            }

            // Streaming mode — Ollama uses newline-delimited JSON
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let stats = {};
            let toolCalls = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const obj = JSON.parse(line);
                        if (obj.message && obj.message.content) {
                            onToken(obj.message.content);
                        }
                        if (obj.message && obj.message.tool_calls) {
                            toolCalls = obj.message.tool_calls;
                        }
                        if (obj.done && obj.eval_count) {
                            stats = {
                                eval_count: obj.eval_count,
                                eval_duration: obj.eval_duration,
                                prompt_eval_count: obj.prompt_eval_count,
                                prompt_eval_duration: obj.prompt_eval_duration,
                            };
                        }
                    } catch {
                        // skip malformed lines
                    }
                }
            }

            if (buffer.trim()) {
                try {
                    const obj = JSON.parse(buffer);
                    if (obj.message && obj.message.content) {
                        onToken(obj.message.content);
                    }
                    if (obj.message && obj.message.tool_calls) {
                        toolCalls = obj.message.tool_calls;
                    }
                    if (obj.done && obj.eval_count) {
                        stats = {
                            eval_count: obj.eval_count,
                            eval_duration: obj.eval_duration,
                            prompt_eval_count: obj.prompt_eval_count,
                            prompt_eval_duration: obj.prompt_eval_duration,
                        };
                    }
                } catch {
                    // skip
                }
            }

            abortController = null;
            return { ...stats, toolCalls };
        } catch (err) {
            abortController = null;
            if (err.name === 'AbortError') {
                throw new Error('AbortError');
            }
            throw err;
        }
    },

    // ── LM Studio / OpenAI-compatible API ────────────────────────
    async _chatOpenAI(baseUrl, payload, useStream, onToken) {
        try {
            // Convert Ollama payload to OpenAI format
            const openaiPayload = {
                model: payload.model,
                messages: payload.messages,
                stream: useStream,
            };
            if (payload.options) {
                if (payload.options.temperature !== undefined) openaiPayload.temperature = payload.options.temperature;
                if (payload.options.num_predict !== undefined) openaiPayload.max_tokens = payload.options.num_predict;
            }
            if (payload.tools) {
                openaiPayload.tools = payload.tools;
            }

            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(openaiPayload),
                signal: abortController.signal,
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`LM Studio error ${res.status}: ${text}`);
            }

            if (!useStream) {
                const data = await res.json();
                const choice = data.choices && data.choices[0];
                if (choice && choice.message && choice.message.content) {
                    onToken(choice.message.content);
                }
                const usage = data.usage || {};
                abortController = null;
                return {
                    eval_count: usage.completion_tokens || null,
                    // Convert to nanoseconds to match Ollama format for tok/s calculation
                    eval_duration: null,
                    prompt_eval_count: usage.prompt_tokens || null,
                    prompt_eval_duration: null,
                    toolCalls: choice && choice.message && choice.message.tool_calls
                        ? choice.message.tool_calls : null,
                };
            }

            // Streaming mode — OpenAI uses SSE (data: {...}\n\n)
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let tokenCount = 0;
            let toolCalls = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    try {
                        const obj = JSON.parse(trimmed.slice(6));
                        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
                        if (delta && delta.content) {
                            onToken(delta.content);
                            tokenCount++;
                        }
                        if (delta && delta.tool_calls) {
                            // Accumulate tool calls from streaming deltas
                            if (!toolCalls) toolCalls = [];
                            for (const tc of delta.tool_calls) {
                                if (tc.index !== undefined) {
                                    while (toolCalls.length <= tc.index) toolCalls.push({ function: { name: '', arguments: '' } });
                                    if (tc.function) {
                                        if (tc.function.name) toolCalls[tc.index].function.name = tc.function.name;
                                        if (tc.function.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                                    }
                                    if (tc.id) toolCalls[tc.index].id = tc.id;
                                    if (tc.type) toolCalls[tc.index].type = tc.type;
                                }
                            }
                        }
                    } catch {
                        // skip malformed SSE
                    }
                }
            }

            // Parse accumulated tool call arguments from strings to objects
            if (toolCalls) {
                toolCalls = toolCalls.map((tc) => {
                    try {
                        return {
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string'
                                    ? JSON.parse(tc.function.arguments)
                                    : tc.function.arguments,
                            },
                        };
                    } catch {
                        return tc;
                    }
                });
            }

            abortController = null;
            return {
                eval_count: tokenCount || null,
                eval_duration: null,
                prompt_eval_count: null,
                prompt_eval_duration: null,
                toolCalls,
            };
        } catch (err) {
            abortController = null;
            if (err.name === 'AbortError') {
                throw new Error('AbortError');
            }
            throw err;
        }
    },

    /**
     * Cancel an in-flight chat request.
     */
    cancelRequest() {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    },

    // ── Config persistence ────────────────────────────────────────
    loadConfig: () => ipcRenderer.invoke('config:load'),
    saveConfig: (data) => ipcRenderer.invoke('config:save', data),
    getConfigPath: () => ipcRenderer.invoke('config:path'),

    // ── File pickers ─────────────────────────────────────────────
    pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
    pickFile: () => ipcRenderer.invoke('dialog:pickFile'),

    // ── Chat history persistence ─────────────────────────────────
    saveHistory: (messages, encrypt, key) => ipcRenderer.invoke('history:save', messages, encrypt, key),
    loadHistory: (encrypt, key) => ipcRenderer.invoke('history:load', encrypt, key),
    clearHistory: () => ipcRenderer.invoke('history:clear'),

    // ── Web tools ────────────────────────────────────────────────
    webWeather: (city) => ipcRenderer.invoke('web:weather', city),
    webTime: (location) => ipcRenderer.invoke('web:time', location),
    webIP: (address) => ipcRenderer.invoke('web:ip', address),
    webSearch: (query) => ipcRenderer.invoke('web:search', query),

    // ── SSH connections ──────────────────────────────────────────
    sshConnect: (host, user, key) => ipcRenderer.invoke('ssh:connect', host, user, key),
});
