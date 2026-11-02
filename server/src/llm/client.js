import { LLMError, isAbort } from './errors.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });

/**
 * LLMClient wraps a provider with everything that is not provider-specific:
 *  - per-request call cap and process-wide daily cap (cost / abuse control)
 *  - concurrency + RPM limiting
 *  - retries with exponential backoff, jitter and server-suggested delays
 *  - per-call latency and token accounting
 */
export class LLMClient {
  constructor({ provider, limiter, dailyBudget, maxRetries = 3, backoffBaseMs = 600 }) {
    this.provider = provider;
    this.limiter = limiter;
    this.dailyBudget = dailyBudget;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
  }

  get info() {
    return { provider: this.provider.name, model: this.provider.model };
  }

  /** True when the daily allowance is spent (callers can degrade to the deterministic planner). */
  get exhausted() {
    return this.dailyBudget?.exhausted() ?? false;
  }

  /**
   * @param {object} req provider request (task, system, prompt, json, tools, handlers, mock...)
   * @param {{stats?:import('./stats.js').RunStats, signal?:AbortSignal}} [ctx]
   */
  async generate(req, { stats, signal } = {}) {
    stats?.reserve();
    if (this.dailyBudget && !this.dailyBudget.consume()) {
      throw new LLMError('Daily model-call allowance is spent', { code: 'daily_budget' });
    }
    const t0 = Date.now();
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.limiter.run(() => this.provider.generateOnce(req, { signal }), { signal });
        stats?.record(req.task || 'generate', { usage: res.usage, ms: Date.now() - t0, retries });
        for (const tc of res.toolCalls || []) stats?.toolCalls.push(tc);
        return res;
      } catch (err) {
        if (isAbort(err) || signal?.aborted) throw err;
        if (!(err instanceof LLMError) || !err.retryable || attempt >= this.maxRetries) throw err;
        // Interactive requests must not sit through a long quota wait: fall back to the built-in planner instead.
        if (err.code === 'rate_limited' && err.retryAfterMs > 12_000) throw err;
        retries++;
        const backoff = this.backoffBaseMs * 2 ** attempt;
        const wait = Math.min(30_000, Math.max(err.retryAfterMs || 0, backoff) + Math.random() * 250);
        await sleep(wait, signal);
      }
    }
  }

  embed(texts, opts) {
    return this.limiter.run(() => this.provider.embed(texts, opts), opts);
  }
}
