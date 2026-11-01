import { GoogleGenAI } from '@google/genai';
import { LLMError, isAbort } from './errors.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const EMBED_BATCH = 50;

/** Pull a server-suggested wait out of Gemini's 429 payload ("retryDelay":"23s" / "retry in 23.4s"). */
export function parseRetryDelayMs(message = '') {
  const a = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  const b = /retry in (\d+(?:\.\d+)?)s/i.exec(message);
  const s = a?.[1] ?? b?.[1];
  return s ? Math.ceil(Number(s) * 1000) : 0;
}

/** Map any SDK / network failure onto an LLMError the retry layer understands. */
export function toLLMError(err) {
  if (err instanceof LLMError) return err;
  if (isAbort(err)) return err;
  const message = String(err?.message || err);
  const status = Number(err?.status ?? err?.code);
  if (err?.name === 'TimeoutError') {
    return new LLMError('Model call timed out', { code: 'timeout', retryable: true, cause: err });
  }
  if (RETRYABLE_STATUS.has(status)) {
    return new LLMError(`Gemini API ${status}: ${message.slice(0, 200)}`, {
      code: status === 429 ? 'rate_limited' : 'upstream_error',
      retryable: true,
      retryAfterMs: parseRetryDelayMs(message),
      cause: err,
    });
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return new LLMError(`Network error calling Gemini: ${message.slice(0, 160)}`, { code: 'network', retryable: true, cause: err });
  }
  if (status === 401 || status === 403 || /API key/i.test(message)) {
    return new LLMError('Gemini rejected the API key or the request is not permitted', { code: 'auth', cause: err });
  }
  return new LLMError(`Gemini request failed: ${message.slice(0, 200)}`, { code: 'bad_request', cause: err });
}

/**
 * Gemini provider (Google Gen AI SDK). One call = one attempt; retries, rate limiting and
 * accounting live in LLMClient so the same behaviour applies to every provider.
 */
export class GeminiProvider {
  constructor({ apiKey, model, fallbackModel = '', embedModel, timeoutMs = 45_000, temperature = 0.4, thinkingLevel = '', embedDims = 768 }) {
    this.name = 'gemini';
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.embedModel = embedModel;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.thinkingLevel = thinkingLevel;
    this.embedDims = embedDims;
    this.ai = new GoogleGenAI({ apiKey });
  }

  #signal(signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /**
   * @param {object} req
   * @param {string} req.system
   * @param {string} req.prompt
   * @param {boolean} [req.json] ask for application/json output
   * @param {Array} [req.tools] Gemini function declarations (cannot be combined with json mode)
   * @param {Record<string,(args:object)=>Promise<object>>} [req.handlers]
   * @param {number} [req.maxToolSteps]
   * @returns {Promise<{text:string, usage:{inputTokens:number,outputTokens:number}, toolCalls:Array}>}
   */
  async generateOnce(req, { signal } = {}) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls = [];
    const contents = [{ role: 'user', parts: [{ text: req.prompt }] }];
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const config = {
      systemInstruction: req.system,
      temperature: req.temperature ?? this.temperature,
      maxOutputTokens: req.maxOutputTokens,
      abortSignal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    };
    if (this.thinkingLevel) config.thinkingConfig = { thinkingLevel: this.thinkingLevel };
    const hasTools = Boolean(req.tools?.length);
    if (hasTools) config.tools = [{ functionDeclarations: req.tools }];
    else if (req.json) config.responseMimeType = 'application/json';

    try {
      const maxSteps = req.maxToolSteps ?? 4;
      for (let step = 0; ; step++) {
        const res = await this.ai.models.generateContent({ model: this.model, contents, config });
        usage.inputTokens += res.usageMetadata?.promptTokenCount || 0;
        usage.outputTokens += res.usageMetadata?.candidatesTokenCount || 0;

        const calls = res.functionCalls;
        if (!hasTools || !calls?.length || step >= maxSteps) {
          return { text: res.text ?? '', usage, toolCalls };
        }

        // Echo the model turn back unchanged (preserves thought signatures), then answer each call.
        contents.push(res.candidates[0].content);
        const parts = [];
        for (const call of calls) {
          const t0 = Date.now();
          let result;
          try {
            const handler = req.handlers?.[call.name];
            result = handler ? await handler(call.args || {}) : { error: `Unknown tool ${call.name}` };
          } catch (err) {
            result = { error: String(err?.message || err).slice(0, 200) };
          }
          toolCalls.push({ name: call.name, args: call.args || {}, result, ms: Date.now() - t0, source: 'model' });
          parts.push({ functionResponse: { name: call.name, response: { output: result } } });
        }
        contents.push({ role: 'user', parts });
      }
    } catch (err) {
      // The caller cancelled (browser closed): let the abort through untouched.
      if (signal?.aborted) throw err;
      // Our own timeout can surface as an AbortError or TimeoutError: it is retryable, not a cancellation.
      if (timeoutSignal.aborted || isAbort(err) || err?.name === 'TimeoutError') {
        throw new LLMError(`Model call timed out after ${this.timeoutMs} ms`, { code: 'timeout', retryable: true, cause: err });
      }
      // Model id not available to this key: switch to the fallback model once and retry.
      if (Number(err?.status) === 404 && this.fallbackModel && this.model !== this.fallbackModel) {
        this.model = this.fallbackModel;
        return this.generateOnce(req, { signal });
      }
      throw toLLMError(err);
    }
  }

  /** Embed texts in batches. Returns one vector per input, in order. */
  async embed(texts, { taskType = 'RETRIEVAL_DOCUMENT', signal } = {}) {
    const out = [];
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const res = await this.ai.models.embedContent({
          model: this.embedModel,
          contents: texts.slice(i, i + EMBED_BATCH),
          config: { taskType, outputDimensionality: this.embedDims, abortSignal: this.#signal(signal) },
        });
        const vectors = res.embeddings?.map((e) => e.values) ?? [];
        if (vectors.length !== Math.min(EMBED_BATCH, texts.length - i)) {
          throw new LLMError('Embedding response size mismatch', { code: 'bad_response' });
        }
        out.push(...vectors);
      }
    } catch (err) {
      throw toLLMError(err);
    }
    return out;
  }
}
