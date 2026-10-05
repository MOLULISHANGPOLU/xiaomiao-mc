// voice-ai.cjs —— 小喵在 MC 里的「独立大脑」：不经 DSH，直接调自己的 API
// 链路：游戏里说话 → 本地耳朵(SenseVoice) → 唤醒词闸门 → 本地长期记忆检索 → 调 API → ①文字进游戏聊天框 ②晓伊念出来
// 记忆与压缩：ai-memory/memory.jsonl（长期记忆）+ ai-memory/session.jsonl（对话原文）
//   对话变长时自动把最旧的一段压缩成 ≤200 字要点存进长期记忆，近期几轮保留原文 —— 省空间又不丢事。
//
// 用法：
//   node voice-ai.cjs                  常驻听（喊「小喵」才答）
//   node voice-ai.cjs --selftest       自测（不需要 key、不联网、不出声）
//   node voice-ai.cjs --mock           假回复跑全链路（不联网）
//   node voice-ai.cjs --text "你好"     处理一句话（不录音）
//   node voice-ai.cjs --say "测试"      只测 TTS
//   node voice-ai.cjs --mem "要点文字"   手动存一条长期记忆
//   node voice-ai.cjs --memlist         看记忆/会话统计
//   node voice-ai.cjs --memsearch "关键词"
//   node voice-ai.cjs --usage            看 API 用量账本（每一次调用都记着）
//   node voice-ai.cjs --balance          查 API 余额
//   node voice-ai.cjs --rcmd "time set day"   手动敲一条服务器指令
//   node voice-ai.cjs --cmds             列出本地固定指令（跟着我/停下/给我东西…，0 token）
//   node voice-ai.cjs --text "跟着我" --nospeak   试一句话（--nospeak 只写字不出声，测试用）
//   node voice-ai.cjs --no-ui          不弹监视窗口（默认会弹）
//
// 监视窗口：服务模式启动时会在 127.0.0.1:8799 起一个小网页并自动弹成独立窗口（Edge --app），
//   能看状态/对话/日志/记忆，也能操作：发一句话给大脑、只念一句、存记忆、暂停听、重读配置、清空对话原文。
//   端口与是否自动弹，见 voice-ai.json 的 ui 段。
//
// ⚠ 启动前先停掉另一只同功能的耳朵（底层\voice-bridge.cjs），两个程序同时 looprec 会抢麦克风。
// 配置：1-程序\大脑\voice-ai.json（人设/唤醒词/端口） + 仓库根 config.json（路径/玩家名/开关）   日志：voice-ai.log
// 2026-10-05 起路径不再写死，全部读 config.json；本文件如再见绝对路径，那是没改干净的漏网之鱼。
// 一键启动见 启动小喵.cmd / start-all.ps1（会一起拉起 MC 服务器与 LittleMew 隐身客户端）。
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { startUi } = require('./voice-ai-ui.cjs');   // 监视窗口（本机小网页）
const CMDS = require('./voice-ai-cmds.cjs');        // 手脚：A/B 固定指令表（本地匹配，0 token）
const APPCFG = require('../cfg.cjs').load();        // 统一配置：仓库根 config.json（唯一要改的配置文件）；注意本文件里 CFG 指 voice-ai.json，别混

const DIR = __dirname;                              // 本文件所在目录（大脑），不再写死路径
const MEMDIR = path.join(DIR, 'ai-memory');
const MEMFILE = path.join(MEMDIR, 'memory.jsonl');
const SESSFILE = path.join(MEMDIR, 'session.jsonl');
const USAGEFILE = path.join(MEMDIR, 'usage.json');   // 用量账本：每一次 API 调用都记一笔，防"偷偷吃 token"
const CFGFILE = path.join(DIR, 'voice-ai.json');
const LOGFILE = path.join(DIR, 'voice-ai.log');
const PAUSEFILE = path.join(DIR, 'voice-ai-PAUSED.txt');
const LOCKFILE = path.join(DIR, 'voice-ai.lock');
// 历史坑：audioio.exe 写 D 盘时一直"访问被拒绝"，所以录音临时文件放程序自己的目录。
const WREC = path.join(__dirname, '..', '底层', 'ai-chunk.wav');
const WREC_ALT = path.join(__dirname, '..', '底层', 'ai-chunk2.wav');
const AIO = APPCFG.paths.voiceToolDir ? path.join(APPCFG.paths.voiceToolDir, 'audioio.exe') : '';   // 录音工具（语音版必填）
const SAY = path.join(__dirname, '..', '底层', 'say-mc.cjs');          // 嘴（由 say-mc 转发给 wechat-voice\say_to_call.cjs，走虚拟声卡进游戏）
// 注意：say-mc.cjs 2026-10-04 搬过一次家，缺了它 TTS 会直接 status=1
const ADDON = APPCFG.paths.sherpaNode || '';                           // 语音识别运行时（语音版必填）
const MODEL_DIR = APPCFG.paths.sensevoiceModelDir || '';               // SenseVoice 模型目录（语音版必填）
const SR = 16000, FRAME = 1600, CHUNK = 4, HANG = 8, MIN_SPEECH = 4, MAX_UTTER = 25 * SR;

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const opt = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 ? (ARGV[i + 1] !== undefined ? ARGV[i + 1] : d) : d; };
const MOCK = has('--mock') || has('--selftest');

function log(s) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + s;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n', 'utf8'); } catch { }
}

