// Simple JSON file store — no database needed for now
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, defaultValue = null) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function write(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8');
}

function update(name, updater, defaultValue = {}) {
  const current = read(name, defaultValue);
  const updated = updater(current);
  write(name, updated);
  return updated;
}

module.exports = { read, write, update };
