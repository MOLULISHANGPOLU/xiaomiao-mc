// edge_tts.cjs —— 微软 Edge 神经语音合成（零下载：ws 模块已随仓库附带在 node_modules\ws）
// 用法:
//   node edge_tts.cjs list
//   node edge_tts.cjs say <out.wav> <voice> <文本文件> [pitch] [rate] [volume]
// 说明: 直接向 Edge 的朗读服务要 riff-16khz-16bit-mono-pcm，落地就是标准 WAV，
//       不需要 ffmpeg（本机没有 ffmpeg），audioio.exe 可以直接播。
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const ChildProcess = require('child_process');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));   // 仓库自带

const DIR = __dirname;
const MFDECODE = path.join(DIR, 'mfdecode.exe');

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// Sec-MS-GEC-Version 必须跟一个"真实存在且足够新"的 Edge 版本，否则服务端直接 403。
// 本机装着 Edge，直接读它的版本，以后 Edge 自动更新也跟着变。
function detectEdgeVersion() {
    const roots = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application', 'C:\\Program Files\\Microsoft\\Edge\\Application'];
    const found = [];
    for (const root of roots) {
        try {
            for (const name of fs.readdirSync(root)) {
                if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) found.push(name);
            }
        } catch { }
    }
    if (!found.length) return '130.0.2849.68';
    found.sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
    });
    return found[0];
}
const EDGE_VERSION = detectEdgeVersion();
const EDGE_MAJOR = EDGE_VERSION.split('.')[0];
const GEC_VERSION = '1-' + EDGE_VERSION;
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`;
// 服务端已不接受 riff-*/raw-* 之类的 PCM 包装格式（会回 1007 Unsupported Edge output format），
// 这里用 16k 单声道 MP3，再由 wav_from_mp3 转成 WAV（见下方 mf 部分）。
const OUTPUT_FORMAT = process.env.EDGE_FMT || 'audio-24khz-48kbitrate-mono-mp3';

const VOICES = [
    ['zh-CN-XiaoxiaoNeural', '晓晓 · 女 · 温柔自然（微软招牌音色，最常用）'],
    ['zh-CN-XiaoyiNeural', '晓伊 · 女 · 活泼俏皮少女'],
    ['zh-CN-YunxiNeural', '云希 · 男 · 阳光少年'],
    ['zh-CN-YunyangNeural', '云扬 · 男 · 专业播报'],
    ['zh-CN-YunjianNeural', '云健 · 男 · 激情解说'],
    ['zh-CN-YunxiaNeural', '云夏 · 男 · 可爱童声'],
    ['zh-CN-liaoning-XiaobeiNeural', '晓北 · 女 · 东北话（幽默）'],
    ['zh-CN-shaanxi-XiaoniNeural', '晓妮 · 女 · 陕西话（明亮）'],
    ['zh-TW-HsiaoChenNeural', '曉臻 · 女 · 台湾国语（温柔）'],
    ['zh-TW-HsiaoYuNeural', '曉雨 · 女 · 台湾国语（甜）'],
    ['zh-TW-YunJheNeural', '雲哲 · 男 · 台湾国语'],
    ['zh-HK-HiuGaaiNeural', '曉佳 · 女 · 粤语'],
    ['zh-HK-HiuMaanNeural', '曉曼 · 女 · 粤语'],
    ['zh-HK-WanLungNeural', '雲龍 · 男 · 粤语'],
];

function gec() {
    const ticks = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n;
    const rounded = ticks - (ticks % 3000000000n);
    return crypto.createHash('sha256').update(rounded.toString() + TRUSTED_TOKEN, 'ascii').digest('hex').toUpperCase();
}
// X-Timestamp 必须是微软那套 JS 风格的时间串（edge-tts 也照抄这个格式），否则服务端回 1007。
function stamp() {
    const d = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = (n) => String(n).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} `
        + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function synth({ out, voice, text, pitch = '+0Hz', rate = '+0%', volume = '+0%', timeoutMs = 30000 }) {
    return new Promise((resolve, reject) => {
        const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
            + `?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}`
            + `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;
        const ws = new WebSocket(url, {
            headers: {
                'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                'User-Agent': CHROME_UA,
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
            },
            handshakeTimeout: 15000,
        });
        const chunks = [];
        const rid = crypto.randomUUID().replace(/-/g, '');
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.terminate(); } catch { } reject(new Error('超时（未收到 turn.end）')); } }, timeoutMs);
        const done = (err) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            try { ws.close(); } catch { }
            if (err) return reject(err);
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(out, buf);
            resolve(buf.length);
        };

        ws.on('open', () => {
            ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
                + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } }));
            const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
                + `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${esc}</prosody></voice></speak>`;
            ws.send(`X-RequestId:${rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}\r\nPath:ssml\r\n\r\n${ssml}`);
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (buf.length < 2) return;
                const headerLen = buf.readUInt16BE(0);
                const header = buf.slice(2, 2 + headerLen).toString('utf8');
                if (/Path:\s*audio/i.test(header)) chunks.push(buf.slice(2 + headerLen));
            } else {
                const txt = data.toString('utf8');
                if (/Path:\s*turn\.end/i.test(txt)) done(null);
                else if (/Path:\s*(response|turn\.start|audio\.metadata)/i.test(txt) === false) console.error('[服务端文本] ' + txt.slice(0, 400).replace(/\r?\n/g, ' | '));
                else if (!/Path:\s*audio\.metadata/i.test(txt)) console.error('[服务端] ' + txt.slice(0, 200).replace(/\r?\n/g, ' | '));
            }
        });
        ws.on('error', (err) => done(new Error('websocket: ' + (err?.message ?? err))));
        ws.on('unexpected-response', (_req, res) => done(new Error('握手被拒: HTTP ' + res.statusCode)));
        ws.on('close', (code, reason) => {
            if (!settled && !chunks.length) done(new Error(`连接被关闭 code=${code} reason=${reason?.toString?.() ?? ''}`));
            else done(null);
        });
    });
}

(async () => {
    const [cmd, out, voice, textFile, pitch, rate, vol] = process.argv.slice(2);
    if (cmd === 'list') { for (const [v, d] of VOICES) console.log(v.padEnd(42) + d); return; }
    if (cmd !== 'say' && cmd !== 'say_wav') { console.error('用法: node edge_tts.cjs say|say_wav <out.wav> <voice> <文本文件> [pitch] [rate] [volume]'); process.exit(2); }
    const text = fs.readFileSync(textFile, 'utf8').replace(/\s+$/, '');
    const t0 = Date.now();
    let target = out;
    let tmpMp3 = null;
    if (cmd === 'say_wav') { tmpMp3 = out + '.mp3'; target = tmpMp3; }
    const bytes = await synth({ out: target, voice, text, pitch, rate, volume: vol });
    if (cmd === 'say_wav') {
        const r = ChildProcess.spawnSync(MFDECODE, [tmpMp3, out], { stdio: 'inherit' });
        try { fs.unlinkSync(tmpMp3); } catch { }
        if (r.status !== 0) { console.error('解码失败'); process.exit(1); }
    }
    console.log(`OK ${out}（${Date.now() - t0}ms，音色 ${voice}）`);
})().catch((e) => { console.error('失败: ' + (e?.message ?? e)); process.exit(1); });
