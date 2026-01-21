const { settingsFile } = require('../config/paths');
const { readJSON, writeJSON, parseBody, sendJSON } = require('../utils/helpers');

const settings = {
  getSettings: (req, res) => {
    const settingsData = readJSON(settingsFile) || { currencySymbol: '£' };
    sendJSON(res, settingsData);
  },

  updateSettings: async (req, res) => {
    const body = await parseBody(req);
    const settingsData = readJSON(settingsFile) || {};
    const updatedSettings = { ...settingsData, ...body };
    writeJSON(settingsFile, updatedSettings);
    sendJSON(res, updatedSettings);
  }
};

module.exports = settings;