// ───────────────────────── 配置 ─────────────────────────
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat',
  temperature: 0.8, maxTokens: 300,
  persona: '你是小喵，用户的电脑助理，现在在《我的世界》里用语音陪他玩。回话短、口语化、不超过 40 字。',
  wakeWords: ['小喵', '小苗', '喵喵', '听得到吗', '你在吗', '在吗'],
  wakeWindowSec: 90, cooldownSec: 2, maxReplyChars: 40,
  contextTurns: 14, compressAtChars: 5000, keepRecentTurns: 6,
  memoryTopK: 5, memoryInjectChars: 1200,
  speak: true, chatText: true, echoUserText: false,
  ear: { device: 'Steam Streaming Speakers', db: -48 },
  ui: { enabled: true, port: 8799, autoOpen: true },   // 监视窗口：启动时自动弹出来的那个小窗口
};
function loadCfg() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CFGFILE, 'utf8'))); }
  catch (e) { log('读配置失败，用默认值: ' + e.message); return Object.assign({}, DEFAULTS); }
}
const CFG = loadCfg();
if (APPCFG.features && APPCFG.features.voice === false) CFG.speak = false;   // 纯文字版自动闭嘴（不碰 TTS 链路）
if (has('--nospeak')) CFG.speak = false;      // 测试用：只写字不出声
function keyOk() { const k = CFG.apiKey && CFG.apiKey.trim(); return !!(k && k.length > 8 && !k.includes('填你自己的')); }   // 仓库自带占位符不算"已配置"
// 多供应商：providers 数组优先（免费 API 在前，deepseek 兜底）；没有则退回旧的单 provider 字段
function providerList() {
  if (Array.isArray(CFG.providers) && CFG.providers.length) {
    return CFG.providers.filter(p => p && p.baseUrl && p.apiKey && String(p.apiKey).trim().length > 8);
  }
  return keyOk() ? [{ baseUrl: CFG.baseUrl, apiKey: CFG.apiKey.trim(), model: CFG.model }] : [];
}

// 给监视窗口看的运行状态
const STATE = { startedAt: Date.now(), lastUser: '', lastReply: '', lastError: '', lastAt: 0 };

// ───────────────────────── 用量账本（每一笔 API 调用都留痕，可对账）─────────────────────────
// 只有两个地方会调 API：①回一句话 ②对话变长时压缩一次。没有别的定时器碰 API。
const U = {
  calls: 0, ok: 0, fail: 0, inTokens: 0, outTokens: 0, cacheHit: 0, cacheMiss: 0,
  todayCalls: 0, todayTokens: 0, day: '', byPurpose: {}, lastAt: 0, lastTokens: 0, lastPurpose: '',
};
function usageLoad() { try { Object.assign(U, JSON.parse(fs.readFileSync(USAGEFILE, 'utf8'))); } catch { } }
function usageSave() { try { fs.writeFileSync(USAGEFILE, JSON.stringify(U, null, 1), 'utf8'); } catch { } }
function usageAdd(purpose, usage, ok) {
  const day = new Date().toISOString().slice(0, 10);
  if (U.day !== day) { U.day = day; U.todayCalls = 0; U.todayTokens = 0; }
  U.calls++; U.todayCalls++;
  if (ok) U.ok++; else U.fail++;
  const t = usage || {};
  const tot = Number(t.total_tokens || 0);
  U.inTokens += Number(t.prompt_tokens || 0);
  U.outTokens += Number(t.completion_tokens || 0);
  U.cacheHit += Number(t.prompt_cache_hit_tokens || 0);
  U.cacheMiss += Number(t.prompt_cache_miss_tokens || 0);
  U.todayTokens += tot; U.lastAt = Date.now(); U.lastTokens = tot; U.lastPurpose = purpose;
  U.byPurpose[purpose] = (U.byPurpose[purpose] || 0) + 1;
  usageSave();
  log('API 调用 #' + U.calls + '（' + purpose + '）' + (usage ? ('tokens=' + tot + ' 缓存命中=' + Number(t.prompt_cache_hit_tokens || 0)) : '（没拿到用量）') +
    ' ｜ 今天 ' + U.todayCalls + ' 次/' + U.todayTokens + ' tokens ｜ 累计 ' + U.calls + ' 次/' + (U.inTokens + U.outTokens) + ' tokens');
}
async function balance() {
  if (!keyOk()) return '还没配置 apiKey';
  try {
    const base = String(CFG.baseUrl).replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    const res = await fetch(base + '/user/balance', { headers: { Authorization: 'Bearer ' + CFG.apiKey.trim() } });
    const t = await res.text();
    return 'HTTP ' + res.status + ' ' + t.slice(0, 300);
  } catch (e) { return 'ERR ' + (e && e.message); }
}

// ───────────────────────── 记忆库 ─────────────────────────
function ensureDir() { try { fs.mkdirSync(MEMDIR, { recursive: true }); } catch { } }
function readJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(x => x.trim()).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendJsonl(f, obj) { try { fs.appendFileSync(f, JSON.stringify(obj) + '\n', 'utf8'); } catch (e) { log('写文件失败 ' + f + ': ' + e.message); } }

