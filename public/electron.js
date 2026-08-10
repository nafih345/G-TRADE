const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, exec } = require('child_process');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const BACKEND_PORT = 8000;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health/`;

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let isQuitting = false;

// Ensure Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(initApp);
}

function initApp() {
  createSplashWindow();
  ensureDirectories();
  startBackendService().then(() => {
    waitForBackendReady(30, () => {
      createMainWindow();
    });
  }).catch((err) => {
    console.error('Failed to start backend:', err);
    updateSplashStatus('Error starting backend service: ' + err.message);
  });
}

function ensureDirectories() {
  const baseDir = isDev ? __dirname : path.dirname(process.execPath);
  const dirs = ['logs', 'config', 'database', 'media', 'static', 'reports', 'temp', 'backups'];
  dirs.forEach(d => {
    const dirPath = path.join(baseDir, d);
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch (e) {
        console.warn(`Could not create directory ${d}:`, e.message);
      }
    }
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const splashPath = path.join(__dirname, 'splash.html');
  splashWindow.loadFile(splashPath);

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function updateSplashStatus(message) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('status-update', message);
  }
}

function checkPortInUse(port, callback) {
  const req = http.get(`http://127.0.0.1:${port}/api/health/`, (res) => {
    callback(true);
  });
  req.on('error', () => {
    callback(false);
  });
  req.end();
}

function startBackendService() {
  return new Promise((resolve, reject) => {
    checkPortInUse(BACKEND_PORT, (inUse) => {
      if (inUse) {
        console.log('Backend process already running on port', BACKEND_PORT);
        updateSplashStatus('Backend service detected. Connecting...');
        return resolve();
      }

      updateSplashStatus('Starting Django Backend Engine...');
      
      let executablePath = '';
      let args = [];
      let cwd = '';

      if (isDev) {
        const rootDir = path.join(__dirname, '..');
        const venvPython = path.join(rootDir, 'backend', 'venv', 'Scripts', 'python.exe');
        executablePath = fs.existsSync(venvPython) ? venvPython : 'python';
        cwd = path.join(rootDir, 'backend');
        args = ['manage.py', 'runserver', `127.0.0.1:${BACKEND_PORT}`, '--noreload'];
      } else {
        const resourcesPath = process.resourcesPath;
        const exeInResources = path.join(resourcesPath, 'backend', 'backend.exe');
        const exeInAppDir = path.join(path.dirname(process.execPath), 'backend.exe');
        
        if (fs.existsSync(exeInResources)) {
          executablePath = exeInResources;
          cwd = path.dirname(exeInResources);
        } else if (fs.existsSync(exeInAppDir)) {
          executablePath = exeInAppDir;
          cwd = path.dirname(exeInAppDir);
        } else {
          console.warn('backend.exe not found in packaged path. Falling back to relative backend folder.');
          executablePath = path.join(__dirname, '..', 'backend.exe');
          cwd = path.dirname(executablePath);
        }
      }

      console.log(`Spawning backend: ${executablePath} in ${cwd}`);
      
      try {
        backendProcess = spawn(executablePath, args, {
          cwd: cwd,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        backendProcess.stdout.on('data', (data) => {
          console.log(`[Backend stdout]: ${data}`);
        });

        backendProcess.stderr.on('data', (data) => {
          console.error(`[Backend stderr]: ${data}`);
        });

        backendProcess.on('error', (err) => {
          console.error('Failed to spawn backend process:', err);
          reject(err);
        });

        backendProcess.on('exit', (code, signal) => {
          console.warn(`Backend process exited with code ${code} and signal ${signal}`);
          if (!isQuitting && code !== 0) {
            updateSplashStatus('Backend stopped unexpectedly. Attempting restart...');
            setTimeout(startBackendService, 3000);
          }
        });

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

function waitForBackendReady(retries, callback) {
  if (retries <= 0) {
    updateSplashStatus('Backend connection timeout. Launching frontend...');
    callback();
    return;
  }

  checkPortInUse(BACKEND_PORT, (ready) => {
    if (ready) {
      updateSplashStatus('Database and Backend connected! Loading UI...');
      setTimeout(callback, 800);
    } else {
      updateSplashStatus(`Connecting to Backend Service (retry ${31 - retries}/30)...`);
      setTimeout(() => waitForBackendReady(retries - 1, callback), 1000);
    }
  });
}

function createMainWindow() {
  const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  let windowBounds = { width: 1366, height: 768, isMaximized: false };

  try {
    if (fs.existsSync(windowStateFile)) {
      windowBounds = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    }
  } catch (e) {
    console.warn('Failed to load window state:', e.message);
  }

  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1366,
    height: windowBounds.height || 768,
    minWidth: 1024,
    minHeight: 600,
    title: 'Optical ERP - Desktop Enterprise',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev
    }
  });

  mainWindow.removeMenu();

  if (windowBounds.isMaximized) {
    mainWindow.maximize();
  }

  // Save window bounds on resize/move/close
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    const isMax = mainWindow.isMaximized();
    try {
      fs.writeFileSync(windowStateFile, JSON.stringify({ ...bounds, isMaximized: isMax }));
    } catch (e) {}
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const candidatePaths = [
      path.join(__dirname, '..', 'frontend', 'dist', 'index.html'),
      path.join(__dirname, 'frontend', 'dist', 'index.html'),
      path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'index.html'),
      path.join(process.resourcesPath, 'app', 'frontend', 'dist', 'index.html'),
      path.join(app.getAppPath(), 'frontend', 'dist', 'index.html')
    ];
    let loaded = false;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        console.log('Loading frontend from:', p);
        mainWindow.loadFile(p);
        loaded = true;
        break;
      }
    }
    if (!loaded) {
      console.error('Could not find frontend dist index.html in candidates:', candidatePaths);
      mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
    }
  }

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Clean up background processes on quit
app.on('before-quit', () => {
  isQuitting = true;
  if (backendProcess) {
    console.log('Terminating background process...');
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${backendProcess.pid} /T /F`);
      } else {
        backendProcess.kill('SIGTERM');
      }
    } catch (e) {
      console.error('Error killing backend process:', e);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle('get-app-info', () => {
  return {
    name: 'Optical ERP',
    version: '1.0.0',
    isDev: isDev,
    appPath: app.getAppPath()
  };
});

ipcMain.handle('print-invoice', async (event, options) => {
  if (mainWindow) {
    mainWindow.webContents.print(options || { silent: false, printBackground: true });
  }
});
