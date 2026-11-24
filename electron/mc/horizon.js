// Horizon: Minecraft Java Edition rewritten in Rust (github.com/horizon-rust/horizon). A "Rust" instance
// plays it through Horizon's own programs, the same way the "Minecraft RUST" launcher does:
//   1. latest nightly from GitHub: the archive's SHA-256 must be listed in SHA256SUMS, and SHA256SUMS must
//      carry an Ed25519 signature by one of Horizon's release keys (verified here, before anything is unpacked);
//   2. `horizon-prepare --launch-api` says which Minecraft version and Java it wants;
//   3. Mojang's files for that version (client, libraries, assets, the server jar horizon-prepare reads once),
//      every file checked against Mojang's SHA-1, and a JDK of the right major (Adoptium, else Microsoft's);
//   4. `horizon-prepare --prepare ... --complete`, then `horizon-client`, the session going in through stdin only.
// Everything lives in <userData>/horizon, apart from the normal Minecraft folders.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const javaLib = require('./java');
const { downloadAll, downloadFile } = require('./download');
const { collectOverrideJobs, extractJobs } = require('./zipExtract');
const { rulesAllow } = require('./rules');
const { assertVersionString, safeJoin } = require('./safe');
const gameProc = require('./gameProc');

const fsp = fs.promises;
const REPO = 'horizon-rust/horizon';
// crates/horizon-release-sign/release-keys.txt in the Horizon repository
const RELEASE_KEYS = ['MU4oiIQcCxkZvbwSjjXs7SySCuM6ywRQ3nGaJYZG0gw='];
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const isWin = process.platform === 'win32';
const ASSET = isWin ? (process.arch === 'arm64' ? 'horizon-windows-arm64.zip' : 'horizon-windows-x64.zip') : (process.arch === 'arm64' ? 'horizon-linux-arm64.zip' : 'horizon-linux-x64.zip');
const CLIENT_EXE = isWin ? 'horizon-client.exe' : 'horizon-client';
const PREPARE_EXE = isWin ? 'horizon-prepare.exe' : 'horizon-prepare';
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const OCTET = 'application/octet-stream';
// What Horizon implements (shown until the first launch tells the exact version).
const DEFAULT_MC_VERSION = '26.3';

const ua = () => `EternalLauncher/${app.getVersion()}`;
const root = () => paths.horizonRoot();
const versionsDir = () => paths.ensureDir(path.join(root(), 'versions'));
const javaDir = () => paths.ensureDir(path.join(root(), 'java'));
const minecraftDir = () => paths.ensureDir(path.join(root(), 'minecraft'));
const serverJarPath = (mc) => path.join(root(), 'servers', mc, 'server.jar');

function assertSupported() {
  if (!isWin) { try { fs.chmodSync(path.join(versionsDir(), 'local', CLIENT_EXE), 0o755); fs.chmodSync(path.join(versionsDir(), 'local', PREPARE_EXE), 0o755); } catch {} }
}

// ---------- small helpers ----------

async function http(url, { accept, timeout = 25000 } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': ua(), ...(accept ? { Accept: accept } : {}) },
  });
  if (!res.ok) throw new Error(`${url} ответил ${res.status}`);
  return res;
}

const httpJson = async (url, opts) => (await http(url, opts)).json();

// SHA-256 of a download, streamed to disk with a size cap; the file only appears under its name when it matches.
async function downloadChecked(url, dest, sha256, { accept, onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000); // connecting + headers; the body may take long
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': ua(), ...(accept ? { Accept: accept } : {}) } });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Не удалось скачать (${res.status}): ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_ARCHIVE_BYTES) throw new Error('Файл слишком большой');
  const part = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let loaded = 0;
  let last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      if (loaded > MAX_ARCHIVE_BYTES) { reader.cancel().catch(() => {}); throw new Error('Файл слишком большой'); }
      hash.update(value);
      // eslint-disable-next-line no-await-in-loop
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - last > 150) { last = now; onProgress(loaded, total); }
    }
    await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
  } catch (err) {
    out.destroy();
    await fsp.rm(part, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== String(sha256).toLowerCase()) {
    await fsp.rm(part, { force: true });
    throw new Error('Скачанный файл повреждён или подменён (не совпала контрольная сумма SHA-256)');
  }
  await fsp.rename(part, dest);
  onProgress?.(loaded, total || loaded);
}