// 中文按 bigram 切，英文/数字按词切 —— 不装任何依赖的分词
function tokenize(s) {
  const t = [];
  const low = String(s || '').toLowerCase();
  for (const w of (low.match(/[a-z0-9_]+/g) || [])) t.push(w);
  for (const h of (low.match(/[\u4e00-\u9fa5]+/g) || [])) {
    if (h.length === 1) t.push(h);
    for (let i = 0; i < h.length - 1; i++) t.push(h.slice(i, i + 2));
  }
  return t;
}
function topKeywords(s, n = 10) {
  const tf = new Map();
  for (const t of tokenize(s)) if (t.length > 1) tf.set(t, (tf.get(t) || 0) + 1);
  return [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

const mem = { entries: [] };
function memLoad() { mem.entries = readJsonl(MEMFILE); }
function memAdd(text, opts = {}) {
  const e = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(), kind: opts.kind || 'fact', text: String(text).trim(),
    keywords: opts.keywords || topKeywords(text, 8),
    importance: opts.importance || 1, status: 'active',
  };
  if (!e.text) return null;
  mem.entries.push(e);
  appendJsonl(MEMFILE, e);
  return e;
}
function memDup(text) {                                          // 查重：跟已有记忆词重合 ≥40%（双向）就当记过了
  const bag = new Set(tokenize(text).filter(t => t.length > 1));
  if (bag.size < 3) return false;
  for (const e of mem.entries) {
    if (e.status === 'archived') continue;
    const eb = new Set(tokenize(e.text).filter(t => t.length > 1));
    if (eb.size < 3) continue;
    let hit = 0;
    for (const t of bag) if (eb.has(t)) hit++;
    if (hit / bag.size >= 0.4 || hit / eb.size >= 0.4) return true;
  }
  return false;
}
function memSearch(q, k) {
  const qt = [...new Set(tokenize(q))];
  if (!qt.length) return [];
  const alive = mem.entries.filter(e => e.status !== 'archived');
  const df = new Map();
  for (const e of alive) for (const t of new Set(tokenize(e.text + ' ' + (e.keywords || []).join(' ')))) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, alive.length);
  return alive.map(e => {
    const bag = new Set(tokenize(e.text + ' ' + (e.keywords || []).join(' ')));
    let s = 0;
    for (const t of qt) if (bag.has(t)) s += Math.log(1 + N / (1 + (df.get(t) || 0))) * (t.length > 1 ? 1.3 : 0.6);
    if (s <= 0) return null;
    const days = (Date.now() - (e.ts || 0)) / 86400000;
    s *= (1 + 0.15 * (e.importance || 1)) * Math.exp(-days / 120);
    return { e, s };
  }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, k || CFG.memoryTopK).map(x => x.e);
}
function memBlock(query) {
  const hits = memSearch(query, CFG.memoryTopK);
  if (!hits.length) return '';
  let out = '（下面是关于这个玩家和以往一起玩过的长期记忆，参考着用，不要照念）\n';
  for (const h of hits) {
    if (out.length > CFG.memoryInjectChars) break;
    out += '- [' + h.kind + '] ' + h.text.replace(/\s+/g, ' ').slice(0, 200) + '\n';
  }
  return out;
}

// ───────────────────────── 对话与压缩 ─────────────────────────
let turns = [];   // [{role:'user'|'assistant', text, ts}]
let turnsReady = false;
function turnsLoad() {
  if (turnsReady) return;
  turnsReady = true;
  const raw = readJsonl(SESSFILE);
  let start = 0;
  for (let i = raw.length - 1; i >= 0; i--) if (raw[i].role === '_fold') { start = i + 1; break; }   // 已被压缩掉的部分不再重复喂给大脑
  turns = raw.slice(start).filter(x => x.role === 'user' || x.role === 'assistant').map(x => ({ role: x.role, text: x.text, ts: x.ts }));
}
function turnsAdd(role, text) {
  const t = { role, text, ts: Date.now() };
  turns.push(t);
  appendJsonl(SESSFILE, t);
  return t;
}
function turnsChars() { return turns.reduce((a, t) => a + t.text.length, 0); }

function fallbackSummary(chunk) {
  const lines = chunk.split('\n').map(x => x.trim()).filter(Boolean);
  const picked = lines.filter(l => /[0-9]/.test(l) || /记住|约定|决定|要做|别忘|坐标|密码|名字/.test(l));
  const src = (picked.length ? picked : lines).join(' ');
  return src.slice(0, 200);
}
async function summarizeChunk(chunkText) {
  if (MOCK) return '（假摘要）这段对话一共 ' + chunkText.length + ' 字，主要是闲聊和游戏里的动作。';
  const r = await llm([
    { role: 'system', content: '你是对话压缩器。把下面的对话压缩成不超过 200 字的中文要点，保留人物、数字、约定、结论和还没做完的事。只输出正文，不要解释。' },
    { role: 'user', content: chunkText.slice(0, 8000) },
  ], { retries: 1, purpose: '压缩' });
  if (r.ok && r.text.trim()) return r.text.trim().slice(0, 300);
  log('压缩走本地兜底（API 不可用：' + (r.err || '') + '）');
  return fallbackSummary(chunkText);
}
async function compressIfNeeded(reason) {
  if (turnsChars() < CFG.compressAtChars) return false;
  const keep = Math.max(2, CFG.keepRecentTurns * 2);
  const cut = turns.length - keep;
  if (cut < 2) return false;
  const chunk = turns.slice(0, cut);
  const text = chunk.map(t => (t.role === 'user' ? '他: ' : '小喵: ') + t.text).join('\n');
  const before = turnsChars();
  const sum = await summarizeChunk(text);
  memAdd(sum, { kind: 'summary', importance: 2, keywords: topKeywords(sum, 8) });
  turns = turns.slice(cut);
  appendJsonl(SESSFILE, { role: '_fold', ts: Date.now(), n: chunk.length, chars: before, summary: sum.slice(0, 300) });   // 折页标记：告诉下次启动"这之前的原文已经压过了"
  log('已压缩 ' + chunk.length + ' 轮（' + before + ' → ' + turnsChars() + ' 字，' + reason + '）：' + sum.slice(0, 60) + '…');
  return true;
}

// ───────────────────────── 大脑：API ─────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function llm(messages, opts = {}) {
  const purpose = opts.purpose || '回话';
  if (MOCK) return { ok: true, text: '（假回复）我听到啦，这是离线自测。' };
  const provs = providerList();
  if (!provs.length) return { ok: false, err: '还没配置 apiKey（voice-ai.json）' };
  const attempts = 1 + (opts.retries === undefined ? 1 : opts.retries);   // 默认每个供应商最多试 2 次
  let lastErr = '';
  for (const p of provs) {
    for (let i = 0; i < attempts; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const res = await fetch(String(p.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + String(p.apiKey).trim() },
          body: JSON.stringify({ model: p.model, messages, temperature: CFG.temperature, max_tokens: CFG.maxTokens, stream: false }),
          signal: ctl.signal,
        });
        clearTimeout(timer);
        const txt = await res.text();
        if (!res.ok) { lastErr = 'HTTP ' + res.status + ' ' + txt.slice(0, 200); log('API[' + (p.model || '?') + '] 失败(' + (i + 1) + '/' + attempts + '): ' + lastErr); usageAdd(purpose, null, false); }
        else {
          let j = null; try { j = JSON.parse(txt); } catch { }
          const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
          usageAdd(purpose, j && j.usage, !!(content && content.trim()));
          if (content && content.trim()) return { ok: true, text: content.trim() };
          lastErr = '返回里没有 content: ' + txt.slice(0, 200); log('API[' + (p.model || '?') + '] 空回复(' + (i + 1) + '/' + attempts + ')');
        }
      } catch (e) {
        clearTimeout(timer);
        lastErr = (e && e.name === 'AbortError') ? '超时 30s' : String(e && e.message || e);
        usageAdd(purpose, null, false);
        log('API[' + (p.model || '?') + '] 异常(' + (i + 1) + '/' + attempts + '): ' + lastErr);
      }
      if (i + 1 < attempts) await sleep(800);
    }
    log('供应商 ' + (p.model || '?') + ' 失败，切换下一个…');
  }
  return { ok: false, err: lastErr };
}

