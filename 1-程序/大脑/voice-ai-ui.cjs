// voice-ai-ui.cjs —— 「独立大脑」的监视窗口
// 在 127.0.0.1 上起一个只对本机开放的小网页：看状态、看对话、看日志、看记忆，并做几个基础操作。
// 启动时可用 Edge 的 --app 模式打开成一个独立窗口（不是浏览器标签页）。
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const PAGE = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<title>小喵 · 游戏内独立大脑</title>',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>',
  ':root{--bg:#11141a;--card:#191d26;--line:#2a3040;--fg:#e6e9f0;--dim:#8b93a7;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#a78bfa}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}',
  'header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}',
  '.title{font-size:16px;font-weight:600;letter-spacing:.5px}',
  '.pill{border:1px solid var(--line);background:#141821;border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dim);white-space:nowrap}',
  '.pill.on{color:#0b1a10;background:var(--ok);border-color:var(--ok)}',
  '.pill.off{color:#1a0b0b;background:var(--bad);border-color:var(--bad)}',
  '.pill.warn{color:#1a1405;background:var(--warn);border-color:var(--warn)}',
  '.bar{display:flex;gap:8px;align-items:center;padding:10px 16px;flex-wrap:wrap;border-bottom:1px solid var(--line)}',
  'button{background:#232a38;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px}',
  'button:hover{background:#2c3446}button:active{transform:translateY(1px)}',
  'input[type=text]{background:#0e1117;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;min-width:320px}',
  'label{color:var(--dim);font-size:12px;display:flex;align-items:center;gap:4px}',
  '.hint{color:var(--dim);font-size:12px}',
  'main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px}',
  '@media(max-width:900px){main{grid-template-columns:1fr}}',
  '.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 12px}',
  'main .card{margin:0}h3{margin:0 0 8px;font-size:13px;color:var(--dim);font-weight:500}',
  '.scroll{height:300px;overflow:auto}',
  '.short{height:120px;overflow:auto}',
  '.mono{font:12px/1.5 Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:#c9d1e0}',
  '.who{color:var(--acc);font-weight:600}.who.me{color:#7dd3fc}',
  '.row{padding:3px 0;border-bottom:1px dashed #22283680}',
  '.t{color:#5d6577;font-size:11px;margin-right:6px}',
  'section.bottom{padding:0 16px 16px}',
  '</style></head><body>',
  '<header><div class="title">小喵 · 游戏内独立大脑</div><div id="pills"></div></header>',
  '<div class="bar">',
  '<button id="b-pause">暂停听</button>',
  '<button id="b-reload">重新读配置</button>',
  '<button id="b-clear">清空对话原文</button>',
  '<span class="hint" id="hint"></span>',
  '</div>',
  '<div class="bar">',
  '<label>token 上限</label>',
  '<input type="text" id="tk" placeholder="300" style="min-width:70px;width:70px">',
  '<button id="b-token">设 token</button>',
  '<button id="b-detailed">回复详细</button>',
  '<button id="b-brief">回复简短</button>',
  '<span class="hint" id="tk-now"></span>',
  '</div>',
  '<div class="bar">',
  '<input type="text" id="txt" placeholder="在这里打一句话（当作你在游戏里说的）">',
  '<label><input type="checkbox" id="announce" checked> 在游戏里回答</label>',
  '<button id="b-ask">发给大脑</button>',
  '<button id="b-say">只念这句</button>',
  '<button id="b-mem">存成长期记忆</button>',
  '<button id="b-bal">查 API 余额</button>',
  '</div>',
  '<main><div class="card"><h3>最近对话</h3><div id="turns" class="scroll"></div></div>',
  '<div class="card"><h3>日志</h3><pre id="log" class="scroll mono"></pre></div></main>',
  '<section class="bottom"><div class="card"><h3>长期记忆</h3><div id="mem" class="short"></div></div></section>',
  '<script>',
  'function esc(s){return String(s==null?"":s)}',
  'function el(id){return document.getElementById(id)}',
  'var lastLog="";',
  'function pills(st){',
  ' var out=[];',
  ' out.push(st.paused?["暂停中","warn"]:(st.keyOk?["在听","on"]:["等密钥","warn"]));',
  ' out.push(["模型 "+st.model,""]);',
  ' out.push([st.keyOk?"密钥已配置":"密钥未配置",""]);',
  ' out.push(["记忆 "+st.memCount+" 条",""]);',
  ' out.push(["对话 "+st.sessionTurns+" 轮",""]);',
  ' out.push(["运行 "+Math.floor(st.uptimeSec/60)+" 分 "+st.uptimeSec%60+" 秒",""]);',
  ' out.push(["模式 "+st.mode,""]);',
  ' out.push(["耳朵 "+st.device,""]);',
  ' if(st.usage){out.push(["API 今日 "+st.usage.todayCalls+" 次 / "+(st.usage.todayTokens||0)+" tokens",""]);out.push(["API 累计 "+st.usage.calls+" 次",""]);}',
  ' el("pills").innerHTML=out.map(function(p){return \'<span class="pill \'+p[1]+\'">\'+esc(p[0])+"</span>"}).join(" ");',
  '}',
  'function render(d){',
  ' pills(d.status);',
  ' el("b-pause").textContent=d.status.paused?"继续听":"暂停听";',
  ' var th="";',
  ' d.turns.forEach(function(t){',
  '  var who=t.role==="user"?\'<span class="who me">他</span>\':\'<span class="who">小喵</span>\';',
  '  var ts=new Date(t.ts||Date.now()).toTimeString().slice(0,8);',
  '  th+=\'<div class="row"><span class="t">\'+ts+"</span>"+who+" "+esc(t.text)+"</div>";',
  ' });',
  ' el("turns").innerHTML=th||\'<span class="hint">还没有对话</span>\';',
  ' el("turns").scrollTop=el("turns").scrollHeight;',
  ' var lg=d.log.join("\\n");',
  ' if(lg!==lastLog){lastLog=lg;el("log").textContent=lg;el("log").scrollTop=el("log").scrollHeight}',
  ' var mh="";',
  ' d.mem.forEach(function(m){',
  '  mh+=\'<div class="row"><span class="t">\'+m.kind+"/i"+m.importance+"</span>"+esc(m.text.slice(0,160))+"</div>";',
  ' });',
  ' el("mem").innerHTML=mh||\'<span class="hint">还没有长期记忆</span>\';',
  '}',
  'async function post(p,body){',
  ' try{var r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});return await r.json()}',
  ' catch(e){setHint("失败: "+e.message);return null}',
  '}',
  'function setHint(s){el("hint").textContent=s||""}',
  'async function tick(){try{var r=await fetch("/api/state");render(await r.json())}catch(e){setHint("连不上主程序了")}}',
  'el("b-pause").onclick=async function(){var d=await post("/api/pause",{});if(d)setHint(d.paused?"已暂停听":"已继续听")};',
  'el("b-reload").onclick=async function(){var d=await post("/api/reload",{});if(d)setHint(d.keyOk?"配置已重读：密钥已就位":"配置已重读：还没有密钥")};',
  'el("b-clear").onclick=async function(){if(!confirm("清空对话原文？长期记忆会保留。"))return;var d=await post("/api/clear-session",{});if(d)setHint("对话原文已清空")};',
  'el("b-ask").onclick=async function(){var t=el("txt").value.trim();if(!t)return;setHint("大脑在想…");var d=await post("/api/ask",{text:t,announce:el("announce").checked});if(d)setHint(d.ok?("答: "+d.reply):("出错: "+d.err));el("txt").value=""};',
  'el("b-say").onclick=async function(){var t=el("txt").value.trim();if(!t)return;await post("/api/say",{text:t});setHint("已让它念（听游戏里的声音）")};',
  'el("b-mem").onclick=async function(){var t=el("txt").value.trim();if(!t)return;var d=await post("/api/mem",{text:t});if(d)setHint("已存长期记忆 "+d.id);el("txt").value=""};',
  'el("b-bal").onclick=async function(){setHint("查余额…");var d=await post("/api/balance",{});setHint(d&&d.text?d.text:"查不到")};',
  'el("b-token").onclick=async function(){var v=el("tk").value.trim();if(!v)return;var d=await post("/api/token",{tokens:v});if(d){if(d.ok){setHint("token 已设为 "+d.maxTokens+"（约 "+d.maxReplyChars+" 字）");el("tk-now").textContent="当前 "+d.maxTokens}else{setHint(d.msg||"设置失败")}}};',
  'el("b-detailed").onclick=async function(){var d=await post("/api/token",{tokens:800});if(d&&d.ok){setHint("已放宽到 800 token");el("tk").value="800";el("tk-now").textContent="当前 800"}else{setHint(d&&d.msg||"失败")}};',
  'el("b-brief").onclick=async function(){var d=await post("/api/token",{tokens:200});if(d&&d.ok){setHint("已收紧到 200 token");el("tk").value="200";el("tk-now").textContent="当前 200"}else{setHint(d&&d.msg||"失败")}};',
  'el("txt").addEventListener("keydown",function(e){if(e.key==="Enter")el("b-ask").click()});',
  'tick();setInterval(tick,1000);',
  '</script></body></html>',
].join('\n');

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, obj) { send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function startUi(opts) {
  const { ctx, port, autoOpen, log } = opts;
  let lastErr = '';
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', PAGE);
      if (req.method === 'GET' && url === '/api/state') {
        return json(res, {
          ok: true, status: ctx.status(),
          turns: ctx.recentTurns(24), log: ctx.logTail(60), mem: ctx.listMem(15).slice().reverse(),
        });
      }
      if (req.method === 'POST') {
        const raw = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => r(b)); });
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch { }
        if (url === '/api/ask') { const r = await ctx.ask(String(body.text || ''), body.announce !== false); return json(res, r); }
        if (url === '/api/say') { ctx.say(String(body.text || '')); return json(res, { ok: true }); }
        if (url === '/api/mem') { const e = ctx.remember(String(body.text || '')); return json(res, { ok: !!e, id: e ? e.id : '' }); }
        if (url === '/api/pause') { const p = await ctx.togglePause(); return json(res, { ok: true, paused: p }); }
        if (url === '/api/reload') { const c = ctx.reloadCfg(); return json(res, { ok: true, keyOk: c.keyOk }); }
        if (url === '/api/clear-session') { ctx.clearSession(); return json(res, { ok: true }); }
        if (url === '/api/balance') { return json(res, { ok: true, text: await ctx.balance() }); }
        if (url === '/api/token') { return json(res, ctx.setToken(body.tokens)); }
        if (url === '/api/rcmd') { return json(res, { ok: true, text: await ctx.rcmd(String(body.cmd || '')) }); }
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      send(res, 500, 'text/plain; charset=utf-8', 'ERR ' + (e && e.message));
    }
  });
  server.on('error', (e) => { lastErr = e.message; log('监视窗口起不来: ' + e.message); });
  server.listen(port, '127.0.0.1', () => {
    const u = 'http://127.0.0.1:' + port + '/';
    log('监视窗口已开: ' + u);
    if (autoOpen) openWindow(u, log);
  });
  return server;
}

function openWindow(url, log) {
  const os = require('os');
  const profile = os.tmpdir() + '\\mew-ai-ui';   // 独立 Edge profile，方便 stop-all 精确关掉这扇窗口
  const tries = [
    ['cmd', ['/c', 'start', '', 'msedge', '--app=' + url, '--user-data-dir=' + profile]],
    ['cmd', ['/c', 'start', '', url]],
  ];
  for (const [cmd, args] of tries) {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => { });
      p.unref();
      log('已尝试打开窗口: ' + cmd + ' ' + args.join(' '));
      return true;
    } catch (e) { log('开窗口失败: ' + e.message); }
  }
  return false;
}

module.exports = { startUi, PAGE };