// Tries each place a file can be fetched from; reports every failure when all of them fail.
async function downloadFromAny(sources, dest, sha256, opts) {
  const errors = [];
  for (const s of sources) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await downloadChecked(s.url, dest, sha256, { accept: s.accept, onProgress: opts?.onProgress });
      return;
    } catch (err) { errors.push(err.message); }
  }
  throw new Error(errors.join('\n'));
}

// MB-based progress for the launch screen ("Загрузка … 12 / 180").
const mbProgress = (stage, report) => (loaded, total) => report({
  stage, completed: Math.round(loaded / 1048576), total: total ? Math.max(2, Math.round(total / 1048576)) : 0,
});

function findDirWith(rootDir, file, depth) {
  if (fs.existsSync(path.join(rootDir, file))) return rootDir;
  if (depth <= 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findDirWith(path.join(rootDir, e.name), file, depth - 1);
    if (found) return found;
  }
  return null;
}

async function unzipTo(archive, dest, { onProgress } = {}) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  const zip = new AdmZip(archive);
  await extractJobs(collectOverrideJobs(zip, [''], dest), {
    onProgress: onProgress && (({ completed, total }) => onProgress(completed, total)),
  });
}

// ---------- Horizon builds (GitHub nightly) ----------

// The folder a build lives in: named after its archive's checksum, so it is plain and the same however
// the release was found (GitHub's API or the direct links).
function tagForBuild(sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('Странная контрольная сумма Horizon');
  return `nightly-${sha256.slice(0, 12)}`;
}

// SHA256SUMS.sig: one base64 signature per line over "horizon release <tag>\n" + SHA256SUMS;
// any line verifying with any release key is enough.
function verifySignature(tag, sums, sigs, keys = RELEASE_KEYS) {
  const message = Buffer.concat([Buffer.from(`horizon release ${tag}\n`), Buffer.from(sums)]);
  const publicKeys = keys.map((k) => {
    const raw = Buffer.from(k, 'base64');
    return raw.length === 32 ? crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' }) : null;
  }).filter(Boolean);
  for (const line of String(sigs).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const sig = Buffer.from(line, 'base64');
    if (sig.length !== 64) continue;
    if (publicKeys.some((k) => crypto.verify(null, message, k, sig))) return;
  }
  throw new Error('Подпись релиза Horizon не прошла проверку: файл не устанавливается');
}

function checksumFor(sums, file) {
  for (const line of String(sums).split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name && name.replace(/^\*/, '') === file && /^[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
  }
  return null;
}

const githubOnly = (u, hosts) => {
  const url = new URL(u);
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) throw new Error('Неожиданный адрес файла в релизе Horizon');
  return u;
};

// A release file can be fetched through the API address (GitHub's asset servers) or the direct link;
// github.com/.../download/... answers 504 in some networks even when the API works, so the API goes first.
const assetSources = (a) => [
  { url: githubOnly(a.url, ['api.github.com']), accept: OCTET },
  { url: githubOnly(a.browser_download_url, ['github.com']) },
];

async function textFrom(sources) {
  const errors = [];
  for (const s of sources) {
    try { return await (await http(s.url, { accept: s.accept })).text(); } catch (err) { errors.push(err.message); }
  }
  throw new Error(errors.join('\n'));
}

// The newest nightly, checked (signature) but not downloaded.
// GitHub's API answers 403 once an address has made 60 requests in an hour (shared networks hit that), while the
// direct release links have no such limit — so the API is only a first choice, and the direct links always work as the fallback.
// The releases a player may pick: the rolling "nightly" and the dated ones ("nightly-2026-11-13").
const RELEASE_TAG_RE = /^nightly(-\d{4}-\d{2}-\d{2}(-[A-Za-z0-9]{1,12})?)?$/;
const isReleaseTag = (t) => typeof t === 'string' && RELEASE_TAG_RE.test(t);

