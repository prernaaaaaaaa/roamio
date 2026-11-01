import { MemoryStore } from './memory.js';
import { MongoStore } from './mongo.js';

export function createStore(config) {
  return config.mongoUri ? new MongoStore(config.mongoUri) : new MemoryStore();
}
