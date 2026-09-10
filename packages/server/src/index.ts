import { createServer } from 'node:http';

import { config } from './config.js';
import { initStore, getStore } from './db/store.js';
import { handleHttp, sendNotFound } from './http/routes.js';
import { attachGateway } from './net/gateway.js';
import { matchmaker } from './match/matchmaker.js';

async function main(): Promise<void> {
  await initStore();

  const server = createServer((req, res) => {
    handleHttp(req, res)
      .then((handled) => {
        if (!handled) sendNotFound(req, res);
      })
      .catch((error) => {
        console.error('[http] unhandled error', error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });
  });

  const wss = attachGateway(server);
  matchmaker.start();

  server.listen(config.port, config.host, () => {
    console.log(`[kmtank] listening on http://${config.host}:${config.port}`);
    console.log(`[kmtank] websocket endpoint: ws://${config.host}:${config.port}/ws`);
    console.log(
      `[kmtank] google sign-in: ${config.googleClientId ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID)'}`,
    );
    console.log(`[kmtank] ranked persistence: ${getStore().durable ? 'postgres' : 'in-memory'}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[kmtank] ${signal} received, shutting down`);
    matchmaker.stop();
    wss.close();
    server.close(() => {
      void getStore()
        .close()
        .finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('[kmtank] unhandled rejection', reason));
}

main().catch((error) => {
  console.error('[kmtank] fatal startup error', error);
  process.exit(1);
});
