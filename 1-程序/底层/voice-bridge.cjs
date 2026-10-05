// voice-bridge.cjs —— 小喵在 MC 里的「耳朵」：把 SVC 收进来的队友语音（渲染到 Steam 哑音箱，环回可录）
// 切成句子 → SenseVoice 本地识别 → 交给大脑。
// 用法：
//   node voice-bridge.cjs                 默认：只打日志（识别到什么写 voice-out.log，不花钱）
//   node voice-bridge.cjs --dsh           额外写 voice_in.json（配一个 dsh-voice-in 插件实例即可投进会话）
//   node voice-bridge.cjs --echo          复读模式：识别到什么就用 TTS 说回麦克风（0 token 联调）
//   node voice-bridge.cjs --wake 小喵     只有句子里含「小喵」才转发（省钱闸门）
// 可选：--device "Steam Streaming Speakers"  --db -48  --cooldown 2  --debug
// 日志：voice-bridge.log（每次启动追加，在本文件所在目录）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const CFGJ = require('../cfg.cjs');

const DIR = __dirname;
const AIO = path.join(CFGJ.need('paths', 'voiceToolDir'), 'audioio.exe');
const SAY = path.join(CFGJ.need('paths', 'voiceToolDir'), 'say_to_call.cjs');
const ADDON = CFGJ.load().paths.sherpaNode || '';
const MODEL_DIR = CFGJ.load().paths.sensevoiceModelDir || '';
const LOG = path.join(DIR, 'voice-bridge.log');
const VOICE_IN = path.join(DIR, 'voice-in.json');
const OUT_LOG = path.join(DIR, 'voice-out.log');
const CHUNK_WAV = path.join(DIR, 'ear-chunk.wav');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? def) : def; }
const DEVICE = arg('--device', '');
if (!DEVICE) { console.error('[配置] 还没指定要监听的声音设备：node voice-bridge.cjs --device "设备名"（系统声音设置里能看到的名字，如耳机/虚拟声卡）'); process.exit(1); }
const DB_SPEECH = Number(arg('--db', -48));
const COOLDOWN = Number(arg('--cooldown', 2));
const WAKE = arg('--wake', '');
const WAKE_ALIAS = ['小喵', '小苗', '喵喵', '喵', '听得到', '听得见', '听到吗', '你在吗', '在吗']; // 唤醒词别名：不方便喊名字时，问「听得到吗」也算叫我
const WAKE_WINDOW = Number(arg('--wake-window', 90));  // 唤醒后这么多秒内一直听着（不用每句都喊）
const DEBUG = process.argv.includes('--debug');
const ECHO = process.argv.includes('--echo');
const DSH = process.argv.includes('--dsh');

const SR = 16000, FRAME = 1600, CHUNK = 4;
const HANG = 8, MIN_SPEECH = 4, MAX_UTTER = 25 * SR;

function log(s) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + s;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
}

let seq = 0;
try { seq = Number(JSON.parse(fs.readFileSync(VOICE_IN, 'utf8')).seq) || 0; } catch { }

const addon = require(ADDON);
const rec = addon.createOfflineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: MODEL_DIR + '\\model.int8.onnx', language: 'zh', useInverseTextNormalization: 1 },
    tokens: MODEL_DIR + '\\tokens.txt', numThreads: 2, provider: 'cpu', debug: 0,
  },
  decodingMethod: 'greedy_search',
});

function frameDb(samples, off, len) {
  let sum = 0, n = 0;
  for (let i = off; i < off + len && i < samples.length; i++) { const v = samples[i]; sum += v * v; n++; }
  if (!n) return -100;
  const r = Math.sqrt(sum / n);
  return r <= 1e-7 ? -100 : 20 * Math.log10(r);
}

function recognize(samples) {
  const s = addon.createOfflineStream(rec);
  addon.acceptWaveformOffline(s, { samples: samples, sampleRate: SR });
  addon.decodeOfflineStream(rec, s);
  const json = addon.getOfflineStreamResultAsJson(s);
  try { const o = JSON.parse(json); return (o.text || '').trim(); } catch { return ''; }
}

