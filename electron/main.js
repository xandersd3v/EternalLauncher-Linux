// Node's thread pool does every file-system call of the launcher; the default 4 threads are easily all busy (a big download, a size walk),
// and then even a small read waits. Must be set before the first use of the pool.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
// Every fetch() of the main process goes through Chromium's network stack first (system proxy / VPN, secure DNS) and Node's second: see mc/netFetch.js
require('./mc/netFetch').install();

// --- data folder: %APPDATA%\EternalLauncher ---
// package.json's "name" (also "EternalLauncher") gives Electron this same
// folder by default, so Chromium's own files land here from the first moment.
// Safety net for an install that hasn't been renamed yet: if the new folder
// has no launcher data but the old "voxel-launcher" one does, keep using the
// old one instead of starting with an empty library. Must be settled before
// ./store (electron-store reads userData when it is created) is loaded.
(function pinUserDataDir() {
  const base = app.getPath('appData');
  const current = path.join(base, 'EternalLauncher');
  const legacy = path.join(base, 'voxel-launcher');
  const hasData = (dir) => fs.existsSync(path.join(dir, 'launcher-config.json'));
  app.setPath('userData', !hasData(current) && hasData(legacy) ? legacy : current);
}());
const registerIpc = require('./ipc');
const store = require('./store');
const license = require('./mc/license');
const paths = require('./mc/paths');

let mainWindow = null;

app.setName('Eternal Launcher');

