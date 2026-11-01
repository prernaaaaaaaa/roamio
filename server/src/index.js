import { loadConfig } from './config.js';
import { bootstrap } from './bootstrap.js';

const config = loadConfig();
const { app, store, llm, retriever, kb } = await bootstrap(config);

const server = app.listen(config.port, () => {
  console.log(
    `Roamio API on :${config.port} | llm=${llm.info.provider}/${llm.info.model} | embeddings=${retriever.embeddingMode} | store=${store.kind} | destinations=${kb.cities.size}`,
  );
  if (store.kind === 'memory') console.log('No MONGODB_URI set: accounts and saved trips are kept in memory and lost on restart.');
  if (llm.info.provider === 'mock') console.log('No GEMINI_API_KEY set: using the offline mock model. Set GEMINI_API_KEY for real AI planning.');
});

// SSE responses can be long; do not let Node's default timeouts cut them off.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await store.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
