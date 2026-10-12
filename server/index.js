import { createApp } from './app.js';
import { APP_VERSION } from './config.js';

let app;
try {
  app = createApp();
} catch (err) {
  console.error(`\nBrisk Budget could not start: ${err.message}\n`);
  process.exit(1);
}

let address;
try {
  address = await app.listen();
} catch (err) {
  const port = app.config.port;
  const reasons = {
    EADDRINUSE: `port ${port} is already in use by another program. Set PORT to a free one`,
    EACCES: `it isn't allowed to use port ${port}. Ports below 1024 need extra permission; set PORT to 1024 or higher`,
    EADDRNOTAVAIL: `this computer doesn't have the address in HOST (${app.config.host})`
  };
  console.error(`\nBrisk Budget could not start: ${reasons[err.code] || err.message}\n`);
  process.exit(1);
}
const host = typeof address === 'object' && address ? address.port : address;
app.log.info(`Brisk Budget v${APP_VERSION} running at http://localhost:${host}`);

const shutdown = async (signal) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