let releasesCache = null;
// [{ tag, label, date }], newest first: "nightly" (always the latest) is not in the list, the UI offers it as "Последняя".
async function listReleases(force = false) {
  if (releasesCache && !force && Date.now() - releasesCache.at < 10 * 60 * 1000) return releasesCache.list;
  const all = await httpJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { accept: 'application/vnd.github+json' });
  const list = (Array.isArray(all) ? all : [])
    .filter((r) => r && !r.draft && isReleaseTag(r.tag_name) && r.tag_name !== 'nightly' && (r.assets || []).some((a) => a.name === ASSET))
    .map((r) => ({ tag: r.tag_name, date: String(r.published_at || '').slice(0, 10), label: r.tag_name.replace(/^nightly-/, '') }))
    .sort((a, b) => (a.tag < b.tag ? 1 : -1));
  releasesCache = { at: Date.now(), list };
  return list;
}

async function latest(releaseTag = 'nightly') {
  assertSupported();
  if (!isReleaseTag(releaseTag)) throw new Error('Некорректная версия Horizon');
  let release = null;
  try {
    release = await httpJson(`https://api.github.com/repos/${REPO}/releases/tags/${releaseTag}`, { accept: 'application/vnd.github+json' });
  } catch { /* the direct links below */ }
  const sourcesOf = (name) => {
    if (!release) return [{ url: `https://github.com/${REPO}/releases/download/${releaseTag}/${name}` }];
    const a = (release.assets || []).find((x) => x.name === name);
    if (!a) throw new Error(`В релизе Horizon нет файла ${name}`);
    return assetSources(a);
  };
  const sums = await textFrom(sourcesOf('SHA256SUMS'));
  const sigs = await textFrom(sourcesOf('SHA256SUMS.sig'));
  // A dated release is the archived copy of what was published as "nightly": its signature was made under that name. Either name is
  // accepted, but the signature must still be one of Horizon's release keys over exactly these checksums.
  const names = [...new Set([release?.tag_name || releaseTag, releaseTag, 'nightly'])];
  let signed = false;
  let lastError = null;
  for (const name of names) {
    try { verifySignature(name, sums, sigs); signed = true; break; } catch (err) { lastError = err; }
  }
  if (!signed) throw lastError;
  const sha256 = checksumFor(sums, ASSET);
  if (!sha256) throw new Error(`${ASSET} нет в SHA256SUMS`);
  return { tag: tagForBuild(sha256), sha256, sources: sourcesOf(ASSET) };
}

function readBuild(dir) {
  const tag = path.basename(dir);
  if (!fs.existsSync(path.join(dir, '.installed')) || !fs.existsSync(path.join(dir, CLIENT_EXE))) return null;
  return { tag, dir };
}

// Installed builds, newest first.
function listBuilds() {
  let names = [];
  try { names = fs.readdirSync(versionsDir()); } catch { return []; }
  return names.filter((n) => !n.startsWith('.')).map((n) => readBuild(path.join(versionsDir(), n))).filter(Boolean)
    .sort((a, b) => (a.tag < b.tag ? 1 : -1));
}

