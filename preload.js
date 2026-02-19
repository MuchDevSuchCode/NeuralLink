const { contextBridge, ipcRenderer } = require('electron');

let abortController = null;

contextBridge.exposeInMainWorld('ollama', {
    /**
     * Fetch the list of locally available models.
     * @param {string} baseUrl - e.g. "http://localhost:11434"
     * @returns {Promise<{name: string, vision: boolean}[]>} model info
     */
    async fetchModels(baseUrl) {
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
        const data = await res.json();
        return (data.models || []).map((m) => ({
            name: m.name,
            vision: !!(m.details && m.details.families && m.details.families.includes('clip')),
        }));
    },

    /**
     * Send a chat completion (streaming or non-streaming).
     * @param {string} baseUrl
     * @param {object} payload  - { model, messages, options, stream }
     * @param {boolean} useStream - whether to stream tokens
     * @param {function} onToken - called with each token string
     * @returns {Promise<void>}
     */
    async chat(baseUrl, payload, useStream, onToken) {
        abortController = new AbortController();
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
                // Non-streaming: wait for full response
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
                };
            }

            // Streaming mode
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let stats = {};

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
                        // Capture stats from the final chunk (done: true)
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
            return stats;
        } catch (err) {
            abortController = null;
            // Re-throw abort as a plain Error so it survives contextBridge serialization
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
});
