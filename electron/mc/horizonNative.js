// Native mods of a Horizon instance. A native mod (.hnmod) is Rust code compiled INTO the game, so it only runs in a
// game built together with it. Eternal doesn't carry a Rust toolchain and a copy of Horizon's source (that is gigabytes);
// it uses Horizon Launcher's own `native-build`, the way the "Minecraft RUST" launcher does:
//   horizon-launcher native-build --trust-native-code --profile <p>
// with HORIZON_HOME pointing at the Eternal instance's game folder (that is where Horizon Launcher reads the turned-on native
// mods from), HORIZON_LAUNCHER_HOME untouched (its toolchain and compile cache are reused). The result is a new installed
// version `native-…` in Horizon Launcher's versions folder; Eternal remembers its tag for the instance and plays it.
// Horizon Launcher also records the new build as what ITS OWN default instance plays; that setting is put back afterwards.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const horizonMods = require('./horizonMods');
const githubToken = require('./githubToken');

const PROFILES = {
  performance: { label: 'Производительная сборка', hint: 'Повседневная сборка для игры с модами' },
  dev: { label: 'Dev-сборка', hint: 'Для разработки мода: правки мода пересобираются примерно в 6 раз быстрее, игровая логика работает до двух раз медленнее' },
  release: { label: 'Release-сборка', hint: 'Дольше собирается, игра немного быстрее' },
};
const SITE = 'https://playhorizon.dev';

const launcherDir = () => process.env.HORIZON_LAUNCHER_HOME || path.join(app.getPath('appData'), 'horizon-launcher');
const versionsDir = () => path.join(launcherDir(), 'versions');
const buildLogPath = () => path.join(launcherDir(), 'native', 'build.log');
const validTag = (t) => typeof t === 'string' && /^native-[A-Za-z0-9._-]{1,100}$/.test(t);

// Horizon Launcher's executable: from its uninstall entry, else the usual place.
function launcherExe() {
  if (process.platform !== 'win32') return require('child_process').spawnSync('which', ['horizon-launcher'], { encoding: 'utf8' }).stdout?.trim() || null;
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = spawnSync('reg', ['query', root, '/s', '/f', 'Horizon Launcher', '/d'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).stdout || '';
    } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(InstallLocation|DisplayIcon)\s+REG_SZ\s+(.+?)\s*$/.exec(raw);
      if (!m) continue;
      let value = m[2].split(',')[0].replace(/^"|"$/g, '');
      if (!/\.exe$/i.test(value)) value = path.join(value, 'horizon-launcher.exe');
      if (path.basename(value).toLowerCase() === 'horizon-launcher.exe' && fs.existsSync(value)) return value;
    }
  }
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Horizon Launcher', 'horizon-launcher.exe');
  return local && fs.existsSync(local) ? local : null;
}

// native-mods.json of a built version: what it was made from.
function buildOf(tag) {
  if (!validTag(tag)) return null;
  const dir = path.join(versionsDir(), tag);
  if (!fs.existsSync(path.join(dir, (process.platform === "win32" ? "horizon-client.exe" : "horizon-client")))) return null;
  let v;
  try { v = JSON.parse(fs.readFileSync(path.join(dir, 'native-mods.json'), 'utf8')); } catch { return null; }
  const take = (k) => (Array.isArray(v[k]) ? v[k] : []).filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, version: String(m.version ?? '') }));
  return {
    tag, dir, base: String(v.base || ''), mods: [...take('mods'), ...take('left_out')], leftOut: take('left_out').map((m) => m.id),
  };
}

// 'none' (no native mod turned on) | 'notBuilt' | 'outdated' | 'upToDate' — as Horizon Launcher's Mods page says it.
function stateOf(enabled, built) {
  if (!enabled.length) return 'none';
  if (!built) return 'notBuilt';
  const key = (list) => [...new Set(list.map((m) => `${m.id}@${m.version}`))].sort().join('|');
  return key(built.mods) === key(enabled) ? 'upToDate' : 'outdated';
}

function enabledNative(game) {
  return horizonMods.list(game).filter((m) => m.kind === 'native' && m.enabled).map((m) => ({ id: m.id, version: m.version }));
}

function status(instance, game, profile) {
  const enabled = enabledNative(game);
  const built = instance.horizonNative ? buildOf(instance.horizonNative.tag) : null;
  const state = stateOf(enabled, built);
  return {
    state,
    enabled,
    tag: built ? built.tag : null,
    dir: built ? built.dir : null,
    mods: built ? built.mods : [],
    leftOut: built ? built.leftOut : [],
    profile: PROFILES[profile] ? profile : 'performance',
    launcherFound: !!launcherExe(),
  };
}

