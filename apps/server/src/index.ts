#!/usr/bin/env node

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { VeriDoneDatabase } from './database.js';

const config = loadConfig();
const database = new VeriDoneDatabase(config.databasePath);
const app = createApp({ config, database });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  process.stdout.write(`VeriDone is listening on http://${info.address}:${info.port}\n`);
});

const shutdown = () => {
  server.close(() => {
    database.close();
    process.exit(0);
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
