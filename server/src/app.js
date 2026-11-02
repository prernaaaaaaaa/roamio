import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createApiRouter } from './routes/api.js';
import { errorHandler } from './middleware/common.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(here, '..', '..', 'client', 'dist');

/**
 * Assemble the Express app from its dependencies. Nothing here reads the environment or opens a
 * socket, so tests can build an app around a mock model and an in-memory store.
 */
export function createApp(deps) {
  const { config, logger = console } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      // OpenStreetMap's tile servers reject requests that carry no Referer (helmet's default is no-referrer).
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  const origins = config.clientOrigins;
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // Saving a trip carries the whole itinerary, so that one route gets a larger body limit.
  app.use('/api/trips', express.json({ limit: '400kb' }));
  app.use(express.json({ limit: '20kb' }));

  app.use('/api', createApiRouter(deps));

  if (config.serveClient && fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    app.use(express.static(CLIENT_DIST, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }

  app.use(errorHandler(logger));
  return app;
}
