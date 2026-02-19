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
