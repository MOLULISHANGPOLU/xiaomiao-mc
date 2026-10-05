// launch.mjs（本文件在 1-程序\底层 下）
// 小喵一键开玩：① 确保 MC 服务端在跑（无窗口）
//                ② 确保小喵的"真身"在跑（无窗口的隐身语音客户端 launch-mew.mjs）
//                ③ 解出加密票据 → LittleSkin 续期 → 用 javaw 无窗口启动游戏并自动进服
// 用法: node launch.mjs [--dry] [--skip-server] [--skip-bot] [--bot]
// 2026-10-04 §9-④：默认不再起 Carpet 假人（假人没有语音、还会和真身重名）→ 改起真身；
//                   想回老路子加 --bot 即可。
// 日志: launch.log（本文件所在目录）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { need, load } = createRequire(import.meta.url)('../cfg.cjs');

const DIR = __dirname;
const LOG = path.join(DIR, 'launch.log');
const SESS = path.join(DIR, 'session.dat');
const ACC = path.join(DIR, 'account.txt');
const MC = need('paths', 'minecraftDir');
const VER = load().paths.userVersionDir || '小喵的家';
const VERDIR = path.join(MC, 'versions', VER);
const BAT = load().paths.pclBat;
const SRV_DIR = need('paths', 'serverDir');
const SRV_LOG = path.join(SRV_DIR, '..', 'server.log');
const JAVA25 = need('paths', 'clientJava');
const JAVA25W = JAVA25.replace(/java\.exe$/, 'javaw.exe');
const API = load().paths.authlibUrl || 'https://littleskin.cn/api/yggdrasil';
const UA = 'LittleMewLauncher/1.0 (node; +https://littleskin.cn)';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SKIP_SERVER = args.includes('--skip-server');
const SKIP_BOT = args.includes('--skip-bot');
const BOT_MODE = args.includes('--bot');   // 老路子：Carpet 假人（能跟人走，但没有语音）

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n', 'utf8');
}

function ps(script) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }).trim();
}

