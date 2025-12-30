const http = require('http');
const { initializeData } = require('./utils/data');
const router = require('./router');

const PORT = process.env.PORT || 3000;

// Initialize data directories and files
initializeData();

// Create and start server
const server = http.createServer(router);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
