// Оверлей мониторинга поверх игры (Right Ctrl). Агент Eternal Cosmetics в игре (eternal-agent/, Metrics.java) меряет игру изнутри (кадры,
// сущности, чанки, TPS, память Java) и шлёт это десять раз в секунду по UDP на 127.0.0.1; здесь это принимается, дополняется тем,
// что видно снаружи (процессор и память процесса игры, видеокарта и видеопамять игры — счётчики Windows), и рисуется в прозрачном окне,
// которое стоит поверх окна игры, пока игра в фокусе. Мышь окно не ловит. Клавишу Right Ctrl ловит агент в игре (она там и так нажата)
// и присылает счётчиком нажатий: потерянный пакет ничего не теряет.
//
// Безопасность: сокет слушает только петлю (127.0.0.1) и только пакеты оттуда; размер и числа проверяются, всё остальное отбрасывается.
// Окну оверлея не даётся ничего, кроме этих чисел.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const store = require('../store');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const horizonControl = require('./horizonControl');

// Two kinds of game: Minecraft with our agent (the game sends its numbers over UDP) and Horizon, the Rust game (the launcher asks its
// control socket). A session has { kind, pid, last, lastAt, cpu, ramMb, gpu, vramMb, gpuTemp, keyLabel } and, by kind,
// { socket, port, tg } or { endpointFile, control, keyProc }.
const sessions = new Map(); // instanceId -> session
let win = null;
let activeId = null; // the instance whose overlay is switched on
let trackers = []; // the PowerShells that report the game window and the GPU
let rect = null; // the game window, physical pixels
let gameFocused = false;
let minimized = false;
let shown = false;

// The panel's size is told by the page itself (it knows how tall it is in the compact and the full view); scale and corner are the player's settings
const PANEL = { width: 330, height: 392 };
let config = { scale: 1, mode: 'full', opacity: 0.82, corner: 'tl' };
const SCALES = { small: 0.85, normal: 1, large: 1.25 };
const CORNERS = new Set(['tl', 'tr', 'bl', 'br']);

function readConfig(keyLabel) {
  const st = store.get('settings') || {};
  config = {
    scale: SCALES[st.overlayScale] || 1,
    mode: st.overlayMode === 'compact' ? 'compact' : 'full',
    opacity: Number.isFinite(st.overlayOpacity) ? Math.max(30, Math.min(100, st.overlayOpacity)) / 100 : 0.82,
    corner: CORNERS.has(st.overlayCorner) ? st.overlayCorner : 'tl',
  };
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomFactor(config.scale);
    win.webContents.send('overlay:config', { mode: config.mode, opacity: config.opacity, keyLabel });
  }
}

ipcMain.on('overlay:size', (e, size) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  const w = num(size && size.w, 100, 1200, 0);
  const h = num(size && size.h, 60, 1600, 0);
  if (!w || !h) return;
  PANEL.width = Math.ceil(w * config.scale);
  PANEL.height = Math.ceil(h * config.scale);
  place();
});

