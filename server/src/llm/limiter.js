/**
 * Concurrency + requests-per-minute limiter.
 *
 * The planner fans out several model calls at once. Free-tier API keys allow only a handful of
 * requests per minute, so every call goes through this limiter: at most `concurrency` calls in
 * flight and at most `rpm` call starts in any rolling 60 s window (0 = unlimited).
 */
export function createLimiter({ concurrency = 6, rpm = 0 } = {}) {
  let active = 0;
  let timer = null;
  const queue = [];
  const stamps = [];

  const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

  function rpmWait(now) {
    if (!rpm) return 0;
    while (stamps.length && now - stamps[0] >= 60_000) stamps.shift();
    if (stamps.length < rpm) return 0;
    return stamps[0] + 60_000 - now + 5;
  }

  function pump() {
    clearTimeout(timer);
    timer = null;
    while (queue.length && active < concurrency) {
      const now = Date.now();
      const wait = rpmWait(now);
      if (wait > 0) {
        // Deliberately NOT unref'd: a CLI run (the eval) has nothing else keeping the process alive while it waits.
        timer = setTimeout(pump, wait);
        return;
      }
      const job = queue.shift();
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      stamps.push(now);
      active++;
      job.resolve();
    }
  }

  /** Run `fn` once a slot is free. */
  async function run(fn, { signal } = {}) {
    await new Promise((resolve, reject) => {
      queue.push({ resolve, reject, signal });
      signal?.addEventListener(
        'abort',
        () => {
          const i = queue.findIndex((j) => j.resolve === resolve);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(abortError());
          }
        },
        { once: true },
      );
      pump();
    });
    try {
      return await fn();
    } finally {
      active--;
      pump();
    }
  }

  return { run, stats: () => ({ active, queued: queue.length }) };
}