// ───────────────────────── 嘴：文字进聊天框 + 语音 ─────────────────────────
function rcon(command) {
  return new Promise((resolve) => {
    let props = '';
    try { props = fs.readFileSync(path.join(require('../cfg.cjs').need('paths', 'serverDir'), 'server.properties'), 'utf8'); } catch (e) { return resolve('ERR 读不到 server.properties（检查 config.json 的 paths.serverDir）'); }
    const pass = ((props.match(/^rcon\.password=(.*)$/m) || [, ''])[1] || '').trim();
    const port = Number((props.match(/^rcon\.port=(\d+)/m) || [, '25575'])[1]);
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0), done = false;
    const fail = (m) => { if (!done) { done = true; try { sock.destroy(); } catch { } resolve('ERR ' + m); } };
    const timer = setTimeout(() => fail('RCON 超时'), 8000);
    const pkt = (id, type, body) => {
      const b = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.from([0, 0])]);
      const out = Buffer.alloc(4 + 4 + 4 + b.length);
      out.writeInt32LE(4 + 4 + b.length, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); b.copy(out, 12);
      return out;
    };
    sock.on('connect', () => sock.write(pkt(1, 3, pass)));
    sock.on('error', (e) => fail(e.message));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) return;
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (type === 2) { if (id === -1) return fail('RCON 密码错'); sock.write(pkt(2, 2, command)); }
        else if (type === 0) { clearTimeout(timer); if (!done) { done = true; sock.end(); resolve(body); } }
      }
    });
  });
}
async function chatPrint(text) {
  if (!CFG.chatText) return '';
  const payload = [{ text: '[小喵] ', color: 'light_purple' }, { text: text, color: 'white' }];
  const r = await rcon('tellraw @a ' + JSON.stringify(payload));
  if (/^ERR/.test(r)) log('聊天框写字失败: ' + r);
  return r;
}
function speechClean(t) {
  return String(t).replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, '链接').replace(/[（(][^）)]{0,20}[）)]/g, '').trim();
}
function speak(text) {
  if (!CFG.speak || MOCK) return true;
  const r = spawnSync(process.execPath, [SAY, speechClean(text)], { stdio: 'ignore' });
  if (r.status !== 0) { log('TTS 失败 status=' + r.status); return false; }
  return true;
}