// Developer aid: ETERNAL_OVERLAY_DEBUG=<file> writes what the overlay does (nothing is written otherwise)
const DEBUG_FILE = process.env.ETERNAL_OVERLAY_DEBUG || '';
function dbg(text) {
  if (!DEBUG_FILE) return;
  try { require('fs').appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${text}\n`); } catch { /* ignore */ }
}

const num = (v, lo, hi, dflt = -1) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);

// A datagram from the game -> the numbers we trust, or null.
function sanitize(msg) {
  if (!msg || msg.length > 16384) return null;
  let d;
  try { d = JSON.parse(msg.toString('utf8')); } catch { return null; }
  if (!d || typeof d !== 'object' || d.v !== 1) return null;
  const ft = Array.isArray(d.ft) ? d.ft.slice(0, 600).filter((x) => typeof x === 'number' && x > 0 && x < 5000) : [];
  return {
    fps: num(d.fps, 0, 100000),
    ft,
    ent: num(d.ent, 0, 10000000),
    chk: num(d.chk, 0, 10000000),
    tps: num(d.tps, 0, 20),
    hu: num(d.hu, 0, 1000000),
    hm: num(d.hm, 0, 1000000),
    tg: num(d.tg, 0, 1e9, 0),
    fo: d.fo === 1 ? 1 : d.fo === 0 ? 0 : -1, // the game's own word on whether its window is in front
    wx: num(d.wx, -100000, 100000, 0),
    wy: num(d.wy, -100000, 100000, 0),
    ww: num(d.ww, 0, 100000, 0), // where the game's window is (its inside, in screen pixels)
    wh: num(d.wh, 0, 100000, 0),
  };
}

// Called before the game starts: where the game should send its numbers. null = the overlay is not available.
function prepare(instanceId, keyLabel = 'F9') {
  return new Promise((resolve) => {
    try {
      release(instanceId);
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      const s = { kind: 'java', socket, port: 0, tg: null, pid: null, last: null, lastAt: 0, cpu: -1, ramMb: -1, gpu: -1, vramMb: -1, gpuTemp: -1, keyLabel: String(keyLabel).slice(0, 20) };
      socket.on('error', () => release(instanceId));
      socket.on('message', (msg, info) => {
        if (info.address !== '127.0.0.1') return;
        const m = sanitize(msg);
        if (!m) { dbg('a datagram was rejected'); return; }
        if (s.last === null) dbg(`first packet: fps=${m.fps} frames=${m.ft.length} tg=${m.tg}`);
        if (s.tg === null) s.tg = m.tg; // the first packet sets the count the game already has
        else if (m.tg > s.tg) { s.tg = m.tg; dbg(`key press seen (count ${m.tg})`); toggle(instanceId); }
        s.last = m;
        s.lastAt = Date.now();
        if (m.ww > 0 && (!win || win.isDestroyed())) ensureWindow(); // made in advance (hidden), so that the key shows it at once
        if (shown && activeId === instanceId) { place(); push(s); }
      });
      socket.bind(0, '127.0.0.1', () => {
        s.port = socket.address().port;
        sessions.set(instanceId, s);
        dbg(`listening for ${instanceId} on 127.0.0.1:${s.port}`);
        resolve(s.port);
      });
    } catch {
      resolve(null);
    }
  });
}

// Before Horizon starts: the file in which the game writes where its control socket is (--control-socket). null = the overlay is not available.
function prepareHorizon(instanceId, keyLabel = 'F9', vk = 0) {
  if (process.platform !== 'win32') return null;
  try {
    release(instanceId);
    const dir = path.join(app.getPath('userData'), 'run');
    fs.mkdirSync(dir, { recursive: true });
    const endpointFile = path.join(dir, `horizon-control-${String(instanceId).replace(/[^A-Za-z0-9-]/g, '')}.json`);
    try { fs.rmSync(endpointFile, { force: true }); } catch { /* a stale file of an earlier run: the game replaces it */ }
    sessions.set(instanceId, {
      kind: 'horizon', endpointFile, vk, pid: null, last: null, lastAt: 0, cpu: -1, ramMb: -1, gpu: -1, vramMb: -1, gpuTemp: -1, keyLabel: String(keyLabel).slice(0, 20), control: null, keyProc: null,
    });
    dbg(`horizon ${instanceId}: control file ${endpointFile}`);
    return endpointFile;
  } catch {
    return null;
  }
}

// The game window and the overlay key of a Horizon game are watched by one small PowerShell for as long as the game runs
// (there is no agent in Horizon to tell either); its "K" lines are presses of the key while the game is in front.
function windowLine(f) {
  if (f[0] !== 'W' || f.length < 7) return false;
  const [l, t, r, b] = f.slice(1, 5).map(Number);
  if (![l, t, r, b].every(Number.isFinite) || r <= l || b <= t) return false;
  rect = { x: l, y: t, width: r - l, height: b - t };
  gameFocused = f[5] === '1' && f[6] === '0';
  minimized = f[6] === '1';
  return true;
}

function attachProcess(instanceId, pid) {
  const s = sessions.get(instanceId);
  if (!s || !Number.isInteger(pid) || pid <= 0) return;
  s.pid = pid;
  if (s.kind !== 'horizon') return;
  s.keyProc = runScript(WINDOW_SCRIPT(pid, s.vk), (f) => {
    if (f[0] === 'K') { dbg('horizon: overlay key pressed'); toggle(instanceId); return; }
    if (windowLine(f)) place();
  });
  s.control = horizonControl.watch(s.endpointFile, {
    onStats: ({ ft, gpuMs, cpuMs }) => {
      s.last = { ...(s.last || emptyHorizon()), ft, gpuMs, cpuMs };
      s.lastAt = Date.now();
      if (!win || win.isDestroyed()) ensureWindow();
      if (shown && activeId === instanceId) { place(); push(s); }
    },
    onStatus: ({ fps, chunks, mobs }) => {
      s.last = { ...(s.last || emptyHorizon()), fps, chk: chunks, ent: mobs };
      s.lastAt = Date.now();
    },
    onClose: () => { s.control = null; },
  });
}

const emptyHorizon = () => ({ fps: -1, ft: [], ent: -1, chk: -1, tps: -1, hu: -1, hm: -1, tg: 0, fo: -1, wx: 0, wy: 0, ww: 0, wh: 0, gpuMs: -1, cpuMs: -1 });

// The sample of the game's process (cpu share of the whole machine, memory of the process), from monitor.js
function onProcessSample(instanceId, sample) {
  const s = sessions.get(instanceId);
  if (!s || !sample) return;
  s.cpu = num(sample.cpu, 0, 100);
  s.ramMb = num(sample.ramMb, 0, 10000000);
}

function release(instanceId) {
  const s = sessions.get(instanceId);
  dbg(`release ${instanceId}: session ${s ? 'found' : 'none'}, active ${activeId === instanceId}`);
  if (!s) return;
  sessions.delete(instanceId);
  try { if (s.socket) s.socket.close(); } catch { /* already closed */ }
  try { if (s.control) s.control.close(); } catch { /* already closed */ }
  try { if (s.keyProc) s.keyProc.kill(); } catch { /* already gone */ }
  if (s.endpointFile) { try { fs.rmSync(s.endpointFile, { force: true }); } catch { /* ignore */ } }
  if (activeId === instanceId) hide();
}

function releaseAll() {
  for (const id of [...sessions.keys()]) release(id);
  if (win && !win.isDestroyed()) { win.destroy(); win = null; }
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: PANEL.width,
    height: PANEL.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false, // never takes the keyboard from the game
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', 'overlay', 'overlay-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setIgnoreMouseEvents(true); // clicks go through to the game
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html')).then(() => readConfig(sessions.get(activeId)?.keyLabel)).catch(() => {});
  win.on('closed', () => { win = null; shown = false; });
  return win;
}

function push(s) {
  if (!win || win.isDestroyed() || !s.last) return;
  win.webContents.send('overlay:metrics', {
    ...s.last, cpu: s.cpu, ramMb: s.ramMb, gpu: s.gpu, vramMb: s.vramMb, gpuTemp: s.gpuTemp, keyLabel: s.keyLabel,
  });
}

// ---- the game window and the GPU: two small PowerShells for as long as the overlay is on ----
// (the GPU counters take a good fraction of a second to read, so they run on their own and do not slow down the window tracking)
// vk (a Windows virtual-key code, 0 = none): also report each press of that key while the game window is in front ("K"), for games without an agent
const WINDOW_SCRIPT = (pid, vk = 0) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
'@
[void][W]::SetProcessDPIAware()
$p = ${pid}
$vk = ${Number(vk) || 0}
$was = $false
$n = 0
while ($true) {
  $proc = if ($n % 20 -eq 0 -or $h -eq $null) { Get-Process -Id $p } else { $proc }
  if (-not $proc) { break }
  $h = $proc.MainWindowHandle
  if ($h -ne [IntPtr]::Zero) {
    $fg = if ([W]::GetForegroundWindow() -eq $h) { 1 } else { 0 }
    if ($vk -ne 0) {
      $down = (([W]::GetAsyncKeyState($vk) -band 0x8000) -ne 0)
      if ($down -and -not $was -and $fg -eq 1) { [Console]::Out.WriteLine("K") }
      $was = $down
    }
    if ($vk -eq 0 -or $n % 4 -eq 0) {
      $r = New-Object W+RECT
      [void][W]::GetWindowRect($h, [ref]$r)
      $mi = if ([W]::IsIconic($h)) { 1 } else { 0 }
      [Console]::Out.WriteLine("W,$($r.L),$($r.T),$($r.R),$($r.B),$fg,$mi")
    }
  }
  $n++
  Start-Sleep -Milliseconds $(if ($vk -ne 0) { 25 } else { 120 })
}
`;

const GPU_SCRIPT = (pid) => `
$ErrorActionPreference = 'SilentlyContinue'
$p = ${pid}
while ($true) {
  if (-not (Get-Process -Id $p)) { break }
  $gpu = 0.0; $any = $false
  $e = (Get-Counter "\\GPU Engine(pid_$($p)_*)\\Utilization Percentage" -ErrorAction SilentlyContinue).CounterSamples
  foreach ($s in $e) { $any = $true; if ($s.InstanceName -like '*engtype_3D*' -or $s.InstanceName -like '*engtype_Graphics*') { $gpu += $s.CookedValue } }
  $vram = 0.0
  $m = (Get-Counter "\\GPU Process Memory(pid_$($p)_*)\\Dedicated Usage" -ErrorAction SilentlyContinue).CounterSamples
  foreach ($s in $m) { $vram += $s.CookedValue }
  if ($any) { [Console]::Out.WriteLine("G,$([math]::Round([math]::Min(100, $gpu), 1)),$([math]::Round($vram / 1MB))") }
  Start-Sleep -Milliseconds 500
}
`;

function runScript(script, onLine) {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let buf = '';
  ps.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) onLine(line.trim().split(','));
  });
  ps.on('error', () => {});
  return ps;
}

