// say_to_call.cjs —— 把一句中文用神经语音念出来并灌进微信麦克风（虚拟声卡 CABLE Input）
// 用法: node say_to_call.cjs "要说的中文" [音色] [pitch] [rate]
// 音色缺省读 voice_choice.txt（没有就用 zh-CN-XiaoxiaoNeural）；
// 在线合成失败时自动回退到本机 WinRT 语音（tts.ps1 -Voice Yaoyao），保证通话不断。
const fs = require('fs');
const path = require('path');
const ChildProcess = require('child_process');

const DIR = __dirname;
const EDGE = path.join(DIR, 'edge_tts.cjs');
const AUDIO = path.join(DIR, 'audioio.exe');
const TTS_PS1 = path.join(DIR, 'tts.ps1');
const CHOICE = path.join(DIR, 'voice_choice.txt');
const TMP_WAV = path.join(DIR, 'say_now.wav');
const TMP_TXT = path.join(DIR, 'say_now.txt');

function chosenVoice() {
    try { const v = fs.readFileSync(CHOICE, 'utf8').trim(); if (v) return v; } catch { }
    return 'zh-CN-XiaoxiaoNeural';
}

const text = process.argv[2];
if (!text) { console.error('用法: node say_to_call.cjs "要说的中文" [音色] [pitch] [rate]'); process.exit(2); }
// 常用别名：说「粤语」= 曉佳(zh-HK-HiuGaaiNeural)，方便偶尔切过去
const ALIAS = {
    'yue': 'zh-HK-HiuGaaiNeural', '粤语': 'zh-HK-HiuGaaiNeural', 'cantonese': 'zh-HK-HiuGaaiNeural', 'huigaai': 'zh-HK-HiuGaaiNeural',
    '晓伊': 'zh-CN-XiaoyiNeural', 'xiaoyi': 'zh-CN-XiaoyiNeural',
    '晓晓': 'zh-CN-XiaoxiaoNeural', 'xiaoxiao': 'zh-CN-XiaoxiaoNeural'
};
let voice = process.argv[3] || chosenVoice();
voice = ALIAS[String(voice).toLowerCase()] || voice;
const pitch = process.argv[4] || '+0Hz';
const rate = process.argv[5] || '+0%';
fs.writeFileSync(TMP_TXT, text, 'utf8');

const t0 = Date.now();
let ok = false;
const r1 = ChildProcess.spawnSync(process.execPath, [EDGE, 'say_wav', TMP_WAV, voice, TMP_TXT, pitch, rate], { stdio: 'inherit' });
if (r1.status === 0 && fs.existsSync(TMP_WAV)) ok = true;

if (!ok) {
    console.error('在线神经语音失败，回退本机语音');
    const r2 = ChildProcess.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TTS_PS1, '-TextFile', TMP_TXT, '-Out', TMP_WAV, '-Voice', 'Yaoyao'], { stdio: 'inherit' });
    if (r2.status !== 0 || !fs.existsSync(TMP_WAV)) { console.error('回退也失败，这次没说出来'); process.exit(1); }
}

const t1 = Date.now();
const r3 = ChildProcess.spawnSync(AUDIO, ['play', 'CABLE Input', TMP_WAV], { stdio: 'inherit' });
console.log(`已灌入麦克风（合成 ${t1 - t0}ms，播放 ${Date.now() - t1}ms，音色 ${ok ? voice : 'Yaoyao(回退)'}）`);
process.exit(r3.status === 0 ? 0 : 1);