// Errors nobody caught and crashed helper processes go to launcher.log in the data
// folder (%APPDATA%\EternalLauncher), so a tester can send it along with a bug report.
function logLine(kind, detail) {
  try {
    const file = path.join(app.getPath('userData'), 'launcher.log');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} [${kind}] ${detail}\n`);
  } catch { /* logging must never be the thing that fails */ }
}
process.on('uncaughtException', (err) => logLine('uncaughtException', err?.stack || err));
process.on('unhandledRejection', (reason) => logLine('unhandledRejection', reason?.stack || reason));
app.on('render-process-gone', (e, wc, details) => logLine('render-process-gone', JSON.stringify(details)));
app.on('child-process-gone', (e, details) => logLine('child-process-gone', JSON.stringify(details)));

// Diagnostics for "the launcher froze": a main thread that stops answering for 1.5 s+ is written to launcher.log together with the calls
// it was busy with (an IPC handler that blocks for 0.5 s+ is named too). Cheap: one timer and a timestamp per call.
(function watchStalls() {
  const recent = []; // [start time, channel, ms the handler blocked]
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, (...args) => {
    const t = Date.now();
    try { return fn(...args); } finally {
      const ms = Date.now() - t;
      recent.push([t, channel, ms]);
      if (recent.length > 60) recent.shift();
      if (ms >= 500) logLine('slow-ipc', `${channel} blocked the main thread for ${ms} ms`);
    }
  });
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - 250;
    last = now;
    if (lag < 1500) return;
    const around = recent.filter((r) => r[0] >= now - lag - 3000).slice(-12).map((r) => `${r[1]}(${r[2]}ms)`).join(', ');
    logLine('stall', `the main thread did not answer for ${(lag / 1000).toFixed(1)} s; calls around it: ${around || 'none'}`);
  }, 250).unref();

  // Development runs only (never in the installed program): the first 45 s after a build is started are profiled and saved next to the log
  // as launch-<time>.cpuprofile, so a freeze can be pinned to the exact function.
  if (!app.isPackaged) {
    const wrapped = ipcMain.handle;
    ipcMain.handle = (channel, fn) => wrapped(channel, (...args) => {
      if (channel === 'instances:launch') startLaunchProfile();
      return fn(...args);
    });
  }
  let profiling = false;
  function startLaunchProfile() {
    if (profiling) return;
    profiling = true;
    try {
      const inspector = require('inspector');
      const session = new inspector.Session();
      session.connect();
      session.post('Profiler.enable', () => session.post('Profiler.start', () => {
        setTimeout(() => {
          session.post('Profiler.stop', (err, res) => {
            try {
              if (!err && res && res.profile) fs.writeFileSync(path.join(app.getPath('userData'), `launch-${Date.now()}.cpuprofile`), JSON.stringify(res.profile));
            } catch { /* diagnostics only */ }
            try { session.disconnect(); } catch { /* already closed */ }
            profiling = false;
          });
        }, 45000);
      }));
    } catch { profiling = false; }
  }
}());
// Windows groups the taskbar button (and its jump list) under this id.
if (process.platform === 'win32') app.setAppUserModelId('com.eternal.launcher');

// --- taskbar jump list: right-click the app's taskbar icon -> quick launch ---
// Each entry starts this same executable with --launch=<instanceId>; the copy
// that is already running (single-instance lock below) receives that via the
// 'second-instance' event and asks the renderer to start the game. If the
// launcher wasn't running, the id waits in pendingLaunchId until the
// renderer has loaded and picks it up.
const LAUNCH_ARG = '--launch=';
const launchIdFromArgv = (argv) => {
  const arg = argv.find((a) => a.startsWith(LAUNCH_ARG));
  const id = arg ? arg.slice(LAUNCH_ARG.length) : null;
  return id && /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : null; // instance ids are UUIDs
};
let pendingLaunchId = launchIdFromArgv(process.argv);

// Wraps a decoded instance icon (any format nativeImage can read) as a
// single-image .ico. Windows Vista+ shortcuts accept a PNG blob dropped
// straight into the classic ICO container (no BMP/DIB conversion needed),
// so this just resizes to 256x256 and writes the minimal 22-byte header.
// `icon` is either a data: URL (user-uploaded custom icon) or a plain
// https URL (the project's icon_url as installed straight from Modrinth/
// CurseForge, never downloaded locally) — both need to become raw bytes
// before nativeImage can decode them.
async function writeIcoFromInstanceIcon(icon, destPath) {
  let img;
  if (icon.startsWith('data:')) {
    img = nativeImage.createFromDataURL(icon);
  } else {
    const res = await fetch(icon);
    if (!res.ok) return false;
    img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  }
  if (img.isEmpty()) return false;
  const png = img.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  if (!png.length) return false;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // image data starts right after header+entry
  fs.writeFileSync(destPath, Buffer.concat([header, entry, png]));
  return true;
}

async function createDesktopShortcut(instanceId) {
  if (process.platform !== 'win32') return { ok: false, error: 'Ярлыки поддерживаются только на Windows' };
  const instances = store.get('instances') || [];
  const inst = instances.find((i) => i.id === instanceId);
  if (!inst) return { ok: false, error: 'Сборка не найдена' };

  const safeName = String(inst.name || 'Сборка').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 100) || 'Сборка';
  const lnkPath = path.join(app.getPath('desktop'), `${safeName}.lnk`);

  // build/icon.ico lives inside app.asar once packaged — PowerShell/Explorer can't read
  // that — so the installed app points the shortcut at its own exe (it carries the icon).
  let iconPath = app.isPackaged ? process.execPath : path.join(__dirname, '..', 'build', 'icon.ico');
  if (typeof inst.icon === 'string' && (inst.icon.startsWith('data:') || inst.icon.startsWith('http'))) {
    try {
      const generated = path.join(paths.instanceDir(inst.id), 'shortcut-icon.ico');
      if (await writeIcoFromInstanceIcon(inst.icon, generated)) iconPath = generated;
    } catch { /* keep the app icon as fallback */ }
  }

  const argsPrefix = process.defaultApp ? `"${app.getAppPath()}" ` : '';
  const args = `${argsPrefix}${LAUNCH_ARG}${inst.id}`;
  // PowerShell treats the typographic quotes ‘ ’ ‚ ‛ like ' inside a '...' string, so a
  // modpack named "x’; calc; ’" would otherwise break out of it. Double every one of them.
  const esc = (s) => String(s).replace(/['‘’‚‛]/g, (q) => q + q);
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut('${esc(lnkPath)}')`,
    `$s.TargetPath = '${esc(process.execPath)}'`,
    `$s.Arguments = '${esc(args)}'`,
    `$s.IconLocation = '${esc(iconPath)}'`,
    `$s.WorkingDirectory = '${esc(path.dirname(process.execPath))}'`,
    '$s.Save()',
  ].join('\n');

  // A fresh private folder with a random name: a predictable file name in the shared temp folder could be swapped by another process.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternal-shortcut-'));
  const tmpPs1 = path.join(tmpDir, 'shortcut.ps1');
  // Windows PowerShell 5.1 reads a script file without a BOM using the
  // system ANSI codepage, mangling any non-Latin letters in the path
  // (a user folder may well contain them) — a leading BOM makes it read
  // the file as UTF-8 instead.
  fs.writeFileSync(tmpPs1, `﻿${ps}`, 'utf8');
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1], (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.toString().trim() || err.message)); else resolve();
      });
    });
    return { ok: true, path: lnkPath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

function refreshJumpList() {
  if (process.platform !== 'win32') return;
  try {
    const instances = store.get('instances') || [];
    const ordered = [...instances]
      .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      .slice(0, 8);
    // In dev the executable is electron.exe itself, which needs the app path first.
    const argsPrefix = process.defaultApp ? `"${app.getAppPath()}" ` : '';
    const items = ordered.map((inst) => ({
      type: 'task',
      program: process.execPath,
      args: `${argsPrefix}${LAUNCH_ARG}${inst.id}`,
      title: String(inst.name || 'Сборка').slice(0, 60),
      description: `Запустить «${inst.name}»`,
      iconPath: process.execPath,
      iconIndex: 0,
    }));
    app.setJumpList(items.length ? [{ type: 'custom', name: 'Быстрый запуск', items }] : []);
  } catch {
    /* jump list is a convenience — never let it break startup */
  }
}

let jumpListTimer = null;
function scheduleJumpListRefresh() {
  clearTimeout(jumpListTimer);
  jumpListTimer = setTimeout(refreshJumpList, 1500);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const id = launchIdFromArgv(argv);
      if (id) mainWindow.webContents.send('app:launchRequest', { instanceId: id });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#160A0E',
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Eternal Launcher',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses electron's contextBridge/ipcRenderer/webUtils, all of
      // which a sandboxed preload has — so the page gets no Node access at all.
      sandbox: true,
    },
  });

  // The window only ever shows the launcher's own page. Anything that tries to open
  // another window or navigate away (a link that slipped through, a dropped file)
  // is refused; real links go through shell:openExternal, which allows web URLs only.
  const isDev = process.env.NODE_ENV === 'development';
  const ownUrl = isDev ? 'http://localhost:5173' : require('url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ownUrl)) e.preventDefault();
  });
  // No camera/mic/location/notifications for the page; only "copy text" buttons are allowed.
  const allowed = (permission) => permission === 'clipboard-sanitized-write';
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(allowed(permission)));
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => allowed(permission));

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    });
  }

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  return mainWindow;
}

if (gotLock) {
  app.whenReady().then(() => {
    // Names of the site and other servers are resolved over HTTPS (Cloudflare, then Google) first and through the system DNS only if that fails:
    // a provider that poisons / blocks DNS answers for a site no longer keeps the launcher from it (the browser does the same). Used by
    // Chromium's network stack, i.e. the launcher's requests to the site (license.js).
    try { app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'] }); } catch { /* the system DNS stays */ }
    store.sealAccountSecrets(); // old plain-text Microsoft tokens in launcher-config.json get encrypted
    const win = createWindow();
    registerIpc(win);

    // Same subscription gate as in ipc.js: nothing but the sign-in screen works without a license.
    ipcMain.handle('app:takePendingLaunch', () => {
      if (!license.isValid()) return null;
      const id = pendingLaunchId;
      pendingLaunchId = null;
      return id;
    });

    ipcMain.handle('app:createShortcut', (e, instanceId) => {
      if (!license.isValid()) throw new Error('LICENSE_REQUIRED');
      return createDesktopShortcut(instanceId);
    });

    refreshJumpList();
    // Names, launch times and the instance list all live in this one key.
    store.onDidChange('instances', scheduleJumpListRefresh);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
