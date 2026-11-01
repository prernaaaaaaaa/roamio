import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { PlanError } from '../planner/pipeline.js';

const limitBody = (message) => ({ error: { code: 'rate_limited', message } });

export function createLimiters(config) {
  const make = (windowMs, limit, message) =>
    rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: limitBody(message) });
  return {
    general: make(60_000, config.rate.generalPerMin, 'Too many requests. Please slow down.'),
    auth: make(60_000, config.rate.authPerMin, 'Too many sign-in attempts. Try again in a minute.'),
    planMinute: make(60_000, config.rate.planPerMin, 'You are planning too fast. Try again in a minute.'),
    planDay: make(24 * 60 * 60_000, config.rate.planPerDay, 'Daily planning limit reached. Try again tomorrow.'),
  };
}

export function toErrorBody(err) {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: err.issues[0]?.message || 'Invalid request',
          issues: err.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    };
  }
  if (err instanceof PlanError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...err.details } } };
  }
  if (err?.type === 'entity.too.large') return { status: 413, body: { error: { code: 'too_large', message: 'Request is too large.' } } };
  if (err?.type === 'entity.parse.failed') return { status: 400, body: { error: { code: 'bad_json', message: 'Request body is not valid JSON.' } } };
  return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong on our side.' } } };
}

export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const { status, body } = toErrorBody(err);
    if (status >= 500) logger.error?.(`[error] ${req.method} ${req.path}:`, err);
    if (res.headersSent) return res.end();
    res.status(status).json(body);
  };
}

/** Open a Server-Sent Events stream. Heartbeats keep proxies from closing an idle connection. */
export function openSse(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  beat.unref?.();
  return {
    send(event, data) {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    },
  };
}