// ---- Horizon Launcher's instance list: which version its own default instance plays ----

const instancesFile = () => path.join(launcherDir(), 'instances.json');
function readInstances() { try { return JSON.parse(fs.readFileSync(instancesFile(), 'utf8')); } catch { return null; } }
function playedTag() { const v = readInstances(); return v?.instances?.horizon?.version ?? null; }
function setPlayedTag(tag) {
  const v = readInstances();
  if (!v || !v.instances || typeof v.instances !== 'object') return;
  if (!v.instances.horizon || typeof v.instances.horizon !== 'object') v.instances.horizon = {};
  if (tag == null) delete v.instances.horizon.version; else v.instances.horizon.version = tag;
  const tmp = `${instancesFile()}.eternal.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, instancesFile());
}

// The compiler's environment: the game folder, and the GitHub token when the player has set one (see githubToken.js).
function compilerEnv(game) {
  const env = { ...process.env, HORIZON_HOME: game };
  const token = githubToken.get();
  if (token) { env.HORIZON_GITHUB_TOKEN = token; env.GITHUB_TOKEN = token; }
  return env;
}

// Runs the build. onStep(text) gets each step ("[ 1:23] Compiling…" -> "Compiling…").
// Resolves { ok:true, tag, line } | { ok:false, mismatch?, error }.
function build({ game, profile, allowMismatch, onStep }) {
  return new Promise((resolve) => {
    const exe = launcherExe();
    if (!exe) { resolve({ ok: false, error: 'Не нашёл Horizon Launcher: его компилятор нужен для нативных модов.', noLauncher: true }); return; }
    if (!PROFILES[profile]) { resolve({ ok: false, error: 'Неизвестный профиль сборки' }); return; }
    const before = playedTag();
    const args = ['native-build', '--trust-native-code', '--profile', profile];
    if (allowMismatch) args.push('--allow-version-mismatch');
    let child;
    try {
      child = spawn(exe, args, {
        env: compilerEnv(game),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) { resolve({ ok: false, error: `Не удалось запустить Horizon Launcher: ${err.message}` }); return; }
    let out = '';
    let errBuf = '';
    const errors = [];
    const onErrLine = (line) => {
      const t = line.trim();
      if (!t) return;
      const m = /^\[\s*\d+:\d+\]\s*(.*)$/.exec(t);
      if (m) onStep?.(m[1].trim()); else errors.push(t);
    };
    child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.stderr.on('data', (d) => {
      errBuf += d;
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop();
      lines.forEach(onErrLine);
    });
    child.on('error', (err) => resolve({ ok: false, error: `Не удалось запустить Horizon Launcher: ${err.message}` }));
    child.on('exit', (code) => {
      if (errBuf.trim()) onErrLine(errBuf);
      // The build made Horizon Launcher's own default instance play the new version; give it back what it had.
      const after = playedTag();
      const newTag = after && after !== before && validTag(after) ? after : null;
      if (after !== before) { try { setPlayedTag(before); } catch { /* best effort */ } }
      if (code === 0) {
        const tag = newTag || (validTag(after) ? after : null);
        if (!tag || !buildOf(tag)) { resolve({ ok: false, error: 'Сборка завершилась, но новая версия не найдена в Horizon Launcher' }); return; }
        resolve({ ok: true, tag, line: out.trim().split(/\r?\n/).pop() || '' });
        return;
      }
      const text = errors.join('\n');
      if (text.includes('allow-version-mismatch')) {
        const list = text.split('\n').map((l) => l.replace(/^Error:\s*/, '').split(' They often still build')[0]).join('\n');
        resolve({ ok: false, mismatch: list, error: 'Моды сделаны для разных версий Horizon' });
        return;
      }
      const last = text.split('\n').slice(-6).join('\n');
      resolve({ ok: false, error: last || `Компиляция не удалась (код ${code})` });
    });
  });
}

// The end of the build log Horizon Launcher keeps, for "what went wrong".
function logTail(lines = 60) {
  try { return fs.readFileSync(buildLogPath(), 'utf8').split(/\r?\n/).slice(-lines).join('\n'); } catch { return ''; }
}

module.exports = {
  PROFILES, SITE, launcherExe, status, build, buildOf, logTail, validTag, versionsDir, stateOf, compilerEnv,
};
