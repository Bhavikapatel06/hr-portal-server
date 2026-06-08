import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single source of truth is the backend's matchService.js
const sourceFile = path.join(__dirname, 'services', 'matchService.js');
const destFile = path.join(__dirname, '..', 'hr-portal-client', 'src', 'utils', 'matchEngine.js');

try {
  fs.copyFileSync(sourceFile, destFile);
  console.log('✅ Automatically synced backend match algorithm to frontend matchEngine.js');
} catch (err) {
  console.error('Failed to sync match engine files. Make sure both folders exist.', err);
}
