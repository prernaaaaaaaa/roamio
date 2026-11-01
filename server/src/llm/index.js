import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import { LLMClient } from './client.js';
import { createLimiter } from './limiter.js';
import { DailyBudget } from './stats.js';

/** Build the LLM client for the current configuration. */
export function createLLM(config) {
  const c = config.llm;
  const provider =
    c.provider === 'gemini'
      ? new GeminiProvider({
          apiKey: c.apiKey,
          model: c.model,
          fallbackModel: c.fallbackModel,
          embedModel: c.embedModel,
          timeoutMs: c.timeoutMs,
          temperature: c.temperature,
          thinkingLevel: c.thinkingLevel,
        })
      : new MockProvider({ latencyMs: c.mockLatencyMs, faultRate: c.mockFaultRate });

  const limiter = createLimiter({ concurrency: c.concurrency, rpm: c.rpm });
  const dailyBudget = new DailyBudget(c.maxCallsPerDay);
  return new LLMClient({
    provider,
    limiter,
    dailyBudget,
    maxRetries: c.maxRetries,
    backoffBaseMs: c.provider === 'mock' ? 5 : 600,
  });
}

export { RunStats } from './stats.js';
export { generateStructured } from './structured.js';