// ───────────────────────── 手：让大脑真的能敲指令（用户 2026-10-04 授权：破坏性指令也允许）─────────────────────────
// 两个入口：① 他说「敲指令 xxx」→ 本地直通，0 token；② AI 回话里写 <cmd>xxx</cmd> → 抽出来执行，再念正文。
const CMD_PROMPT = [
  '默认像普通玩家一样思考和回答，绝不能凭空变物品。例如他说「合成工作台」，要想到需要砍树做木板，先指挥小喵去砍树，而不是直接给他工作台。',
  `你能指挥小喵行动（走路、采集、捡东西、收割），把这些动作写进 <baritone></baritone> 标签，我会让小喵真的去做。可用命令：#mine <方块> 采集、#follow player ${APPCFG.players.user} 跟着玩家、#goto <x> <z> 走到坐标、#farm 收割、#pickup 捡掉落、#surface 到地表、#tunnel <宽> <高> <深> 挖隧道、#explore 探索、#cancel 停下。`,
  `只有当他说「用指令」「敲指令」「直接给我」「直接变」「别啰嗦」这类明确要求动用指令的话时，才把服务器指令写进 <cmd></cmd> 标签里（可多条），我会立刻替你执行。被陪的玩家名是 ${APPCFG.players.user}，指令里的玩家名就用他。例子：<cmd>give ${APPCFG.players.user} diamond_sword 1</cmd>、<cmd>gamemode creative ${APPCFG.players.user}</cmd>、<cmd>time set day</cmd>。`,
  '没明确要求时绝对不要写 <cmd> 标签；正文里不要出现标签、也不要念指令原文，只用一句口语回答。',
  '如果他说的内容值得长期记住（比如约定、喜好、称呼、重要的坐标或名字、明确说「记住…」），把这条记忆写进 <记忆></记忆> 标签里，一句话讲清一件事，要记几件就写几个标签。标签里的字会被自动存进我的长期记忆，不用在正文里念出来。闲聊和临时的事不要写。',
].join('\n');
const CMD_RE = /<cmd>([\s\S]*?)<\/cmd>/gi;
const BARITONE_RE = /<baritone>([\s\S]*?)<\/baritone>/gi;
const MEM_RE = /<记忆>([\s\S]*?)<\/记忆>/gi;
async function runCmds(text) {
  const results = [];
  let m;
  CMD_RE.lastIndex = 0;
  while ((m = CMD_RE.exec(text))) {
    const cmd = String(m[1] || '').trim().replace(/^\/+/, '').replace(/\s+/g, ' ');
    if (!cmd) continue;
    CMDS.noteWeather(cmd);                                     // 自己改过天气就记一笔（服务器不给查天气）
    const r = String(await rcon(cmd)).slice(0, 300);
    results.push({ cmd, r });
    log('执行指令 /' + cmd + ' → ' + r.slice(0, 160));
    if (CFG.chatText) await rcon('tellraw @a ' + JSON.stringify([{ text: '[小喵·指令] ', color: 'gray' }, { text: '/' + cmd, color: 'dark_gray' }]));
  }
  // 行动标签：AI 指挥小喵走路/采集/捡东西（敲进 LittleMew 聊天框，Baritone 执行）
  BARITONE_RE.lastIndex = 0;
  while ((m = BARITONE_RE.exec(text))) {
    const cmd = String(m[1] || '').trim().replace(/^#/, '').replace(/\s+/g, ' ');
    if (!cmd) continue;
    const r = String(await CMDS.hdSend('chat #' + cmd, 25000)).slice(0, 200);
    results.push({ cmd: '#' + cmd, r, baritone: true });
    log('指挥小喵 #' + cmd + ' → ' + r.slice(0, 160));
  }
  // 记忆标签：小喵自己判断「这事值得长期记住」，存进长期记忆（先查重，避免反复记同一条）
  MEM_RE.lastIndex = 0;
  while ((m = MEM_RE.exec(text))) {
    const txt = String(m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!txt) continue;
    if (memDup(txt)) { results.push({ mem: txt, dup: true }); log('记忆重复，跳过: ' + txt.slice(0, 40)); continue; }
    const e = memAdd(txt, { kind: 'fact', importance: 2 });
    results.push({ mem: txt, id: e && e.id });
    log('小喵自己记住了: ' + txt.slice(0, 60));
  }
  const clean = results.length ? text.replace(CMD_RE, '').replace(BARITONE_RE, '').replace(MEM_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim() : text;
  return { clean, results };
}
function directCommand(text) {
  const m = String(text).match(/(?:敲|下|执行|运行|跑)(?:个|一个)?指令[：:，,]?\s*([\s\S]+)$/);
  if (!m) return '';
  const c = m[1].trim().replace(/^\/+/, '');
  return /^[a-z_]+(\s|$)/i.test(c) ? c : '';     // 首词得像个英文命令名，避免聊天里误触发
}

// ───────────────────────── 一句话的完整处理 ─────────────────────────
const WAKE_ALIAS = CFG.wakeWords;
let awakeUntil = 0;
let apiFailStreak = 0;

// 固定指令（A/B 那两条）：本地匹配 → 直接干活，0 token
function localCommand(text) { return CMDS.localCommand(text, { rcon, log, CFG, wakeWords: CFG.wakeWords }); }

async function handleUtterance(text, opts = {}) {
  const now = Date.now();
  const announce = opts.announce !== false;
  const woke = WAKE_ALIAS.some(w => text.includes(w));
  if (woke) { awakeUntil = now + CFG.wakeWindowSec * 1000; log('被叫醒了（' + CFG.wakeWindowSec + 's 内继续听）'); }

  turnsLoad();
  turnsAdd('user', text);
  STATE.lastUser = text; STATE.lastAt = now;
  if (CFG.echoUserText && announce && opts.echo !== false) await rcon('tellraw @a ' + JSON.stringify([{ text: '[你] ', color: 'gray' }, { text: text, color: 'gray' }]));

  await compressIfNeeded('对话变长');

  const direct = directCommand(text);                           // 「敲指令 xxx」：0 token 直通
  if (direct) {
    const r = String(await rcon(direct)).slice(0, 300);
    log('直通指令 /' + direct + ' → ' + r.slice(0, 160));
    const reply0 = '指令 /' + direct + ' 的结果：' + (r || '（没有回话）');
    turnsAdd('assistant', reply0); STATE.lastReply = reply0;
    if (announce) { await chatPrint(reply0); speak('指令执行完了'); }
    return { reply: reply0, ok: true, err: '', direct: true };
  }

  const local = await localCommand(text);                       // 固定指令（跟着我/停下/给我东西…）：本地匹配，0 token
  if (local) {
    const reply1 = local.reply.slice(0, CFG.maxReplyChars * 2);
    turnsAdd('assistant', reply1); STATE.lastReply = reply1;
    if (announce) { await chatPrint(reply1); speak(reply1); }
    log('小喵(本地·' + local.name + '): ' + reply1);
    return { reply: reply1, ok: true, err: '', local: local.name };
  }

  // 本地没匹配到 → 只有手动唤醒（喊了小喵 / 窗口内 / 强制）才调 API，否则省钱跳过
  if (!opts.force && !woke && now >= awakeUntil) { log('不是本地指令、也没喊小喵，先不理（省钱）: ' + text); return { skipped: 'wake' }; }

  let reply = '', ok = true, err = '';
  if (!providerList().length && !MOCK) {                       // 还没给钥匙：不当作故障，不触发暂停
    reply = '我还没拿到接口密钥，先去监视窗口里等我一会儿。';
    err = '未配置 apiKey'; STATE.lastError = err;
    log('（没有 key）' + reply);
  } else {
    const sys = CFG.persona + '\n\n' + CMD_PROMPT + '\n\n' + (memBlock(text) || '');
    const messages = [{ role: 'system', content: sys }]
      .concat(turns.slice(-CFG.contextTurns).map(t => ({ role: t.role, content: t.text })));
    const r = await llm(messages);
    ok = r.ok;
    if (r.ok) { apiFailStreak = 0; reply = r.text; }
    else {
      err = r.err || ''; STATE.lastError = err;
      apiFailStreak++;
      reply = '我这边连不上大脑了，等我修一下。';
      log('（第 ' + apiFailStreak + ' 次）大脑不可用，原因: ' + err);
      if (apiFailStreak >= 2) {                                  // 用户规矩：同一个问题最多试 2 次，不成就暂停汇报
        const msg = '连续 2 次调用 API 失败，已暂停。最后错误: ' + err + '\n时间: ' + new Date().toISOString() + '\n修好后删掉这个文件再启动即可。';
        try { fs.writeFileSync(PAUSEFILE, msg, 'utf8'); } catch { }
        log('！！！已暂停并向用户汇报：' + err);
        paused = true;
      }
    }
  }
  let cmdResults = [];
  if (reply) { const rc2 = await runCmds(reply); reply = rc2.clean || reply; cmdResults = rc2.results; }   // 把 AI 写在 <cmd> 里的指令真的执行掉
  if (reply.length > CFG.maxReplyChars * 2) reply = reply.slice(0, CFG.maxReplyChars * 2);
  turnsAdd('assistant', reply);
  STATE.lastReply = reply;
  if (announce) { await chatPrint(reply); speak(reply); }
  log('小喵: ' + reply);
  return { reply, ok, err, cmds: cmdResults };
}

// ───────────────────────── 耳朵 ─────────────────────────
let addon = null, rec = null;
function earInit() {
  addon = require(ADDON);
  rec = addon.createOfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: MODEL_DIR + '\\model.int8.onnx', language: 'zh', useInverseTextNormalization: 1 },
      tokens: MODEL_DIR + '\\tokens.txt', numThreads: 2, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
}
function frameDb(s, off, len) {
  let sum = 0, n = 0;
  for (let i = off; i < off + len && i < s.length; i++) { const v = s[i]; sum += v * v; n++; }
  if (!n) return -100;
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-7 ? -100 : 20 * Math.log10(rms);
}
function recognize(samples) {
  const st = addon.createOfflineStream(rec);
  addon.acceptWaveformOffline(st, { samples, sampleRate: SR });
  addon.decodeOfflineStream(rec, st);
  try { return (JSON.parse(addon.getOfflineStreamResultAsJson(st)).text || '').trim(); } catch { return ''; }
}
function gbk(s) {                             // audioio.exe 的中文提示是 GBK 编码，按 UTF-8 读会是乱码
  try { return String(s).replace(/\uFFFD/g, '') } catch { return String(s) }
}
function spawnAsync(cmd, args, ms) {          // 异步跑子进程：绝不能用 spawnSync，否则事件循环被堵死，监视窗口/HTTP 全都没反应
  return new Promise((resolve) => {
    let so = Buffer.alloc(0), se = Buffer.alloc(0), done = false;
    const dec = (b) => { try { return new TextDecoder('gbk').decode(b) } catch { return b.toString('utf8') } };
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const fin = (status) => { if (!done) { done = true; resolve({ status, stdout: dec(so), stderr: dec(se) }); } };
    p.stdout.on('data', (d) => { so = Buffer.concat([so, d]); });
    p.stderr.on('data', (d) => { se = Buffer.concat([se, d]); });
    p.on('error', (e) => { se = Buffer.concat([se, Buffer.from(String((e && e.message) || e))]); fin(-1); });
    p.on('close', (code) => fin(code === null ? -1 : code));
    if (ms) setTimeout(() => { try { p.kill(); } catch { } }, ms);
  });
}
let paused = false;
async function earLoop() {
  const DEVICE = opt('--device', CFG.ear.device), DB = Number(opt('--db', CFG.ear.db));
  try { fs.writeFileSync(LOCKFILE, String(process.pid), 'utf8'); } catch { }
  let inited = false, waitLogged = false;
  let wrec = WREC, recFail = 0;                 // wrec：当前录音临时文件（写不进就换备用路径）
  let utter = [], silence = 0, speaking = false, totalSpeech = 0, lastText = '', lastAt = 0;
  for (;;) {
    if (!keyOk() && !MOCK) {                                     // 没钥匙就先不占麦克风，每 10 秒看一眼配置（配好自动开始听）
      if (!waitLogged) { log('还没配 apiKey：先不占用麦克风，每 10 秒看一眼配置'); STATE.lastError = '未配置 apiKey'; waitLogged = true; }
      await sleep(10000);
      Object.assign(CFG, loadCfg());
      continue;
    }
    if (waitLogged) { log('检测到 apiKey，开始听'); waitLogged = false; }
    if (!inited) {
      earInit(); inited = true;
      log('=== 独立耳朵启动 device=' + DEVICE + ' 阈值=' + DB + 'dB 唤醒词=' + WAKE_ALIAS.join('/') + ' 模式=' + (MOCK ? 'mock' : 'api') + ' ===');
    }
    if (paused) { log('（已暂停，30 秒后再看一次）'); await sleep(30000); continue; }
    let r = await spawnAsync(AIO, ['looprec', wrec, String(CHUNK), DEVICE], (CHUNK + 20) * 1000);
    if (r.status !== 0) {                                             // 同一个问题最多试 2 次：主路径失败就换备用路径重试一次
      const m = String(r.stdout || r.stderr || '').trim();
      log('录音失败: ' + m.slice(0, 200));
      const other = wrec === WREC ? WREC_ALT : WREC;
      log('改用' + (wrec === WREC ? '备用' : '主') + '录音文件重试一次: ' + other);
      wrec = other;
      r = await spawnAsync(AIO, ['looprec', wrec, String(CHUNK), DEVICE], (CHUNK + 20) * 1000);
      if (r.status !== 0) {
        recFail++;
        STATE.lastError = '录音失败: ' + String(r.stdout || r.stderr || '').trim().slice(0, 120);
        log('两条路径都写不进（第 ' + recFail + ' 次），当前用 ' + wrec + '：' + String(r.stdout || r.stderr || '').trim().slice(0, 160));
        if (recFail >= 3) { log('录音连续失败 ' + recFail + ' 次，先歇 30 秒（多半是麦克风被占用或路径不可写）'); await sleep(30000); }
        continue;
      }
    }
    recFail = 0;
    let wave; try { wave = addon.readWave(wrec); } catch (e) { log('读 WAV 失败: ' + e.message); continue; }
    const samples = wave.samples;
    for (let off = 0; off < samples.length; off += FRAME) {
      const isSpeech = frameDb(samples, off, FRAME) > DB;
      if (isSpeech) {
        if (!speaking) { speaking = true; totalSpeech = 0; utter = []; }
        silence = 0; utter.push(samples.subarray(off, Math.min(off + FRAME, samples.length)));
        totalSpeech += Math.min(FRAME, samples.length - off);
      } else if (speaking) {
        silence++; utter.push(samples.subarray(off, Math.min(off + FRAME, samples.length)));
        if (silence >= HANG || totalSpeech > MAX_UTTER) {
          const need = Math.max(0, utter.length - (HANG - 1));
          const kept = utter.slice(0, Math.max(need, 1));
          let len = 0; for (const k of kept) len += k.length;
          const buf = new Float32Array(len); let p = 0; for (const k of kept) { buf.set(k, p); p += k.length; }
          speaking = false; silence = 0; utter = [];
          if (totalSpeech >= MIN_SPEECH * FRAME) {
            const text = recognize(buf);
            log('识别(' + (len / SR).toFixed(1) + 's): ' + (text || '(空)'));
            const now = Date.now();
            if (text && text.length >= 2) {
              if (text === lastText && now - lastAt < CFG.cooldownSec * 1000) log('重复句，跳过');
              else { lastText = text; lastAt = now; await handleUtterance(text); }
            }
          }
          totalSpeech = 0;
        }
      }
    }
  }
}

// ───────────────────────── 聊天监听：游戏里手动输入也算指令 ─────────────────────────
// 语音识别出同音错别字（幕府→木斧、砍数→砍树）没法根治，所以盯着服务器日志，
// 用户在游戏聊天框里打 <玩家名> xxx 就直接当指令处理，不用喊「小喵」。
const SERVER_LOG = require('../cfg.cjs').need('paths', 'serverLog');
function chatWatch() {
  let off = 0, busy = false;
  try { off = fs.statSync(SERVER_LOG).size; } catch { }            // 启动时跳到日志末尾，旧消息不重放
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const size = fs.statSync(SERVER_LOG).size;
      if (size < off) { off = size; }                              // 日志被轮转/清空
      else if (size > off) {
        const fd = fs.openSync(SERVER_LOG, 'r');
        const len = size - off;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        fs.closeSync(fd);
        off = size;
        const re = new RegExp('<' + APPCFG.players.user + '>\\s+([^\\n\\r]+)', 'g');
        const txt = buf.toString('utf8');
        let m;
        while ((m = re.exec(txt))) {
          const msg = m[1].trim();
          if (!msg || msg.length < 2) continue;
          log('聊天输入: ' + msg);
          await handleUtterance(msg, { force: true, echo: false });
        }
      }
    } catch (e) { /* 日志暂时读不到就下次再试 */ }
    busy = false;
  }, 1500);
}

