import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
export const GITHUB_REPO = 'CoppingEthan/Brisk-Budget';

// Everything here can be overridden with environment variables, which is how tests and
// development keep away from real data.
export function loadConfig(env = process.env) {
  return {
    dataDir: path.resolve(env.BRISK_DATA_DIR || path.join(ROOT_DIR, 'data')),
    backupsDir: path.resolve(env.BRISK_BACKUPS_DIR || path.join(ROOT_DIR, 'backups')),
    port: env.PORT !== undefined ? Number(env.PORT) : 3000,
    host: env.HOST || undefined,
    dev: env.BRISK_DEV === '1' || process.argv.includes('--dev'),
    autoBackup: env.BRISK_AUTO_BACKUP !== '0',
    updateCheck: env.BRISK_UPDATE_CHECK !== '0',
    trustProxy: env.BRISK_TRUST_PROXY === '1',
    allowedHosts: env.BRISK_ALLOWED_HOSTS || '',
    quiet: env.BRISK_QUIET === '1'
  };
}