// —— 交给大脑 ——
function toBrain(text) {
  if (DSH) {
    seq++;
    try { fs.writeFileSync(VOICE_IN, JSON.stringify({ seq: seq, text: text, ts: Date.now() }), 'utf8'); } catch (e) { log('写 voice_in.json 失败: ' + e.message); return; }
    log('已投进会话(seq=' + seq + '): ' + text);
    return;
  }
  try { fs.appendFileSync(OUT_LOG, new Date().toISOString() + '\t' + text + '\n', 'utf8'); } catch { }
  log('（未开 --dsh，只记录）: ' + text);
}

function speak(text) {
  const r = spawnSync(process.execPath, [SAY, text], { stdio: 'ignore' });
  if (r.status !== 0) log('TTS/灌音失败 status=' + r.status);
}

log('=== 耳朵启动 device=' + DEVICE + ' 阈值=' + DB_SPEECH + 'dB 模式=' + (ECHO ? 'echo' : DSH ? 'dsh' : 'log') + (WAKE ? ' 唤醒词=' + WAKE : '') + ' ===');

let utter = [], silence = 0, speaking = false, totalSpeech = 0, lastText = '', lastAt = 0, chunks = 0, awakeUntil = 0;

for (;;) {
  const r = spawnSync(AIO, ['looprec', CHUNK_WAV, String(CHUNK), DEVICE], { encoding: 'utf8' });
  if (r.status !== 0) { log('录音失败: ' + String(r.stderr || r.stdout || '').slice(0, 200)); continue; }
  let wave;
  try { wave = addon.readWave(CHUNK_WAV); } catch (e) { log('读 WAV 失败: ' + e.message); continue; }
  const samples = wave.samples;
  chunks++;
  if (DEBUG && !speaking) log('chunk#' + chunks + ' ' + (samples.length / SR).toFixed(2) + 's 峰值帧 ' + frameDb(samples, 0, Math.min(FRAME, samples.length)).toFixed(1) + ' dB');

  for (let off = 0; off < samples.length; off += FRAME) {
    const db = frameDb(samples, off, FRAME);
    const isSpeech = db > DB_SPEECH;
    if (isSpeech) {
      if (!speaking) { speaking = true; totalSpeech = 0; utter = []; }
      silence = 0;
      utter.push(samples.subarray(off, Math.min(off + FRAME, samples.length)));
      totalSpeech += Math.min(FRAME, samples.length - off);
    } else if (speaking) {
      silence++;
      utter.push(samples.subarray(off, Math.min(off + FRAME, samples.length)));
      if (silence >= HANG || totalSpeech > MAX_UTTER) {
        const need = Math.max(0, utter.length - (HANG - 1));
        const kept = utter.slice(0, Math.max(need, 1));
        let len = 0; for (const k of kept) len += k.length;
        const buf = new Float32Array(len);
        let p = 0; for (const k of kept) { buf.set(k, p); p += k.length; }
        speaking = false; silence = 0; utter = [];
        if (totalSpeech >= MIN_SPEECH * FRAME) {
          const t0 = Date.now();
          const text = recognize(buf);
          log('识别(' + ((Date.now() - t0) / 1000).toFixed(2) + 's / ' + (len / SR).toFixed(1) + 's 音频): ' + (text || '(空)'));
          if (text && text.length >= 2) {
            const now = Date.now();
            const woke = !!WAKE && WAKE_ALIAS.some(w => text.includes(w));
            if (text === lastText && now - lastAt < COOLDOWN * 1000) log('重复句，跳过');
            else if (WAKE && !woke && now >= awakeUntil) log('没叫小喵，先不打扰大脑（省钱；唤醒后 ' + WAKE_WINDOW + 's 内一直听着）');
            else {
              if (woke) { awakeUntil = now + WAKE_WINDOW * 1000; log('被叫醒了（' + WAKE_WINDOW + 's 内继续听）'); }
              lastText = text; lastAt = now;
              if (ECHO) speak('我听到你说：' + text);
              else toBrain(text);
            }
          }
        }
        totalSpeech = 0;
      }
    }
  }
}
