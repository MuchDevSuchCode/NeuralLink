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

// ── Web API handlers (free, no API keys) ────────────────────────
const { net } = require('electron');

async function fetchJSON(url) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Weather via Open-Meteo (geocode + forecast)
ipcMain.handle('web:weather', async (_event, city) => {
  try {
    // Geocode the city
    const geo = await fetchJSON(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`
    );
    if (!geo.results || geo.results.length === 0) {
      return { success: false, error: `City not found: ${city}` };
    }
    const { latitude, longitude, name, country, timezone } = geo.results[0];

    // Fetch current weather + 3-day forecast
    const weather = await fetchJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(timezone)}&forecast_days=3`
    );

    return {
      success: true,
      data: {
        location: `${name}, ${country}`,
        timezone,
        current: weather.current,
        current_units: weather.current_units,
        daily: weather.daily,
        daily_units: weather.daily_units,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Time via WorldTimeAPI
ipcMain.handle('web:time', async (_event, location) => {
  try {
    // First geocode to get timezone
    const geo = await fetchJSON(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en`
    );
    if (!geo.results || geo.results.length === 0) {
      return { success: false, error: `Location not found: ${location}` };
    }
    const { name, country, timezone } = geo.results[0];

    const timeData = await fetchJSON(
      `https://worldtimeapi.org/api/timezone/${encodeURIComponent(timezone)}`
    );

    return {
      success: true,
      data: {
        location: `${name}, ${country}`,
        timezone,
        datetime: timeData.datetime,
        utc_offset: timeData.utc_offset,
        day_of_week: timeData.day_of_week,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IP geolocation via ip-api.com
ipcMain.handle('web:ip', async (_event, address) => {
  try {
    const url = address
      ? `http://ip-api.com/json/${encodeURIComponent(address)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`
      : `http://ip-api.com/json/?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

    const data = await fetchJSON(url);
    if (data.status === 'fail') {
      return { success: false, error: data.message || 'IP lookup failed' };
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Web search via DuckDuckGo Instant Answer API
ipcMain.handle('web:search', async (_event, query) => {
  try {
    const data = await fetchJSON(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    );
    return {
      success: true,
      data: {
        heading: data.Heading || '',
        abstract: data.AbstractText || '',
        source: data.AbstractSource || '',
        url: data.AbstractURL || '',
        answer: data.Answer || '',
        related: (data.RelatedTopics || []).slice(0, 5).map((t) => ({
          text: t.Text || '',
          url: t.FirstURL || '',
        })).filter((t) => t.text),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── SSH handler ───────────────────────────────────────────────
const { exec } = require('child_process');

ipcMain.handle('ssh:connect', async (_event, host, username, privateKeyPath) => {
  return new Promise((resolve) => {
    let keyArg = '';
    if (privateKeyPath) {
      let keyPath = privateKeyPath;
      if (keyPath.startsWith('~')) {
        keyPath = path.join(require('os').homedir(), keyPath.slice(1));
      }
      keyArg = `-i "${keyPath}"`;
    }

    // Run a simple command over SSH to validate connection and fetch basic banner/OS info
    // -o BatchMode=yes prevents password prompts from hanging the process
    // -o StrictHostKeyChecking=no auto-accepts new host keys
    const cmd = `ssh -v -o BatchMode=yes -o StrictHostKeyChecking=no ${keyArg} ${username}@${host} "cat /etc/os-release || uname -a"`;

    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      // The -v flag prints banner info to stderr. We can extract it or just return both.
      const output = (stdout + '\n' + stderr).trim();

      if (error) {
        // Did we actually connect but the command failed, or did connection fail?
        if (error.code === 255) {
          resolve({ success: false, error: 'SSH Connection Failed (Code 255):\n' + stderr });
        } else {
          resolve({ success: true, banner: 'Connected with errors:\n' + output });
        }
      } else {
        // Success
        resolve({ success: true, banner: output });
      }
    });
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
