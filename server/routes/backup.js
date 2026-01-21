const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { DATA_DIR, TRANSACTIONS_DIR, BACKUPS_DIR } = require('../config/paths');
const { sendJSON } = require('../utils/helpers');

const MAX_BACKUPS = 24;
let lastBackupTime = null;

// Get modification time of most recently modified file in data directory
const getLatestDataModTime = () => {
  let latestTime = 0;

  const checkDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        checkDir(filePath);
      } else {
        if (stat.mtimeMs > latestTime) {
          latestTime = stat.mtimeMs;
        }
      }
    }
  };

  checkDir(DATA_DIR);
  return latestTime;
};

// Create a ZIP of the data folder
const createBackupZip = () => {
  const zip = new AdmZip();

  // Add root-level JSON files
  const rootFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of rootFiles) {
    const filePath = path.join(DATA_DIR, file);
    zip.addLocalFile(filePath);
  }

  // Add transactions folder
  if (fs.existsSync(TRANSACTIONS_DIR)) {
    const txFiles = fs.readdirSync(TRANSACTIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of txFiles) {
      const filePath = path.join(TRANSACTIONS_DIR, file);
      zip.addLocalFile(filePath, 'transactions');
    }
  }

  return zip;
};

// Download backup (manual)
const downloadBackup = (req, res) => {
  try {
    const zip = createBackupZip();
    const buffer = zip.toBuffer();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `brisk-budget-backup-${timestamp}.zip`;

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length
    });
    res.end(buffer);
  } catch (err) {
    console.error('Backup error:', err);
    sendJSON(res, { error: 'Failed to create backup' }, 500);
  }
};

// Restore from uploaded ZIP
const restoreBackup = (req, res) => {
  const chunks = [];

  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      // Validate ZIP structure
      const entryNames = entries.map(e => e.entryName);
      const requiredFiles = ['accounts.json', 'categories.json', 'settings.json'];

      for (const required of requiredFiles) {
        if (!entryNames.includes(required)) {
          return sendJSON(res, { error: `Invalid backup: missing ${required}` }, 400);
        }
      }

      // Validate JSON files are valid
      for (const entry of entries) {
        if (entry.entryName.endsWith('.json')) {
          try {
            JSON.parse(entry.getData().toString('utf8'));
          } catch {
            return sendJSON(res, { error: `Invalid JSON in ${entry.entryName}` }, 400);
          }
        }
      }

      // Ensure directories exist
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (!fs.existsSync(TRANSACTIONS_DIR)) {
        fs.mkdirSync(TRANSACTIONS_DIR, { recursive: true });
      }

      // Clear existing transaction files
      const existingTxFiles = fs.readdirSync(TRANSACTIONS_DIR);
      for (const file of existingTxFiles) {
        fs.unlinkSync(path.join(TRANSACTIONS_DIR, file));
      }

      // Extract files
      for (const entry of entries) {
        if (entry.isDirectory) continue;

        const data = entry.getData();
        let targetPath;

        if (entry.entryName.startsWith('transactions/')) {
          const filename = path.basename(entry.entryName);
          targetPath = path.join(TRANSACTIONS_DIR, filename);
        } else {
          targetPath = path.join(DATA_DIR, entry.entryName);
        }

        fs.writeFileSync(targetPath, data);
      }

      sendJSON(res, { success: true, message: 'Backup restored successfully' });
    } catch (err) {
      console.error('Restore error:', err);
      sendJSON(res, { error: 'Failed to restore backup' }, 500);
    }
  });

  req.on('error', (err) => {
    console.error('Request error:', err);
    sendJSON(res, { error: 'Failed to receive backup file' }, 500);
  });
};

// Create automatic backup (saved to backups folder)
const createAutoBackup = () => {
  try {
    // Ensure backups directory exists
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    const zip = createBackupZip();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${timestamp}.zip`;
    const filepath = path.join(BACKUPS_DIR, filename);

    zip.writeZip(filepath);
    console.log(`Auto-backup created: ${filename}`);

    // Clean up old backups
    cleanupOldBackups();

    return true;
  } catch (err) {
    console.error('Auto-backup error:', err);
    return false;
  }
};

// Remove old backups, keeping only MAX_BACKUPS
const cleanupOldBackups = () => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return;

    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
      .map(f => ({
        name: f,
        path: path.join(BACKUPS_DIR, f),
        time: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    // Delete files beyond MAX_BACKUPS
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(files[i].path);
      console.log(`Deleted old backup: ${files[i].name}`);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};

// Check if data has changed since last backup
const hasDataChanged = () => {
  const latestModTime = getLatestDataModTime();
  return lastBackupTime === null || latestModTime > lastBackupTime;
};

// Start the auto-backup scheduler
const startAutoBackup = () => {
  const HOUR = 60 * 60 * 1000;

  // Run initial check after 1 minute to let server stabilize
  setTimeout(() => {
    if (hasDataChanged()) {
      createAutoBackup();
      lastBackupTime = Date.now();
    }
  }, 60 * 1000);

  // Then run every hour
  setInterval(() => {
    if (hasDataChanged()) {
      createAutoBackup();
      lastBackupTime = Date.now();
    } else {
      console.log('Auto-backup skipped: no changes detected');
    }
  }, HOUR);

  console.log('Auto-backup scheduler started (hourly)');
};

module.exports = {
  downloadBackup,
  restoreBackup,
  startAutoBackup
};
