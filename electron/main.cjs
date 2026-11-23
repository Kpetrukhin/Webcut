'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
} = require('electron');

let mainWindow = null;
let serverHandle = null;
let serverUrl = '';
let stopServerFn = null;
let isQuitting = false;
let shutdownCompleted = false;

function resolveAppResource(...segments) {
  const basePath = path.resolve(__dirname, '..', ...segments);
  if (basePath.includes('app.asar')) {
    const unpackedPath = basePath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }
  return basePath;
}

function isLocalServerOrigin(urlString) {
  if (!urlString) return false;
  try {
    const parsed = new URL(urlString);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function setupSessionPermissionsAndDownloads() {
  const defaultSession = session.defaultSession;
  const allowedPermissions = new Set([
    'media',
    'mediaKeySystem',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'pointerLock',
  ]);

  defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      if (!allowedPermissions.has(permission)) return false;
      if (!requestingOrigin) return true;
      return isLocalServerOrigin(requestingOrigin);
    }
  );

  defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const origin = details?.requestingUrl || webContents.getURL();
      const allowed =
        allowedPermissions.has(permission) &&
        (!origin || isLocalServerOrigin(origin));
      callback(allowed);
    }
  );

  defaultSession.on('will-download', (_event, item, webContents) => {
    const ownerWindow =
      BrowserWindow.fromWebContents(webContents) || mainWindow || undefined;
    const rawName = item.getFilename() || 'CutSync-export.webm';
    const downloadsDir = app.getPath('downloads');
    const defaultPath = path.join(downloadsDir, rawName);

    const ext = path.extname(rawName).replace(/^\./, '').toLowerCase();
    const filters = [];
    if (ext) {
      filters.push({
        name: ext.toUpperCase(),
        extensions: [ext],
      });
    }
    filters.push({name: 'Все файлы', extensions: ['*']});

    try {
      const chosenPath = ownerWindow
        ? dialog.showSaveDialogSync(ownerWindow, {
            title: 'Сохранить файл',
            defaultPath,
            filters,
          })
        : dialog.showSaveDialogSync({
            title: 'Сохранить файл',
            defaultPath,
            filters,
          });

      if (!chosenPath) {
        item.cancel();
        return;
      }
      item.setSavePath(chosenPath);
    } catch {
      item.setSavePath(defaultPath);
    }
  });
}

async function startLocalBackend() {
  const userDataDir = app.getPath('userData');
  const dataDir = path.join(userDataDir, 'data');
  const uploadsDir = path.join(userDataDir, 'uploads');
  const distDir = resolveAppResource('dist');
  const serverBundlePath = resolveAppResource('dist-server', 'server.cjs');

  fs.mkdirSync(dataDir, {recursive: true});
  fs.mkdirSync(uploadsDir, {recursive: true});

  process.env.NODE_ENV = 'production';
  process.env.CUTSYNC_NO_AUTOSTART = '1';
  process.env.CUTSYNC_DATA_DIR = dataDir;
  process.env.CUTSYNC_UPLOADS_DIR = uploadsDir;
  process.env.CUTSYNC_DIST_DIR = distDir;

  globalThis.__cutsyncPickDirectory = async () => {
    const ownerWindow =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const res = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, {
          title: 'Выберите папку для сохранения и обмена медиа',
          defaultPath: uploadsDir,
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Выберите папку для сохранения и обмена медиа',
          defaultPath: uploadsDir,
          properties: ['openDirectory', 'createDirectory'],
        });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  };

  if (!fs.existsSync(serverBundlePath)) {
    throw new Error(
      `Собранный сервер не найден: ${serverBundlePath}. Выполните npm run build:server.`
    );
  }

  const serverModule = require(serverBundlePath);
  stopServerFn = serverModule.stopServer;

  const preferredPort = Number(process.env.PORT) || 3000;
  serverHandle = await serverModule.startServer({
    port: preferredPort,
    isProd: true,
    fallbackToRandomPort: true,
  });
  serverUrl = `http://127.0.0.1:${serverHandle.port}`;
  return serverUrl;
}

function createMainWindow(targetUrl) {
  const iconPath = resolveAppResource('public', 'pwa-512x512.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'CutSync',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (isLocalServerOrigin(url)) {
      return {action: 'allow'};
    }
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return {action: 'deny'};
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalServerOrigin(url) && !url.startsWith('blob:')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(targetUrl);
}

async function shutdownBackend() {
  if (shutdownCompleted) return;
  shutdownCompleted = true;
  if (typeof stopServerFn === 'function') {
    try {
      await Promise.race([
        stopServerFn(),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch (err) {
      console.error('Error stopping CutSync server:', err);
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      setupSessionPermissionsAndDownloads();
      const url = await startLocalBackend();
      createMainWindow(url);
    } catch (err) {
      console.error('Failed to launch CutSync Desktop:', err);
      dialog.showErrorBox(
        'Ошибка запуска CutSync',
        err instanceof Error ? err.message : String(err)
      );
      await shutdownBackend();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    void shutdownBackend().finally(() => {
      app.exit(0);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl && !isQuitting) {
      createMainWindow(serverUrl);
    }
  });
}
