import { loadKnowledgeBase } from './kb/loader.js';
import { Retriever } from './kb/retriever.js';
import { createLLM } from './llm/index.js';
import { createPlanner } from './planner/pipeline.js';
import { createStore } from './store/index.js';
import { TTLCache } from './cache.js';
import { createApp } from './app.js';

/** Wire every component together. Shared by the server entry point, tests and the eval harness. */
export async function bootstrap(config, { logger = console, store, fetchImpl } = {}) {
  const kb = loadKnowledgeBase();
  const llm = createLLM(config);

  const embedder = config.llm.provider === 'gemini' ? (texts, o) => llm.embed(texts, o) : undefined;
  const retriever = await new Retriever({ kb, embedder, logger }).init();

  const cache = new TTLCache(config.cache);
  const planner = createPlanner({ kb, retriever, llm, config, cache, fetchImpl });
  const theStore = store ?? createStore(config);
  await theStore.connect();

  const deps = { config, kb, retriever, llm, planner, store: theStore, cache, logger };
  return { ...deps, app: createApp(deps) };
}
