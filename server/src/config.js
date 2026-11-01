import crypto from 'node:crypto';

// Load .env if present (Node >= 20.12). Safe no-op when the file is missing.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
};

/**
 * Build the runtime configuration from an environment object.
 * Taking `env` as a parameter keeps this testable.
 */
export function loadConfig(env = process.env) {
  const hasKey = Boolean(env.GEMINI_API_KEY);
  const provider = (env.LLM_PROVIDER || (hasKey ? 'gemini' : 'mock')).toLowerCase();
  const nodeEnv = env.NODE_ENV || 'development';

  if (provider === 'gemini' && !hasKey) {
    throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY to be set.');
  }
  if (nodeEnv === 'production' && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production.');
  }

  return {
    nodeEnv,
    port: int(env.PORT, 8080),
    clientOrigins: (env.CLIENT_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    jwtSecret: env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
    mongoUri: env.MONGODB_URI || '',
    // Serve the built React app from this server (single-service deploys).
    serveClient: env.SERVE_CLIENT !== 'false',
    trustProxy: int(env.TRUST_PROXY, 1),
    llm: {
      provider,
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      // Used automatically if the primary model id is not available to this API key (HTTP 404).
      fallbackModel: env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
      // Optional: MINIMAL | LOW | MEDIUM | HIGH. Lower thinking = lower latency and cost.
      thinkingLevel: (env.LLM_THINKING_LEVEL || '').toUpperCase(),
      embedModel: env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
      timeoutMs: int(env.LLM_TIMEOUT_MS, 60_000),
      maxRetries: int(env.LLM_MAX_RETRIES, 3),
      concurrency: int(env.LLM_CONCURRENCY, 6),
      // Requests per minute the planner may issue (0 = unlimited). Set to your tier's limit.
      rpm: int(env.LLM_RPM, 0),
      maxCallsPerRequest: int(env.LLM_MAX_CALLS_PER_REQUEST, 60),
      // Extra attempts after a first draft fails validation (repair prompts).
      maxRepairs: int(env.LLM_MAX_REPAIRS, 2),
      maxCallsPerDay: int(env.LLM_MAX_CALLS_PER_DAY, 1500),
      temperature: num(env.LLM_TEMPERATURE, 0.4),
      // Optional pricing (USD per 1M tokens) to report an estimated cost per plan.
      priceInPerM: num(env.LLM_PRICE_IN_PER_M, 0),
      priceOutPerM: num(env.LLM_PRICE_OUT_PER_M, 0),
      // Mock-provider knobs (tests, demos, CI).
      mockLatencyMs: int(env.MOCK_LATENCY_MS, 0),
      mockFaultRate: num(env.MOCK_FAULT_RATE, 0),
    },
    cache: {
      max: int(env.CACHE_MAX, 200),
      ttlMs: int(env.CACHE_TTL_MS, 6 * 60 * 60 * 1000),
    },
    rate: {
      planPerMin: int(env.RATE_PLAN_PER_MIN, 6),
      planPerDay: int(env.RATE_PLAN_PER_DAY, 30),
      authPerMin: int(env.RATE_AUTH_PER_MIN, 15),
      generalPerMin: int(env.RATE_GENERAL_PER_MIN, 120),
    },
  };
}
