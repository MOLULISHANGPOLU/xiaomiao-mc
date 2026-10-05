// say-mc.cjs —— 小喵在 Minecraft 里的嘴（MC 专用固定音色）
// 用法: node say-mc.cjs "要说的中文"
// 音色读同目录 voice_choice_mc.txt（默认 zh-CN-XiaoxiaoNeural 晓晓）；
// 真正的合成与播放交给 wechat-voice 工具目录里的 say_to_call.cjs（config.json 的 paths.voiceToolDir）：
//   edge_tts 合成 → audioio.exe play "CABLE Input" → 游戏里 SVC 把 CABLE Output 当麦克风听进去 → 他耳机里听到。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const CHOICE = path.join(DIR, 'voice_choice_mc.txt');
const SAY = path.join(require('../cfg.cjs').need('paths', 'voiceToolDir'), 'say_to_call.cjs');

let voice = 'zh-CN-XiaoxiaoNeural';
try { const v = fs.readFileSync(CHOICE, 'utf8').trim(); if (v) voice = v; } catch { }

const text = process.argv[2];
if (!text) { console.error('用法: node say-mc.cjs "要说的中文"'); process.exit(2); }

const r = spawnSync(process.execPath, [SAY, text, voice], { stdio: 'inherit' });
process.exit(r.status === 0 ? 0 : 1);