// ───────────────────────── 自测 ─────────────────────────
async function selftest() {
  ensureDir(); memLoad(); turnsLoad();
  const line = (s) => console.log(s);
  line('1) 配置: model=' + CFG.model + ' baseUrl=' + CFG.baseUrl + ' apiKey=' + (keyOk() ? '已配置(长度' + CFG.apiKey.trim().length + ')' : '未配置') + ' 监视窗口端口=' + CFG.ui.port);
  line('2) 记忆库: ' + MEMFILE + ' 现有 ' + mem.entries.length + ' 条；会话原文 ' + readJsonl(SESSFILE).length + ' 轮');
  const t = memAdd(`自测用记忆：他喜欢被叫「小喵」，游戏名 ${APPCFG.players.user}，家在 26.1 服务器上。`, { kind: 'fact', importance: 1 });
  const hits = memSearch('小喵 游戏名 服务器', 3);
  line('3) 记忆检索: 写入 ' + t.id + ' → 命中 ' + hits.length + ' 条: ' + hits.map(h => h.id).join(', ') + (hits[0] ? ' | 首条: ' + hits[0].text.slice(0, 40) : ''));
  const fake = [];
  for (let i = 0; i < 40; i++) fake.push({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '轮：他说他今天想挖钻石，坐标是 ' + i + ' 70 ' + i + '，让我记住。' + '今天聊了不少游戏里的事。'.repeat(12) });
  const old = turns; turns = fake.slice();
  const before = turnsChars();
  const did = await compressIfNeeded('自测触发');
  const after = turnsChars();
  line('4) 压缩: ' + (did ? '成功 ' + before + '→' + after + ' 字，剩 ' + turns.length + ' 轮，摘要已进长期记忆' : '未触发'));
  turns = old;
  const rc = await rcon('list');
  line('5) RCON: ' + String(rc).slice(0, 120));
  line('6) API: ' + (MOCK ? 'mock 模式（不联网）' : keyOk() ? '已配置 key，可用 --text 或 --mock 试' : '**未配置 key**，等你给'));
  line('7) TTS: ' + (CFG.speak ? '已开启（自测不说话，用 --say 单独试）' : '已关闭'));
  line('自测完成。');
}