async function installBuild(info, report) {
  const dir = path.join(versionsDir(), info.tag);
  const existing = readBuild(dir);
  if (existing) return existing;
  const archive = path.join(versionsDir(), `.${info.tag}.zip`);
  const tmp = path.join(versionsDir(), `.${info.tag}.unpacking`);
  await downloadFromAny(info.sources, archive, info.sha256, { onProgress: mbProgress('horizon-build', report) });
  report({ stage: 'horizon-unpack' });
  await unzipTo(archive, tmp);
  const top = findDirWith(tmp, CLIENT_EXE, 3);
  if (!top) throw new Error(`В архиве Horizon нет ${CLIENT_EXE}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(top, dir);
  await fsp.writeFile(path.join(dir, '.installed'), '');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(archive, { force: true });
  return readBuild(dir);
}

// ---------- Java ----------

function findJavaHome(rootDir) {
  const bin = findDirWith(rootDir, path.join('bin', isWin ? 'java.exe' : 'java'), 4);
  return bin;
}

async function unpackJava(link, sha256, home, report) {
  const archive = `${home}.zip`;
  await downloadChecked(link, archive, sha256, { onProgress: mbProgress('horizon-java', report) });
  const tmp = `${home}.unpacking`;
  await unzipTo(archive, tmp);
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rename(tmp, home);
  await fsp.rm(archive, { force: true });
  const found = findJavaHome(home);
  if (!found) throw new Error('В архиве Java нет bin/java.exe');
  return found;
}

// First choice: Eclipse Temurin (Adoptium). Its files sit on github.com, which answers 504 in some networks,
// so the fallback is the Microsoft Build of OpenJDK from Microsoft's own servers. Both are full JDKs.
async function ensureJava(major, mojangComponent, report) {
  assertSupported();
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new Error('Странная версия Java');
  // Mojang's own runtime for this Minecraft version comes first: it is the same Java the official launcher
  // uses, it has javac, and Mojang's CDN is many times faster than GitHub/Microsoft where those are throttled.
  if (typeof mojangComponent === 'string' && /^[a-z0-9-]{3,40}$/.test(mojangComponent)) {
    try {
      const exe = await javaLib.ensureManagedRuntime(mojangComponent, ({ completed, total }) => {
        report({ stage: 'horizon-java', completed, total });
      });
      return path.dirname(path.dirname(exe));
    } catch { /* the vendors below */ }
  }
  for (const vendor of ['temurin', 'microsoft']) {
    const found = findJavaHome(path.join(javaDir(), `${vendor}-${major}`));
    if (found) return found;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  let adoptium;
  try {
    const list = await httpJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=${isWin ? 'windows' : 'linux'}&vendor=eclipse`);
    const pkg = list?.[0]?.binary?.package;
    if (!pkg?.link || !pkg?.checksum) throw new Error(`Adoptium не нашёл Java ${major}`);
    githubOnly(pkg.link, ['github.com', 'api.adoptium.net', 'objects.githubusercontent.com']);
    return await unpackJava(pkg.link, pkg.checksum, path.join(javaDir(), `temurin-${major}`), report);
  } catch (err) { adoptium = err; }
  try {
    const link = `https://aka.ms/download-jdk/microsoft-jdk-${major}-windows-${arch}.zip`;
    const text = await (await http(`${link}.sha256sum.txt`)).text();
    const sum = text.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(sum || '')) throw new Error('в ответе Microsoft нет SHA-256');
    return await unpackJava(link, sum.toLowerCase(), path.join(javaDir(), `microsoft-${major}`), report);
  } catch (microsoft) {
    throw new Error(`Не удалось скачать Java ${major}.\nAdoptium: ${adoptium.message}\nMicrosoft: ${microsoft.message}`);
  }
}

// ---------- Mojang's files for the version Horizon plays ----------

// The exact game files Horizon was built against (research-lock.json inside the build). Mojang republishes a
// version's JSON now and then (only the asset index changes), and horizon-prepare accepts just the ones it knows,
// so the pinned JSON is fetched by its SHA-1 — Mojang keeps every published file under its hash.
function readLock(buildDir, version) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(buildDir, 'research-lock.json'), 'utf8'));
    const m = lock.minecraft;
    if (m?.version !== version || !/^[0-9a-f]{40}$/.test(String(m.manifest_sha1))) return null;
    return m;
  } catch { return null; }
}

