// Starts Brisk Budget for the browser tests on a fresh folder of demo data
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from '../scripts/seed-demo.js';
import { createApp } from '../server/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '.e2e-data');
fs.rmSync(base, { recursive: true, force: true });
const dataDir = path.join(base, 'data');
const backupsDir = path.join(base, 'backups');
seedDemo(dataDir, 4, { backupsDir });

const app = createApp({ dataDir, backupsDir, autoBackup: false, updateCheck: false, quiet: true });
await app.listen(Number(process.env.E2E_PORT) || 3999, '127.0.0.1');
console.log('e2e server ready');

const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
