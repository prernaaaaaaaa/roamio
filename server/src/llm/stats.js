import { LLMError } from './errors.js';

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

/** Per-request accounting: calls, tokens, latency, validation outcomes, tool calls. */
export class RunStats {
  constructor({ maxCalls = 60, priceInPerM = 0, priceOutPerM = 0 } = {}) {
    this.maxCalls = maxCalls;
    this.priceInPerM = priceInPerM;
    this.priceOutPerM = priceOutPerM;
    this.startedAt = Date.now();
    this.calls = 0;
    this.retries = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.latencies = [];
    this.byTask = {};
    this.toolCalls = [];
    this.validation = { firstPass: 0, repaired: 0, sanitized: 0, fallback: 0, total: 0, repairAttempts: 0 };
    this.firstVariantMs = null;
    this.warnings = [];
  }

  /** Called before every model call. Enforces the per-request cap. */
  reserve() {
    if (this.calls >= this.maxCalls) {
      throw new LLMError(`Per-request model call limit (${this.maxCalls}) reached`, { code: 'call_cap' });
    }
    this.calls++;
  }

  record(task, { usage = {}, ms = 0, retries = 0 } = {}) {
    this.retries += retries;
    this.inputTokens += usage.inputTokens || 0;
    this.outputTokens += usage.outputTokens || 0;
    this.latencies.push(ms);
    const t = (this.byTask[task] ||= { calls: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
    t.calls++;
    t.ms += ms;
    t.inputTokens += usage.inputTokens || 0;
    t.outputTokens += usage.outputTokens || 0;
  }

  /** outcome: 'firstPass' | 'repaired' | 'sanitized' | 'fallback' */
  outcome(outcome, repairAttempts = 0) {
    this.validation.total++;
    this.validation[outcome]++;
    this.validation.repairAttempts += repairAttempts;
  }

  markFirstVariant() {
    if (this.firstVariantMs == null) this.firstVariantMs = Date.now() - this.startedAt;
  }

  estimatedCostUSD() {
    return (this.inputTokens * this.priceInPerM + this.outputTokens * this.priceOutPerM) / 1e6;
  }

  summary() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const v = this.validation;
    return {
      totalMs: Date.now() - this.startedAt,
      timeToFirstVariantMs: this.firstVariantMs,
      llmCalls: this.calls,
      retries: this.retries,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUSD: Number(this.estimatedCostUSD().toFixed(5)),
      callLatencyMs: { p50: pct(sorted, 50), p95: pct(sorted, 95) },
      byTask: this.byTask,
      validation: v,
      toolCalls: this.toolCalls,
      warnings: this.warnings,
    };
  }
}

/** Process-wide daily ceiling on model calls: protects the API key from abuse. */
export class DailyBudget {
  constructor(maxPerDay) {
    this.max = maxPerDay;
    this.day = '';
    this.used = 0;
  }

  #roll() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  /** @returns {boolean} false when the day's allowance is spent. */
  consume() {
    this.#roll();
    if (this.max > 0 && this.used >= this.max) return false;
    this.used++;
    return true;
  }

  exhausted() {
    this.#roll();
    return this.max > 0 && this.used >= this.max;
  }

  snapshot() {
    this.#roll();
    return { used: this.used, max: this.max, day: this.day };
  }
}