async function installMinecraftFiles(version, buildDir, report) {
  assertVersionString(version, 'версия Minecraft');
  const mc = minecraftDir();
  report({ stage: 'horizon-minecraft' });
  const pinned = readLock(buildDir, version);
  const versionDir = path.join(mc, 'versions', version);
  const versionJsonPath = path.join(versionDir, `${version}.json`);
  const candidates = [];
  if (pinned) candidates.push({ url: `https://piston-meta.mojang.com/v1/packages/${pinned.manifest_sha1}/${version}.json`, sha1: pinned.manifest_sha1 });
  try {
    const manifest = await httpJson(MANIFEST_URL);
    const entry = (manifest.versions || []).find((v) => v.id === version);
    if (entry) candidates.push({ url: entry.url, sha1: entry.sha1 });
  } catch (err) { if (!candidates.length) throw err; }
  if (!candidates.length) throw new Error(`Mojang не знает версию ${version}`);
  let fetched = false;
  const failures = [];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await downloadFile(c.url, versionJsonPath, { expectedSha1: c.sha1 });
      fetched = true;
      break;
    } catch (err) { failures.push(err.message); }
  }
  if (!fetched) throw new Error(`Не удалось получить описание версии ${version}: ${failures.join('; ')}`);
  const meta = JSON.parse(await fsp.readFile(versionJsonPath, 'utf8'));
  if (pinned && (meta.downloads?.client?.sha1 !== pinned.client_sha1 || meta.downloads?.server?.sha1 !== pinned.server_sha1)) {
    throw new Error('Файлы Minecraft у Mojang не совпадают с теми, под которые собран Horizon. Дождитесь новой сборки Horizon.');
  }

  const tasks = [];
  const add = (url, dest, sha1, size, label) => { if (url && sha1) tasks.push({ url, dest, sha1, size, label }); };
  add(meta.downloads?.client?.url, path.join(versionDir, `${version}.jar`), meta.downloads?.client?.sha1, meta.downloads?.client?.size, 'client');
  add(meta.downloads?.server?.url, serverJarPath(version), meta.downloads?.server?.sha1, meta.downloads?.server?.size, 'server');
  for (const lib of meta.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const art = lib.downloads?.artifact;
    if (!art?.path || !art.url || !art.sha1) continue;
    let dest;
    try { dest = safeJoin(path.join(mc, 'libraries'), art.path); } catch { continue; } // a path from the metadata must stay inside
    add(art.url, dest, art.sha1, art.size, art.path);
  }
  const idx = meta.assetIndex;
  if (!idx?.id) throw new Error('У версии нет assetIndex');
  assertVersionString(String(idx.id), 'индекс ресурсов');
  const indexPath = path.join(mc, 'assets', 'indexes', `${idx.id}.json`);
  await downloadFile(idx.url, indexPath, { expectedSha1: idx.sha1, expectedSize: idx.size });
  const assets = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  for (const obj of Object.values(assets.objects || {})) {
    // An asset's file name is its SHA-1: 40 hex digits, nothing else may become a path.
    if (!/^[0-9a-f]{40}$/.test(String(obj.hash))) continue;
    const prefix = obj.hash.slice(0, 2);
    add(`${RESOURCES_URL}/${prefix}/${obj.hash}`, path.join(mc, 'assets', 'objects', prefix, obj.hash), obj.hash, obj.size, obj.hash);
  }
  report({ stage: 'horizon-minecraft', completed: 0, total: tasks.length });
  await downloadAll(tasks, {
    concurrency: 16,
    onProgress: ({ completed, total }) => report({ stage: 'horizon-minecraft', completed, total }),
  });
  return meta;
}

// ---------- horizon-prepare / horizon-client ----------

const quiet = { windowsHide: true };