function startTracker(s) {
  stopTracker();
  if (!s || !s.pid || process.platform !== 'win32') return;
  let reported = false;
  // The game says where its window is (and whether it is in front) in every packet; the window tracker is started only when it does not.
  const gameSaysWhere = !!(s.last && s.last.ww > 0) || s.kind === 'horizon'; // Horizon's window is watched all the time by its own PowerShell
  if (!gameSaysWhere) trackers.push(runScript(WINDOW_SCRIPT(s.pid), (f) => {
    if (f[0] !== 'W' || f.length < 7) return;
    const [l, t, r, b] = f.slice(1, 5).map(Number);
    if (![l, t, r, b].every(Number.isFinite) || r <= l || b <= t) return;
    rect = { x: l, y: t, width: r - l, height: b - t };
    gameFocused = f[5] === '1' && f[6] === '0';
    minimized = f[6] === '1';
    if (!reported) { reported = true; dbg(`game window ${JSON.stringify(rect)} focused=${gameFocused}`); }
    place();
  }));
  startGpuTemperature(s);
  trackers.push(runScript(GPU_SCRIPT(s.pid), (f) => {
    if (f[0] !== 'G' || f.length < 3) return;
    s.gpu = num(Number(f[1]), 0, 100);
    s.vramMb = num(Number(f[2]), 0, 1000000);
  }));
}