function portOpen(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  if (await portOpen('127.0.0.1', 25565)) { log('服务端已在运行（25565 已监听）'); return true; }
  log('服务端没在跑 → 无窗口启动 javaw …');
  const out = fs.openSync(SRV_LOG, 'a');
  const srvArgs = ['-Xms1G', '-Xmx4G'];
  const agentJar = load().paths.authlibJar;                     // 外置登录注入器，没配就跳过（官方正版登录不需要）
  if (agentJar) srvArgs.push('-javaagent:' + agentJar + '=' + (load().paths.authlibUrl || 'https://littleskin.cn/api/yggdrasil'));
  srvArgs.push('-jar', 'fabric-server-launch.jar', 'nogui');
  const p = spawn(JAVA25W, srvArgs,
    { cwd: SRV_DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  log('服务端 pid=' + p.pid + '，等它就绪（最多 150 秒）…');
  for (let i = 0; i < 75; i++) {
    await sleep(2000);
    if (await portOpen('127.0.0.1', 25565)) { log('服务端就绪（' + (i + 1) * 2 + 's）'); return true; }
  }
  log('!! 服务端 150 秒内没起来，看 ' + SRV_LOG);
  return false;
}

function botAlive() {
  const f = path.join(DIR, 'bot', 'littlemew.pid');
  if (!fs.existsSync(f)) return false;
  const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
  if (!pid) return false;
  try { return ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`) === 'yes'; }
  catch { return false; }
}

async function ensureBot() {
  if (botAlive()) { log('小喵的"身体"脚本已在运行'); return true; }
  if (DRY) { log('(dry-run) 不启动 Carpet 假人'); return true; }
  log('小喵不在游戏里 → 无窗口启动 littlemew.mjs …');
  const out = fs.openSync(path.join(DIR, 'bot', 'littlemew.out.log'), 'a');
  const p = spawn(process.execPath, [path.join(DIR, 'bot', 'littlemew.mjs'), '--bot', 'LittleMew', '--target', load().players.user],
    { cwd: path.join(DIR, 'bot'), detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  log('守护进程 pid=' + p.pid);
  await sleep(4000);
  return true;
}

// 真身 = 无窗口的隐身客户端（launch-mew.mjs）：它才有耳朵和嘴，才能被 SVC 语音接上。
function bodyAlive() {
  const f = path.join(DIR, 'mew-client.pid');
  if (!fs.existsSync(f)) return false;
  const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
  if (!pid) return false;
  try { return ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`) === 'yes'; }
  catch { return false; }
}

async function ensureBody() {
  if (BOT_MODE) return ensureBot();
  if (bodyAlive()) { log('小喵的真身（隐身语音客户端）已经在游戏里'); return true; }
  if (DRY) { log('(dry-run) 不启动真身'); return true; }
  log('小喵不在游戏里 → 无窗口启动真身 launch-mew.mjs（约 20-40 秒自己进服）…');
  const out = fs.openSync(path.join(DIR, 'launch-mew.out.log'), 'a');
  const p = spawn(process.execPath, [path.join(DIR, 'launch-mew.mjs')],
    { cwd: DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  log('真身启动器 pid=' + p.pid + '（它自己会续期 LittleMew 票据）');
  return true;
}

function loadSession() {
  const b64 = ps(`Add-Type -AssemblyName System.Security | Out-Null; ` +
    `$b=[Convert]::FromBase64String([IO.File]::ReadAllText('${SESS}')); ` +
    `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`);
  return JSON.parse(b64);
}

function saveSession(session) {
  const tmp = path.join(DIR, 'session.plain.tmp.json');
  fs.writeFileSync(tmp, JSON.stringify(session), 'utf8');
  ps(`Add-Type -AssemblyName System.Security | Out-Null; ` +
    `$b=[IO.File]::ReadAllBytes('${tmp}'); ` +
    `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
    `[IO.File]::WriteAllText('${SESS}', [Convert]::ToBase64String($p), (New-Object Text.UTF8Encoding($false))); ` +
    `Remove-Item -LiteralPath '${tmp}' -Force`);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function freshSession() {
  const s = loadSession();
  const sel = { id: s.profileId, name: s.profileName };

  // 1) 用存着的票据续期。LittleSkin 要求带 selectedProfile 才算「绑定角色」，不带会 400。
  const r = await post(`${API}/authserver/refresh`, {
    accessToken: s.accessToken, clientToken: s.clientToken, selectedProfile: sel, requestUser: false,
  });
  if (r.status === 200 && r.json?.accessToken) {
    s.accessToken = r.json.accessToken;
    if (r.json.clientToken) s.clientToken = r.json.clientToken;
    if (r.json.selectedProfile?.id) { s.profileId = r.json.selectedProfile.id; s.profileName = r.json.selectedProfile.name; }
    saveSession(s);
    log('票据续期成功（角色 ' + s.profileName + '）');
    return s;
  }
  log('续期失败（status=' + r.status + ' ' + (r.json?.errorMessage || '') + '）→ 用保存的账号重新登录');
  if (!s.email || !s.password) throw new Error('票据失效且没有保存的账号密码，请重新提供 account.txt');
  const a = await post(`${API}/authserver/authenticate`, {
    agent: { name: 'Minecraft', version: 1 },
    username: s.email, password: s.password, clientToken: s.clientToken, requestUser: false,
  });
  if (a.status !== 200 || !a.json?.accessToken) {
    throw new Error('重新登录也失败 status=' + a.status + ' ' + (a.json?.errorMessage || ''));
  }
  s.accessToken = a.json.accessToken;
  if (a.json.clientToken) s.clientToken = a.json.clientToken;
  const pick = (a.json.availableProfiles || []).find((p) => p.name === s.profileName) || a.json.selectedProfile || (a.json.availableProfiles || [])[0];
  if (pick) { s.profileId = pick.id; s.profileName = pick.name; }

  // 2) 关键一步：再 refresh 一次并指定角色，把令牌绑到你的游戏名（否则游戏会报「访问令牌无效」）
  const b = await post(`${API}/authserver/refresh`, {
    accessToken: s.accessToken, clientToken: s.clientToken,
    selectedProfile: { id: s.profileId, name: s.profileName }, requestUser: false,
  });
  if (b.status === 200 && b.json?.accessToken) {
    s.accessToken = b.json.accessToken;
    if (b.json.clientToken) s.clientToken = b.json.clientToken;
    log('令牌已绑定角色 ' + s.profileName + '（' + s.profileId + '）');
  } else {
    log('!! 绑定角色失败 status=' + b.status + ' ' + (b.json?.errorMessage || '') + '（游戏多半会报令牌无效）');
  }
  saveSession(s);
  log('重新登录成功（角色 ' + s.profileName + '）');
  return s;
}

function gameRunning() {
  // 只看"用户自己的客户端"在不在跑：小喵的真身也是 KnotClient，
  // 不能因为它在线就跳过用户自己的启动（否则点了快捷方式什么都不会发生）。
  try {
    const out = ps(`(Get-CimInstance Win32_Process -Filter "Name='javaw.exe' or Name='java.exe'" | ` +
      `Where-Object { $_.CommandLine -match 'KnotClient' -and $_.CommandLine -match '${load().players.user}' } | Measure-Object).Count`);
    return parseInt(out, 10) > 0;
  } catch { return false; }
}

function tokenizeCmd(line) {
  // cmd / C 运行时的参数解析：引号可出现在参数中间，只用来吞空格、本身不进结果
  const out = [];
  let cur = '', inQ = false, started = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; started = true; continue; }
    if (!inQ && (c === ' ' || c === '\t')) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}

function gameCmdLine(session) {
  // 复用 PCL 生成的整条 java 命令行：只替换身份与追加入服参数，不经 cmd（避免 8191 上限与中文路径乱码）
  const bat = fs.readFileSync(BAT, 'utf8');
  const line0 = bat.split(/\r?\n/).find((l) => l.includes('KnotClient'));
  if (!line0) throw new Error('在 LatestLaunch.bat 里找不到 KnotClient 命令行（先用 PCL 启动过一次即可生成）');
  let line = line0.trim();
  const setArg = (flag, value) => {
    const re = new RegExp('(' + flag.replace(/-/g, '\\-') + '\\s+)(\\S+)');
    line = re.test(line) ? line.replace(re, '$1' + value) : line + ' ' + flag + ' ' + value;
  };
  setArg('--username', session.profileName);
  setArg('--uuid', session.profileId);
  setArg('--accessToken', session.accessToken);
  setArg('--quickPlayMultiplayer', '127.0.0.1:25565');
  const argv = tokenizeCmd(line);
  argv[0] = argv[0].replace(/java\.exe$/i, 'javaw.exe');
  return { argv, line };
}

(async () => {
  log('=== 小喵一键开玩 ' + (DRY ? '(dry-run)' : '') + ' ===');
  if (!SKIP_SERVER) await ensureServer();
  if (!SKIP_BOT) await ensureBody();

  // 游戏已经在跑就立刻收工：不要去动令牌（LittleSkin 一个账号同时只有一个有效令牌，
  // 重新登录会把正在玩的那个客户端挤掉线）
  if (gameRunning() && !DRY) { log('游戏已经在跑了，什么都不用做 ✓'); return; }

  let session;
  try {
    session = await freshSession();
  } catch (e) {
    log('!! ' + e.message);
    log('!! 提示：如果票据和账号都失效了，请重新把账号写进 ' + ACC + ' 再跑 login.mjs');
    process.exit(3);
  }

  const { argv, line } = gameCmdLine(session);
  log('游戏命令行就绪（长度 ' + line.length + ' → 拆出 ' + argv.length + ' 个参数，accessToken 长度 ' + session.accessToken.length + '）');
  log('  --username ' + session.profileName + '  --quickPlayMultiplayer 127.0.0.1:25565  javaw 无窗口');

  if (DRY) { log('dry-run，不启动游戏'); return; }

  const gout = fs.openSync(path.join(DIR, 'game.log'), 'a');
  const g = spawn(argv[0], argv.slice(1), {
    cwd: VERDIR, detached: true, stdio: ['ignore', gout, gout], windowsHide: true,
    env: { ...process.env, MEWFIGHT_SHARED: DIR },   // 战斗模组共享设置目录（两端必须一致）
  });
  g.on('error', (e) => log('!! spawn 失败: ' + e.message));
  g.on('exit', (c, s) => log('启动器进程退出 code=' + c + ' signal=' + s));
  g.unref();
  log('游戏已启动 pid=' + g.pid + '（无窗口，游戏输出 -> ' + path.join(DIR, 'game.log') + '）');
  await sleep(3000);
  try {
    const n = ps(`(Get-CimInstance Win32_Process -Filter "Name='javaw.exe'" | Where-Object { $_.CommandLine -match 'KnotClient' } | Measure-Object).Count`);
    log('KnotClient 进程数 = ' + n);
  } catch {}
})();