// ───────────────────────── 监视窗口用的接口 ─────────────────────────
function logTail(n = 60) {
  try { return fs.readFileSync(LOGFILE, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
function clearSession() { try { fs.writeFileSync(SESSFILE, '', 'utf8'); } catch { } turns = []; turnsReady = true; }
function reloadCfg() {
  Object.assign(CFG, loadCfg());
  log('配置已重读：model=' + CFG.model + ' key=' + (keyOk() ? '已配置' : '未配置') + ' 端口=' + CFG.ui.port);
  return { keyOk: keyOk() };
}
function setToken(tokens) {
  const n = Math.round(Number(tokens));
  if (!Number.isFinite(n) || n < 50 || n > 2000) return { ok: false, msg: '请输入 50~2000 之间的数字' };
  CFG.maxTokens = n;
  CFG.maxReplyChars = Math.max(10, Math.round(n / 7.5));
  CFG.persona = CFG.persona.replace(/不超过\s*\d+\s*个字/, '不超过 ' + CFG.maxReplyChars + ' 个字');
  try {
    const cur = JSON.parse(fs.readFileSync(CFGFILE, 'utf8'));
    cur.maxTokens = CFG.maxTokens;
    cur.maxReplyChars = CFG.maxReplyChars;
    cur.persona = CFG.persona;
    fs.writeFileSync(CFGFILE, JSON.stringify(cur, null, 2), 'utf8');
    log('窗口里设 token：maxTokens=' + n + '，maxReplyChars=' + CFG.maxReplyChars);
    return { ok: true, maxTokens: n, maxReplyChars: CFG.maxReplyChars };
  } catch (e) { return { ok: false, msg: '写回失败: ' + e.message }; }
}
async function togglePause() {
  paused = !paused;
  if (!paused) { apiFailStreak = 0; try { if (fs.existsSync(PAUSEFILE)) fs.unlinkSync(PAUSEFILE); } catch { } }
  log(paused ? '（窗口里手动暂停听）' : '（窗口里手动继续听）');
  return paused;
}
function status() {
  turnsLoad();
  return {
    listening: !paused, paused, keyOk: keyOk(), model: CFG.model, baseUrl: CFG.baseUrl,
    device: CFG.ear.device, mode: MOCK ? 'mock' : (keyOk() ? 'api' : '等密钥'),
    uptimeSec: Math.floor((Date.now() - STATE.startedAt) / 1000),
    lastUser: STATE.lastUser, lastReply: STATE.lastReply, lastError: STATE.lastError, lastAt: STATE.lastAt,
    memCount: mem.entries.length, sessionTurns: turns.length,
    wakeWindowSec: CFG.wakeWindowSec, speak: CFG.speak, chatText: CFG.chatText,
    usage: {
      calls: U.calls, ok: U.ok, fail: U.fail, todayCalls: U.todayCalls || 0, todayTokens: U.todayTokens || 0,
      inTokens: U.inTokens, outTokens: U.outTokens, cacheHit: U.cacheHit, cacheMiss: U.cacheMiss,
      lastAt: U.lastAt, lastPurpose: U.lastPurpose, byPurpose: U.byPurpose,
    },
  };
}
function startWindow() {
  if (MOCK || has('--no-ui') || CFG.ui.enabled === false) return null;
  turnsLoad();
  return startUi({
    port: CFG.ui.port, autoOpen: CFG.ui.autoOpen !== false, log,
    ctx: {
      status, recentTurns: (n) => turns.slice(-n), logTail, listMem: (n) => mem.entries.slice(-n),
      ask: (t, announce) => handleUtterance(t, { force: true, announce }),
      say: (t) => speak(t), remember: (t) => memAdd(t, { kind: 'fact', importance: 2 }),
      togglePause, reloadCfg, clearSession, balance, setToken,
      rcmd: (c) => rcon(String(c || '').replace(/^\/+/, '')),
    },
  });
}

// ───────────────────────── 入口 ─────────────────────────
(async () => {
  ensureDir(); memLoad(); usageLoad();
  if (has('--memlist')) {
    const s = readJsonl(SESSFILE);
    console.log('长期记忆 ' + mem.entries.length + ' 条 / 会话原文 ' + s.length + ' 轮，目录: ' + MEMDIR);
    const kinds = {}; for (const e of mem.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    console.log('分类: ' + JSON.stringify(kinds) + '  文件大小: ' + (() => { try { return (fs.statSync(MEMFILE).size / 1024).toFixed(1) + 'KB'; } catch { return '0KB'; } })());
    for (const e of mem.entries.slice(-8)) console.log('  ' + e.id + ' [' + e.kind + '] ' + e.text.slice(0, 70));
    return;
  }
  if (has('--memsearch')) { for (const e of memSearch(ARGV[ARGV.indexOf('--memsearch') + 1] || '', 8)) console.log(e.id + ' [' + e.kind + '/i' + e.importance + '] ' + e.text.slice(0, 120)); return; }
  if (has('--mem')) { const e = memAdd(ARGV[ARGV.indexOf('--mem') + 1] || '', { kind: 'fact', importance: 2 }); console.log('已存: ' + (e ? e.id : '空内容')); return; }
  if (has('--say')) { speak(ARGV[ARGV.indexOf('--say') + 1] || '测试'); console.log('已念（若没声音看 CABLE 通路）'); return; }
  if (has('--usage')) { console.log(JSON.stringify(U, null, 1)); return; }
  if (has('--balance')) { console.log(await balance()); return; }
  if (has('--rcmd')) { const c = String(ARGV[ARGV.indexOf('--rcmd') + 1] || '').replace(/^\/+/, ''); if (!c) { console.log('用法: --rcmd "<服务器指令>"'); return; } console.log(String(await rcon(c))); return; }
  if (has('--cmds')) { console.log('本地固定指令 ' + CMDS.listRules().length + ' 条（本地匹配，不走 API、0 token）：'); for (const n of CMDS.listRules()) console.log('  · ' + n); return; }
  if (has('--selftest')) { await selftest(); return; }
  if (has('--text')) { const t = ARGV[ARGV.indexOf('--text') + 1]; turnsLoad(); const r = await handleUtterance(t, { force: true }); console.log('结果: ' + JSON.stringify(r)); return; }
  startWindow();          // 服务模式：先把监视窗口点起来，再开始听
  chatWatch();            // 聊天监听：游戏里打字也算指令（语音识别错字时的兜底）
  if (APPCFG.features && APPCFG.features.voice === false) {
    log('纯文字模式（config.json features.voice=false）：不开耳朵不录音，游戏里打字就能指挥；进程靠聊天监听保活。');
    return;               // chatWatch 的 setInterval 会保持进程存活
  }
  await earLoop();
})().catch(e => { log('崩了: ' + (e && e.stack || e)); try { fs.writeFileSync(PAUSEFILE, '异常退出: ' + (e && e.stack || e), 'utf8'); } catch { } process.exit(1); });
