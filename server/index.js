const http = require('http');
const { initializeData } = require('./utils/data');
const router = require('./router');
const { startAutoBackup } = require('./routes/backup');
const { accrueAll } = require('./utils/mortgage');

const PORT = process.env.PORT || 3000;

// Initialize data directories and files
initializeData();

// Catch up any mortgage interest missed while the server was off
accrueAll();

// Start auto-backup scheduler
startAutoBackup();

// Create and start server
const server = http.createServer(router);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
