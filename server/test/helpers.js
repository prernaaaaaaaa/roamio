import { loadConfig } from '../src/config.js';
import { loadKnowledgeBase } from '../src/kb/loader.js';
import { Retriever } from '../src/kb/retriever.js';
import { LLMClient } from '../src/llm/client.js';
import { createLimiter } from '../src/llm/limiter.js';
import { DailyBudget } from '../src/llm/stats.js';
import { MockProvider } from '../src/llm/mock.js';
import { createPlanner } from '../src/planner/pipeline.js';
import { TTLCache } from '../src/cache.js';
import { MemoryStore } from '../src/store/memory.js';
import { createApp } from '../src/app.js';

export const quiet = { warn() {}, error() {}, log() {} };

export const kb = loadKnowledgeBase();
export const retriever = await new Retriever({ kb, logger: quiet }).init();

export function testConfig(extra = {}) {
  return loadConfig({ LLM_PROVIDER: 'mock', NODE_ENV: 'test', LLM_MAX_CALLS_PER_DAY: '0', RATE_PLAN_PER_MIN: '1000', RATE_PLAN_PER_DAY: '1000', RATE_AUTH_PER_MIN: '1000', ...extra });
}

export function makeClient(provider, { maxRetries = 2, daily = 0 } = {}) {
  return new LLMClient({ provider, limiter: createLimiter({ concurrency: 4 }), dailyBudget: new DailyBudget(daily), maxRetries, backoffBaseMs: 1 });
}

/** A provider whose behaviour is scripted per call: fn(req, callNumber) -> text | throws. */
export class ScriptedProvider {
  constructor(fn) {
    this.name = 'scripted';
    this.model = 'scripted-1';
    this.fn = fn;
    this.calls = 0;
  }
  async generateOnce(req) {
    const text = await this.fn(req, ++this.calls);
    return { text, usage: { inputTokens: 10, outputTokens: 10 }, toolCalls: [] };
  }
  async embed(texts) { return texts.map(() => [0]); }
}

export function makePlanner({ provider = new MockProvider({ faultRate: 0 }), config = testConfig(), cache = new TTLCache(), fetchImpl } = {}) {
  const llm = makeClient(provider);
  return { planner: createPlanner({ kb, retriever, llm, config, cache, fetchImpl }), llm, cache, config };
}

export async function startServer({ provider = new MockProvider({ faultRate: 0 }), config = testConfig() } = {}) {
  const llm = makeClient(provider);
  const store = new MemoryStore();
  const cache = new TTLCache();
  const planner = createPlanner({ kb, retriever, llm, config, cache });
  const app = createApp({ config, kb, retriever, llm, planner, store, cache, logger: quiet });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, close: () => new Promise((r) => server.close(r)) };
}

/** Parse a Server-Sent Events body into [{event, data}]. */
export function parseSse(text) {
  return text.split('\n\n').filter((b) => b.includes('event:')).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { event, data };
  });
}

export const baseRequest = { destination: 'Jaipur', days: 3, travelers: 2, budget: 60000, interests: ['heritage'] };