// GPU temperature: only NVIDIA cards tell it without a driver of our own, through nvidia-smi that comes with the driver (one process that prints
// a line a second). Without it (AMD, Intel, no driver tools) the panel simply shows no temperature.
function startGpuTemperature(s) {
  try {
    const ps = spawn('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits', '-l', '1'], { windowsHide: true });
    let buf = '';
    ps.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      let hottest = -1;
      for (const line of lines) if (/^\d{1,3}$/.test(line.trim())) hottest = Math.max(hottest, Number(line.trim()));
      if (hottest >= 0 && hottest < 150) s.gpuTemp = hottest;
    });
    ps.on('error', () => {}); // no nvidia-smi: no temperature
    trackers.push(ps);
  } catch { /* no nvidia-smi */ }
}

function stopTracker() {
  for (const ps of trackers) { try { ps.kill(); } catch { /* gone */ } }
  trackers = [];
  rect = null;
  gameFocused = false;
  minimized = false;
  for (const s of sessions.values()) s.gpuTemp = -1;
}

// The panel sits in the top-left corner of the game window and is visible only while the game is in front. "In front" comes from the
// game itself (every tenth of a second, in each packet) when it says so, else from the window tracker.
function place() {
  if (!shown || !win || win.isDestroyed()) return;
  const s = sessions.get(activeId);
  const fromGame = s && s.last && s.last.ww > 0 && s.last.wh > 0 ? { x: s.last.wx, y: s.last.wy, width: s.last.ww, height: s.last.wh } : null;
  const where = fromGame || rect; // the game tells where its window is; the window tracker is only the fallback
  const inFront = s && s.last && s.last.fo >= 0 ? s.last.fo === 1 && !minimized : gameFocused;
  if (!where || !inFront) { if (win.isVisible()) win.hide(); return; }
  try {
    const dip = screen.screenToDipRect(null, where);
    const top = fromGame ? 16 : (dip.height > 700 ? 44 : 40); // the game's rectangle is the inside of the window, the tracker's includes the title bar
    const right = config.corner === 'tr' || config.corner === 'br';
    const bottom = config.corner === 'bl' || config.corner === 'br';
    const x = Math.round(right ? dip.x + dip.width - PANEL.width - 8 : dip.x + 8);
    const y = Math.round(bottom ? dip.y + dip.height - PANEL.height - 8 : dip.y + (top - 8));
    const cur = win.getBounds();
    if (cur.x !== x || cur.y !== y || cur.width !== PANEL.width || cur.height !== PANEL.height) win.setBounds({ x, y, width: PANEL.width, height: PANEL.height });
    if (!win.isVisible()) win.showInactive();
    if (!place.logged) { place.logged = true; dbg(`panel at ${x},${y} visible=${win.isVisible()}`); }
  } catch (err) { dbg(`place failed: ${err.message}`); }
}

function show(instanceId) {
  const s = sessions.get(instanceId);
  dbg(`show: session ${s ? 'ok' : 'missing'}, pid ${s ? s.pid : '-'}`);
  if (!s) return;
  activeId = instanceId;
  shown = true;
  ensureWindow();
  readConfig(s.keyLabel); // the player's size / view / corner are read again at every show
  startTracker(s);
  if (s.last) push(s);
}

function hide() {
  shown = false;
  stopTracker();
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

function toggle(instanceId) {
  if (shown && activeId === instanceId) hide(); else show(instanceId);
}

// A game that has stopped sending (it was closed, or is closing) must not leave the panel hanging over the desktop: no numbers for a moment
// hide it; when they come again it shows again by itself.
setInterval(() => {
  if (!shown || !win || win.isDestroyed() || !win.isVisible()) return;
  const s = sessions.get(activeId);
  if (!s || (s.lastAt && Date.now() - s.lastAt > 1500)) { win.hide(); dbg('hidden: the game has gone quiet'); }
}, 400).unref();

module.exports = { prepare, prepareHorizon, attachProcess, onProcessSample, release, releaseAll, toggle, sanitize };