function runCollect(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { ...quiet, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.length > 1024 * 1024) child.kill(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// What `horizon-prepare --launch-api` says: the Minecraft version and the Java it wants.
async function prepareInfo(prepareExe) {
  const { code, out } = await runCollect(prepareExe, ['--launch-api']);
  if (code !== 0) throw new Error(`horizon-prepare --launch-api: код ${code}`);
  let v;
  try { v = JSON.parse(out); } catch { throw new Error('Неожиданный ответ horizon-prepare --launch-api'); }
  if (!String(v.launch_api || '').startsWith('0.1.')) {
    throw new Error(`Эта сборка Horizon говорит на Launch API ${v.launch_api}, а лаунчер знает 0.1.x: обновите Eternal Launcher`);
  }
  if (typeof v.minecraft !== 'string') throw new Error('horizon-prepare не назвал версию Minecraft');
  assertVersionString(v.minecraft, 'версия Minecraft');
  const javaMajor = Number(v.java_major);
  if (!Number.isInteger(javaMajor)) throw new Error('horizon-prepare не назвал версию Java');
  return { minecraft: v.minecraft, javaMajor };
}

async function resourcesReady(prepareExe, resources) {
  const { code } = await runCollect(prepareExe, ['--check', '--output', resources]);
  return code === 0;
}

function runPrepare(prepareExe, serverJar, mcDir, javaHome, resources, onFraction) {
  return new Promise((resolve, reject) => {
    const child = spawn(prepareExe, [
      '--prepare', '--server-jar', serverJar, '--minecraft-dir', mcDir, '--java-home', javaHome,
      '--output', resources, '--complete', '--progress', 'json',
    ], { ...quiet, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let lastError = null;
    let fraction = null;
    const onLine = (line) => {
      let v;
      try { v = JSON.parse(line); } catch { return; }
      if (typeof v.fraction === 'number') fraction = v.fraction;
      if (typeof v.error === 'string') lastError = v.error;
      onFraction(fraction, typeof v.message === 'string' ? v.message : '');
    };
    child.stdout.on('data', (d) => {
      buffer += d;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(onLine);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (buffer.trim()) onLine(buffer);
      if (code === 0) resolve();
      else reject(new Error(`Подготовка ресурсов не удалась: ${lastError || `код ${code}`}`));
    });
  });
}

// Which build an instance plays: the one picked last, else the newest installed, else the newest on GitHub.
// At most once a day it also looks for a newer nightly (a failed look never blocks starting an installed build).
// A build pinned by an instance ("play exactly this release") stays on disk and is not what "the latest" falls back to.
const pinnedTags = (store) => new Set(Object.values((store.get('horizon') || {}).pins || {}).filter((t) => typeof t === 'string'));

// The build of a release the instance is pinned to: installed once, then used as it is (a dated release does not change, so
// there is no daily check). `releaseTag` is a tag from listReleases().
async function resolvePinned(store, report, releaseTag) {
  const state = store.get('horizon') || {};
  const pins = state.pins || {};
  const known = pins[releaseTag] && listBuilds().find((b) => b.tag === pins[releaseTag]);
  if (known) return known;
  report({ stage: 'horizon-check' });
  const info = await latest(releaseTag);
  const build = listBuilds().find((b) => b.tag === info.tag) || await installBuild(info, report);
  store.set('horizon', { ...(store.get('horizon') || {}), pins: { ...pins, [releaseTag]: build.tag } });
  return build;
}

async function resolveBuild(store, report, { canPrune = () => true } = {}, pinTag = null) {
  if (pinTag) {
    if (!isReleaseTag(pinTag)) throw new Error('Некорректная версия Horizon у этой сборки');
    if (pinTag !== 'nightly') return resolvePinned(store, report, pinTag);
  }
  const state = store.get('horizon') || {};
  const pinned = pinnedTags(store);
  const builds = listBuilds();
  let played = builds.find((b) => b.tag === state.played) || builds.find((b) => !pinned.has(b.tag)) || null;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (!played || !(state.checkedAt > dayAgo)) {
    report({ stage: 'horizon-check' });
    try {
      const info = await latest();
      store.set('horizon', { ...(store.get('horizon') || {}), checkedAt: Date.now() });
      if (!played || played.tag !== info.tag) {
        const installed = builds.find((b) => b.tag === info.tag) || await installBuild(info, report);
        played = installed;
        store.set('horizon', { ...(store.get('horizon') || {}), played: installed.tag });
        if (canPrune()) {
          const keep = pinnedTags(store);
          for (const b of listBuilds()) {
            if (b.tag !== installed.tag && !keep.has(b.tag)) fs.rmSync(b.dir, { recursive: true, force: true });
          }
        }
      }
    } catch (err) {
      if (!played) throw err;
    }
  }
  if (!played) throw new Error('Не удалось установить Horizon');
  if (state.played !== played.tag) store.set('horizon', { ...(store.get('horizon') || {}), played: played.tag });
  return played;
}

// Everything up to the moment the game can start: build, Java, Mojang files, prepared resources.
// `nativeBuild` ({ tag, dir }): a game built with this instance's native mods (see horizonNative.js) plays instead of the nightly.
// `pinTag`: the Horizon release this instance is set to play (null / 'nightly' = the latest, kept up to date by the launcher).
async function prepareInstance(store, report, opts, nativeBuild, pinTag = null) {
  assertSupported();
  const build = nativeBuild || await resolveBuild(store, report, opts, pinTag);
  const prepareExe = path.join(build.dir, PREPARE_EXE);
  const clientExe = path.join(build.dir, CLIENT_EXE);
  const info = await prepareInfo(prepareExe);
  const resources = path.join(build.dir, '.local', 'horizon-client', info.minecraft);
  report({ stage: 'horizon-resources' });
  if (!await resourcesReady(prepareExe, resources)) {
    const meta = await installMinecraftFiles(info.minecraft, build.dir, report);
    const component = meta.javaVersion?.majorVersion === info.javaMajor ? meta.javaVersion.component : null;
    const javaHome = await ensureJava(info.javaMajor, component, report);
    await runPrepare(prepareExe, serverJarPath(info.minecraft), minecraftDir(), javaHome, resources, (fraction, message) => {
      report({
        stage: 'horizon-prepare', completed: fraction == null ? 0 : Math.round(fraction * 100), total: fraction == null ? 0 : 100, message,
      });
    });
  }
  report({ stage: 'ready' });
  return { build, clientExe, resources, minecraft: info.minecraft };
}

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;

// Starts horizon-client as a separate process that outlives the launcher (output goes to a file, see gameProc.js — a Rust
// println! into a closed pipe would panic). A Microsoft account goes in through stdin only (never the command line or disk),
// an offline one as --name. onLine gets each output line, onExit({ code, signal }). `prepared.clientExe` may be the branded
// copy "Minecraft Rust (H).exe" (see horizonBrand.js).
function launchProcess(prepared, gameDir, account, settings, quickPlay, onLine, onExit, instanceId = 'horizon', extraEnv = null, controlFile = null) {
  const online = account.type === 'microsoft';
  if (!online && !OFFLINE_NAME.test(String(account.name || ''))) {
    throw new Error(`Ник ${account.name} не подходит для Horizon: 3–16 латинских букв, цифр или _`);
  }
  fs.mkdirSync(gameDir, { recursive: true });
  const width = Math.min(Math.max(Number(settings.windowWidth) || 854, 320), 7680);
  const height = Math.min(Math.max(Number(settings.windowHeight) || 480, 240), 4320);
  const args = [
    '--resources', prepared.resources, '--game-dir', gameDir, '--home', gameDir,
    '--width', String(width), '--height', String(height),
    ...(online ? ['--session-stdin'] : ['--name', account.name]),
  ];
  if (quickPlay?.type === 'server' && quickPlay.target) args.push('--quickPlayMultiplayer', String(quickPlay.target));
  // The game's control socket (a .json file means a local TCP port behind a token, written there by the game): the overlay reads FPS from it
  if (controlFile && /\.json$/i.test(controlFile)) args.push('--control-socket', controlFile);
  const child = gameProc.startDetached({
    exe: prepared.clientExe,
    args,
    cwd: path.dirname(prepared.clientExe),
    stdin: online ? 'pipe' : 'ignore',
    instanceId,
    env: extraEnv,
    onLine,
    onExit,
    onError: (err) => onLine?.(`[launcher] Не удалось запустить Horizon: ${err.message}\n`),
  });
  if (online) {
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({
      name: account.name, uuid: account.id, access_token: account.minecraftAccessToken, user_type: 'msa',
    }));
  }
  return child;
}
module.exports = {
  DEFAULT_MC_VERSION,
  prepareInstance,
  launchProcess,
  downloadChecked,
  // exposed for tests
  tagForBuild,
  verifySignature,
  checksumFor,
  latest,
  listReleases,
  isReleaseTag,
  installBuild,
  listBuilds,
};
