const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Config persistence ──────────────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // corrupted config — return defaults
  }
  return {};
}

function saveConfig(data) {
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_event, data) => saveConfig(data));
ipcMain.handle('config:path', () => configPath);

// ── File picker handlers ────────────────────────────────────────
ipcMain.handle('dialog:pickImage', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Attach Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return [];
  return filePaths.map((fp) => ({
    path: fp,
    name: path.basename(fp),
    base64: fs.readFileSync(fp).toString('base64'),
  }));
});

ipcMain.handle('dialog:pickFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Attach File',
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return [];
  return filePaths.map((fp) => {
    let content;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch {
      content = '[Binary file — cannot display as text]';
    }
    return { path: fp, name: path.basename(fp), content };
  });
});

// ── Chat history persistence ────────────────────────────────────
const crypto = require('crypto');
const historyDir = path.join(__dirname, 'chat_history');
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}

const HISTORY_FILE = path.join(historyDir, 'current.json');
const HISTORY_FILE_ENC = path.join(historyDir, 'current.enc');

function encryptData(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: salt(16) + iv(12) + authTag(16) + ciphertext
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decryptData(buffer, passphrase) {
  const salt = buffer.subarray(0, 16);
  const iv = buffer.subarray(16, 28);
  const authTag = buffer.subarray(28, 44);
  const ciphertext = buffer.subarray(44);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

ipcMain.handle('history:save', (_event, messages, encrypt, passphrase) => {
  try {
    const json = JSON.stringify(messages, null, 2);
    if (encrypt && passphrase) {
      const encrypted = encryptData(json, passphrase);
      fs.writeFileSync(HISTORY_FILE_ENC, encrypted);
      // Remove unencrypted file if it exists
      if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    } else {
      fs.writeFileSync(HISTORY_FILE, json, 'utf-8');
      // Remove encrypted file if it exists
      if (fs.existsSync(HISTORY_FILE_ENC)) fs.unlinkSync(HISTORY_FILE_ENC);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('history:load', (_event, encrypt, passphrase) => {
  try {
    if (encrypt && passphrase) {
      if (!fs.existsSync(HISTORY_FILE_ENC)) return { success: true, messages: [] };
      const buffer = fs.readFileSync(HISTORY_FILE_ENC);
      const json = decryptData(buffer, passphrase);
      return { success: true, messages: JSON.parse(json) };
    } else {
      if (!fs.existsSync(HISTORY_FILE)) return { success: true, messages: [] };
      const json = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return { success: true, messages: JSON.parse(json) };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('history:clear', () => {
  try {
    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    if (fs.existsSync(HISTORY_FILE_ENC)) fs.unlinkSync(HISTORY_FILE_ENC);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
