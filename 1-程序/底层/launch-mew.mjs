// 启动第二个客户端实例（小喵的家-mew），以 LittleMew 身份进服 —— 这是小喵在游戏里的"耳朵和嘴"
// 用法: node launch-mew.mjs [--dry]
// 与 launch.mjs 的区别：独立 gameDir、独立角色票据（session-mew.dat）、窗口自动挪到屏幕外、不启动 Carpet 假人
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { need, load } = createRequire(import.meta.url)('../cfg.cjs');

const DRY = process.argv.includes('--dry');
const DIR = __dirname;
const SESS_MEW = path.join(DIR, 'session-mew.dat');
const LOG = path.join(DIR, 'launch-mew.log');
const GAME_LOG = path.join(DIR, 'game-mew.log');
const MC = need('paths', 'minecraftDir');
const GAMEDIR = path.join(MC, 'versions', load().paths.mewVersionDir || '小喵的家-mew');
const BOT = path.join(DIR, 'bot', 'littlemew.pid');
const JAVA = need('paths', 'clientJava');
const JAVAW = JAVA.replace(/java\.exe$/, 'javaw.exe');
const BAT = load().paths.pclBat;
const API = load().paths.authlibUrl || 'https://littleskin.cn/api/yggdrasil';
const UA = 'LittleMewLauncher/1.0 (node; +https://littleskin.cn)';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\r\n'); } catch {}
}
function ps(script) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }).trim();
}
function loadSession(file) {
  const json = ps(`Add-Type -AssemblyName System.Security | Out-Null; ` +
    `$b=[Convert]::FromBase64String([IO.File]::ReadAllText('${file}')); ` +
    `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`);
  return JSON.parse(json);
}
function saveSession(file, session) {
  const tmp = file + '.tmp.json';
  fs.writeFileSync(tmp, JSON.stringify(session), 'utf8');
  ps(`Add-Type -AssemblyName System.Security | Out-Null; ` +
    `$b=[IO.File]::ReadAllBytes('${tmp}'); ` +
    `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
    `[IO.File]::WriteAllText('${file}', [Convert]::ToBase64String($p), (New-Object Text.UTF8Encoding($false))); ` +
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
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

// ---- 1) 刷新 LittleMew 的票据（LittleSkin 必须带 selectedProfile 才算绑定角色）----
async function freshMewSession() {
  const s = loadSession(SESS_MEW);
  const sel = { id: s.profileId, name: s.profileName };
  const r = await post(`${API}/authserver/refresh`, {
    accessToken: s.accessToken, clientToken: s.clientToken, selectedProfile: sel, requestUser: false,
  });
  if (r.status === 200 && r.json?.accessToken) {
    s.accessToken = r.json.accessToken;
    log(`票据续期成功（${s.profileName}）`);
  } else if (s.email && s.password) {
    log(`续期失败 status=${r.status} → 用账号密码重新认证`);
    const a = await post(`${API}/authserver/authenticate`, {
      agent: { name: 'Minecraft', version: 1 },
      username: s.email, password: s.password, clientToken: s.clientToken, requestUser: false,
    });
    if (a.status !== 200) throw new Error('重新认证失败 status=' + a.status);
    const b = await post(`${API}/authserver/refresh`, {
      accessToken: a.json.accessToken, clientToken: a.json.clientToken, selectedProfile: sel, requestUser: false,
    });
    if (b.status !== 200) throw new Error('绑定角色失败 status=' + b.status);
    s.accessToken = b.json.accessToken;
    log(`重新登录并绑定角色成功（${s.profileName}）`);
  } else {
    throw new Error('票据失效且没有账号密码，请重新运行 login_mew.mjs');
  }
  saveSession(SESS_MEW, s);
  return s;
}

// ---- 2) 从 PCL 生成的启动命令行里取模板 ----
function tokenizeCmd(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function templateArgv() {
  const text = fs.readFileSync(BAT, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.includes('KnotClient'));
  if (!line) throw new Error('LatestLaunch.bat 里找不到含 KnotClient 的启动行');
  return tokenizeCmd(line.trim());
}

// ---- 3) 组装 LittleMew 的启动参数 ----
function buildArgv(session) {
  const argv = templateArgv();
  argv[0] = JAVAW;
  const setAfter = (flag, value) => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) argv[i + 1] = value;
    else argv.push(flag, value);
  };
  setAfter('--gameDir', GAMEDIR);
  setAfter('--username', session.profileName);
  setAfter('--uuid', session.profileId);
  setAfter('--accessToken', session.accessToken);
  setAfter('--width', '640');
  setAfter('--height', '360');
  if (!argv.includes('--quickPlayMultiplayer')) argv.push('--quickPlayMultiplayer', '127.0.0.1:25565');
  return argv;
}

// ---- 4) 把窗口藏起来（他看不见，但游戏照常渲染）----
// 模式：--visible 不藏；默认 cloak（DWM 隐身，保留窗口坐标）；--offscreen 挪到屏幕外
const HIDE_MODE = process.argv.includes('--visible') ? 'visible'
  : process.argv.includes('--offscreen') ? 'offscreen' : 'cloak';
function hideWindowLater(pid) {
  if (HIDE_MODE === 'visible') { log('窗口保持可见（--visible）'); return; }
  const action = HIDE_MODE === 'offscreen'
    ? `[WinMove]::SetWindowPos($h,[IntPtr]::Zero,-2600,40,0,0,0x0001 -bor 0x0004 -bor 0x0010) | Out-Null; 'offscreen'`
    : `$cloak = 1; [WinMove]::DwmSetWindowAttribute($h, 13, [ref]$cloak, 4) | Out-Null; 'cloaked'`;
  const script = `
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMove {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
}
"@
    $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    if (-not $p) { 'no-process'; exit }
    for ($i = 0; $i -lt 60; $i++) {
      $p.Refresh()
      if ($p.MainWindowHandle -ne 0) { break }
      Start-Sleep -Milliseconds 500
    }
    if ($p.MainWindowHandle -eq 0) { 'no-window'; exit }
    $h = $p.MainWindowHandle
    ${action}`;
  try {
    const out = ps(script);
    log('窗口处理：' + out + '（模式 ' + HIDE_MODE + '）');
  } catch (e) {
    log('窗口处理失败（不影响游戏）：' + e.message.split('\n')[0]);
  }
}

// ---- main ----
const running = ps(`(Get-CimInstance Win32_Process -Filter "Name='javaw.exe'" | Where-Object { $_.CommandLine -like '*小喵的家-mew*' } | Measure-Object).Count`);
if (parseInt(running, 10) > 0) { log('LittleMew 客户端已经在跑了，收工'); process.exit(0); }

const session = await freshMewSession();
log(`身份：${session.profileName} (${session.profileId}) token=${session.accessToken.length}`);
const argv = buildArgv(session);
log(`参数就绪（${argv.length} 个）gameDir=${GAMEDIR}`);

if (DRY) { log('--dry：不启动'); process.exit(0); }

const fd = fs.openSync(GAME_LOG, 'a');
const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], cwd: GAMEDIR, env: { ...process.env, MEWFIGHT_SHARED: DIR } });
child.unref();
log(`LittleMew 客户端已启动 pid=${child.pid}`);
fs.writeFileSync(path.join(DIR, 'mew-client.pid'), String(child.pid), 'utf8');
hideWindowLater(child.pid);
