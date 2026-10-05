// voice-ai-cmds.cjs —— 小喵的「手脚」：A/B 共 20 多条固定指令，全部本地匹配，0 token
// 分工：
//   走路的活儿  → 隐藏桌面代理（hd-agent）往 LittleMew 的聊天框里敲 Baritone 命令（#follow / #mine …）
//   世界的活儿  → 服务器控制台 RCON（给东西、查背包、查坐标、时间天气）
// 说话人姓名从 config.json 读：players.user=用户的游戏名，players.bot=小喵的身体（成品模组固定 LittleMew）。
// 这里是"听不懂就交给 AI"的兜底之外的第一道闸门：命令越直白越先走本地，不花一分钱。
const fs = require('fs');
const path = require('path');

const CFGJ = require('../cfg.cjs');                 // 统一配置（仓库根 config.json）
const MC = path.join(__dirname, '..', '底层');      // 底层脚本目录（本文件的固定搭档）
const HDREQ = path.join(MC, 'hd-req.txt');
const HDRES = path.join(MC, 'hd-res.txt');
const CLOG = path.join(CFGJ.need('paths', 'minecraftDir'), 'versions', CFGJ.need('paths', 'mewVersionDir'), 'logs', 'latest.log');
const STATEFILE = path.join(__dirname, 'ai-memory', 'state.json');
const PLAYER = CFGJ.need('players', 'user');        // 你的游戏名
const CLIENT = CFGJ.load().players.bot || 'LittleMew';
const CFGFILE = path.join(__dirname, 'voice-ai.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ───────── token 动态调整：改 CFG.maxTokens/maxReplyChars/persona 并写回 voice-ai.json ─────────
function saveCfg(cfg) {
  try {
    const cur = JSON.parse(fs.readFileSync(CFGFILE, 'utf8'));
    cur.maxTokens = cfg.maxTokens;
    cur.maxReplyChars = cfg.maxReplyChars;
    cur.persona = cfg.persona;
    fs.writeFileSync(CFGFILE, JSON.stringify(cur, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
}
function applyTokenStyle(ctx, tokens, chars) {
  ctx.CFG.maxTokens = tokens;
  ctx.CFG.maxReplyChars = chars;
  ctx.CFG.persona = ctx.CFG.persona.replace(/不超过\s*\d+\s*个字/, '不超过 ' + Math.max(10, chars) + ' 个字');
  return saveCfg(ctx.CFG);
}

// ───────── 隐藏桌面通道（等价于 hd-send.ps1，但走 Node，省掉每次开 PowerShell 的钱）─────────
async function hdSend(cmd, timeoutMs = 25000) {
  try { fs.rmSync(HDRES, { force: true }); } catch { }
  try { fs.writeFileSync(HDREQ, cmd, 'utf8'); } catch (e) { return 'ERR 写请求文件失败: ' + e.message; }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    try {
      if (fs.existsSync(HDRES)) {
        const t = fs.readFileSync(HDRES, 'utf8').trim();
        if (t) return t;
      }
    } catch { }
  }
  return 'ERR 代理没回应（hd-agent 没在跑？）';
}

// ───────── 客户端日志（读 Baritone 的回话：find / eta 这类结果只在游戏里打印）─────────
function logSize() { try { return fs.statSync(CLOG).size; } catch { return 0; } }
function logTailFrom(off, maxBytes = 65536) {
  try {
    const st = fs.statSync(CLOG);
    let start = (st.size < off || !off) ? Math.max(0, st.size - maxBytes) : off;   // 日志被轮转过就从尾巴读
    const len = Math.min(st.size - start, maxBytes);
    if (len <= 0) return '';
    const fd = fs.openSync(CLOG, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
function baritoneLines(text) {
  return String(text).split('\n')
    .filter(l => /\[Baritone\]/.test(l))
    .map(l => l.replace(/^.*\[Baritone\]\s*/, '').trim())
    .filter(l => l && !l.startsWith('>') && !/^\[STDOUT\]/.test(l));
}

// ───────── 服务器指令 ─────────
async function srv(ctx, cmd) { return String(await ctx.rcon(cmd)); }
async function online(ctx) { return (await srv(ctx, 'list')).includes(CLIENT); }
const OFFLINE = '我现在没在游戏里，先双击桌面上的「小喵」把我拉起来吧。';

// ───────── Baritone：把命令敲进 LittleMew 的聊天框，并把它的回话捞回来 ─────────
async function baritone(ctx, cmd, opts = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const off = logSize();
    const r = await hdSend('chat ' + cmd, opts.timeout || 20000);
    if (/^ERR/.test(r)) return { ok: false, err: r, said: [] };
    if (/no GLFW30 window/.test(r)) return { ok: false, err: '客户端窗口没找到', said: [] };
    await sleep(opts.wait || 1200);
    const said = baritoneLines(logTailFrom(off));
    const bad = said.some(l => /No valid entities|Unable to find|no block|cancel|Failed/i.test(l));
    // 输入框残留会让命令串味（曾把 "#eta" 变成 "eta#e"）→ 清干净重发一次，还不行就把结果交回去
    if (attempt === 1 && said.some(l => /Command not found/i.test(l))) { await sleep(500); continue; }
    return { ok: true, said, bad };
  }
}

// ───────── 战斗模组：往 LittleMew 聊天框敲 /mewfight（MewFightMod 客户端命令，回话前缀 [小喵战斗]）─────────
async function mewfight(ctx, sub) {
  const off = logSize();
  const r = await hdSend('chat /mewfight ' + sub, 20000);
  if (/^ERR/.test(r)) return { ok: false, err: r };
  if (/no GLFW30 window/.test(r)) return { ok: false, err: '客户端窗口没找到' };
  await sleep(800);
  const hit = logTailFrom(off).split('\n').filter(l => l.includes('[小喵战斗]')).pop();
  return { ok: true, said: hit };
}

// ───────── 位置 / 背包 ─────────
function nbtVec(txt) {
  const m = String(txt).match(/\[\s*(-?[\d.]+)[df]?\s*,\s*(-?[\d.]+)[df]?\s*,\s*(-?[\d.]+)[df]?\s*\]/);
  return m ? { x: Math.round(+m[1]), y: Math.round(+m[2]), z: Math.round(+m[3]) } : null;
}
async function posOf(ctx, name) { return nbtVec(await srv(ctx, 'data get entity ' + name + ' Pos')); }

const CN = {
  oak_log: '橡木原木', spruce_log: '云杉原木', birch_log: '白桦原木', jungle_log: '丛林木', acacia_log: '金合欢木', dark_oak_log: '深色橡木', cherry_log: '樱花木', mangrove_log: '红树木',
  oak_planks: '橡木木板', spruce_planks: '云杉木板', birch_planks: '白桦木板', jungle_planks: '丛林木板', acacia_planks: '金合欢木板', dark_oak_planks: '深色橡木板', cherry_planks: '樱花木板', mangrove_planks: '红树木板',
  oak_leaves: '橡树叶', spruce_leaves: '云杉叶', birch_leaves: '白桦叶', jungle_leaves: '丛林叶', acacia_leaves: '金合欢叶', dark_oak_leaves: '深色橡叶', cherry_leaves: '樱花叶', mangrove_leaves: '红树叶',
  dirt: '泥土', grass_block: '草方块', stone: '石头', cobblestone: '圆石', deepslate: '深板岩', gravel: '砂砾', sand: '沙子', sandstone: '砂岩', granite: '花岗岩', diorite: '闪长岩', andesite: '安山岩', basalt: '玄武岩', tuff: '凝灰岩', calcite: '方解石', clay: '黏土块', moss_block: '苔藓块', netherrack: '下界岩', soul_sand: '灵魂沙', glowstone: '萤石', blackstone: '黑石',
  coal: '煤炭', charcoal: '木炭', iron_ingot: '铁锭', gold_ingot: '金锭', copper_ingot: '铜锭', diamond: '钻石', emerald: '绿宝石', lapis_lazuli: '青金石', redstone: '红石', quartz: '石英', netherite_ingot: '下界合金锭', netherite_scrap: '下界合金碎片',
  raw_iron: '粗铁', raw_gold: '粗金', raw_copper: '粗铜', coal_ore: '煤矿石', iron_ore: '铁矿石', diamond_ore: '钻石矿石', emerald_ore: '绿宝石矿石', lapis_ore: '青金石矿石', redstone_ore: '红石矿石', gold_ore: '金矿石', copper_ore: '铜矿石', deepslate_diamond_ore: '深层钻石矿', deepslate_iron_ore: '深层铁矿', deepslate_coal_ore: '深层煤矿', deepslate_gold_ore: '深层金矿', deepslate_copper_ore: '深层铜矿', deepslate_redstone_ore: '深层红石矿', deepslate_lapis_ore: '深层青金石矿', deepslate_emerald_ore: '深层绿宝石矿', nether_quartz_ore: '下界石英矿', ancient_debris: '远古残骸',
  stick: '木棍', torch: '火把', rotten_flesh: '腐肉', leaf_litter: '落叶', bone: '骨头', string: '线', feather: '羽毛', leather: '皮革', wheat: '小麦', wheat_seeds: '小麦种子', carrot: '胡萝卜', potato: '土豆', beetroot: '甜菜根', sugar: '糖', bone_meal: '骨粉', ink_sac: '墨囊', glow_ink_sac: '荧光墨囊',
  apple: '苹果', bread: '面包', cooked_beef: '熟牛肉', beef: '生牛肉', porkchop: '生猪排', cooked_porkchop: '熟猪排', chicken: '生鸡肉', cooked_chicken: '熟鸡肉', mutton: '生羊肉', cooked_mutton: '熟羊肉', rabbit: '生兔肉', cooked_rabbit: '熟兔肉', cod: '生鳕鱼', cooked_cod: '熟鳕鱼', salmon: '生鲑鱼', cooked_salmon: '熟鲑鱼', egg: '鸡蛋', milk_bucket: '奶桶', sweet_berries: '甜浆果', glow_berries: '发光浆果', melon_slice: '西瓜片', melon: '西瓜', pumpkin: '南瓜', baked_potato: '烤土豆', dried_kelp: '干海带', golden_apple: '金苹果', golden_carrot: '金胡萝卜', honey_bottle: '蜂蜜瓶', cookie: '曲奇', cake: '蛋糕', mushroom_stew: '蘑菇煲', beetroot_soup: '甜菜汤',
  wooden_pickaxe: '木镐', wooden_axe: '木斧', wooden_sword: '木剑', wooden_shovel: '木锹', wooden_hoe: '木锄', stone_pickaxe: '石镐', stone_axe: '石斧', stone_sword: '石剑', stone_shovel: '石锹', stone_hoe: '石锄', iron_pickaxe: '铁镐', iron_axe: '铁斧', iron_sword: '铁剑', iron_shovel: '铁锹', iron_hoe: '铁锄', golden_pickaxe: '金镐', golden_axe: '金斧', golden_sword: '金剑', golden_shovel: '金锹', golden_hoe: '金锄', diamond_pickaxe: '钻石镐', diamond_axe: '钻石斧', diamond_sword: '钻石剑', diamond_shovel: '钻石锹', diamond_hoe: '钻石锄', netherite_pickaxe: '下界合金镐', netherite_axe: '下界合金斧', netherite_sword: '下界合金剑', netherite_shovel: '下界合金锹', netherite_hoe: '下界合金锄', shield: '盾牌', bucket: '桶', water_bucket: '水桶', lava_bucket: '熔岩桶', shears: '剪刀', fishing_rod: '钓鱼竿',
  arrow: '箭', bow: '弓', flint: '燧石', gunpowder: '火药', slime_ball: '黏液球', ender_pearl: '末影珍珠', ender_eye: '末影之眼', blaze_rod: '烈焰棒', obsidian: '黑曜石', crying_obsidian: '哭泣黑曜石', flint_and_steel: '打火石', magma_cream: '岩浆膏', ghast_tear: '恶魂之泪', phantom_membrane: '幻翼膜', nether_wart: '下界疣', totem_of_undying: '不死图腾', elytra: '鞘翅',
  crafting_table: '工作台', furnace: '熔炉', chest: '箱子', white_bed: '白色床', ladder: '梯子', oak_door: '橡木门', iron_door: '铁门', oak_fence: '橡木栅栏', oak_fence_gate: '橡木栅栏门', glass: '玻璃', glass_pane: '玻璃板', bookshelf: '书架', anvil: '铁砧', enchanting_table: '附魔台', tnt: 'TNT', piston: '活塞', sticky_piston: '黏性活塞', dispenser: '发射器', dropper: '投掷器', hopper: '漏斗', rail: '铁轨', powered_rail: '动力铁轨', minecart: '矿车', chest_minecart: '箱子矿车', oak_boat: '橡木船', boat: '船', saddle: '鞍', lead: '拴绳', bowl: '碗', campfire: '营火', lantern: '灯笼', compass: '指南针', clock: '时钟', map: '地图', painting: '画', item_frame: '物品展示框', oak_sign: '橡木告示牌', sign: '告示牌',
  oak_sapling: '橡树苗', spruce_sapling: '云杉树苗', birch_sapling: '白桦树苗', jungle_sapling: '丛林树苗', acacia_sapling: '金合欢树苗', dark_oak_sapling: '深色橡树苗', cherry_sapling: '樱花树苗', mangrove_propagule: '红树繁殖体', bamboo: '竹子', sugar_cane: '甘蔗', cactus: '仙人掌', kelp: '海带', paper: '纸', book: '书', cobweb: '蜘蛛网', clay_ball: '黏土球', brick: '砖', snowball: '雪球', hay_block: '干草块',
};
const cn = (id) => CN[String(id).replace(/^minecraft:/, '')] || String(id).replace(/^minecraft:/, '').replace(/_/g, ' ');
function invParse(txt) {
  const out = [];
  for (const chunk of String(txt).match(/\{[^{}]*\}/g) || []) {
    const idm = chunk.match(/id:\s*"([^"]+)"/) || chunk.match(/id:\s*([a-z_]+)/i);
    if (!idm) continue;
    const cm = chunk.match(/count:\s*(\d+)/);
    out.push({ id: String(idm[1]).replace(/^minecraft:/, ''), count: cm ? Number(cm[1]) : 1 });
  }
  return out;
}
async function inventory(ctx, name) { return invParse(await srv(ctx, 'data get entity ' + name + ' Inventory')); }
async function invLine(ctx, name) {
  const items = await inventory(ctx, name);
  if (!items.length) return null;
  return items.slice(0, 6).map(i => cn(i.id) + (i.count > 1 ? '×' + i.count : '')).join('、');
}

// ───────── 合成：Baritone 没有 #craft，用 RCON 模拟（查材料→扣材料→给产物，绝不凭空变）─────────
const CRAFT = {
  '工作台': { id: 'crafting_table', n: 1, need: { oak_planks: 4 } },
  '木板': { id: 'oak_planks', n: 4, need: { oak_log: 1 } },
  '木棍': { id: 'stick', n: 4, need: { oak_planks: 2 } },
  '木镐': { id: 'wooden_pickaxe', n: 1, need: { oak_planks: 3, stick: 2 } },
  '木斧': { id: 'wooden_axe', n: 1, need: { oak_planks: 3, stick: 2 } },
  '木剑': { id: 'wooden_sword', n: 1, need: { oak_planks: 2, stick: 1 } },
  '木锹': { id: 'wooden_shovel', n: 1, need: { oak_planks: 1, stick: 2 } },
  '石镐': { id: 'stone_pickaxe', n: 1, need: { cobblestone: 3, stick: 2 } },
  '石斧': { id: 'stone_axe', n: 1, need: { cobblestone: 3, stick: 2 } },
  '石剑': { id: 'stone_sword', n: 1, need: { cobblestone: 2, stick: 1 } },
  '石锹': { id: 'stone_shovel', n: 1, need: { cobblestone: 1, stick: 2 } },
  '铁镐': { id: 'iron_pickaxe', n: 1, need: { iron_ingot: 3, stick: 2 } },
  '铁斧': { id: 'iron_axe', n: 1, need: { iron_ingot: 3, stick: 2 } },
  '铁剑': { id: 'iron_sword', n: 1, need: { iron_ingot: 2, stick: 1 } },
  '铁锹': { id: 'iron_shovel', n: 1, need: { iron_ingot: 1, stick: 2 } },
  '钻石镐': { id: 'diamond_pickaxe', n: 1, need: { diamond: 3, stick: 2 } },
  '钻石斧': { id: 'diamond_axe', n: 1, need: { diamond: 3, stick: 2 } },
  '钻石剑': { id: 'diamond_sword', n: 1, need: { diamond: 2, stick: 1 } },
  '熔炉': { id: 'furnace', n: 1, need: { cobblestone: 8 } },
  '火把': { id: 'torch', n: 4, need: { coal: 1, stick: 1 } },
  '箱子': { id: 'chest', n: 1, need: { oak_planks: 8 } },
  '梯子': { id: 'ladder', n: 3, need: { stick: 7 } },
  '栅栏': { id: 'oak_fence', n: 3, need: { oak_planks: 4, stick: 2 } },
  '木门': { id: 'oak_door', n: 3, need: { oak_planks: 6 } },
  '碗': { id: 'bowl', n: 4, need: { oak_planks: 3 } },
  '船': { id: 'oak_boat', n: 1, need: { oak_planks: 5 } },
};
const CRAFT_NAMES = Object.keys(CRAFT).join('|');

// ───────── 语音同音错别字 → 纠正（strip 里做全局替换）─────────
const TYPO = {
  '幕府': '木斧', '木府': '木斧', '木符': '木斧',
  '砍数': '砍树', '韩束': '砍树', '砍受': '砍树', '砍书': '砍树',
  '儿童': '合成', '和成': '合成',
  '项目': '橡木', '像木': '橡木', '象木': '橡木',
};

// ───────── 物品口语别名（去量词/去「头子儿」后缀后仍对不上的，用这个兜）─────────
const ALIAS = {
  '斧': '木斧', '斧头': '木斧', '斧子': '木斧',
  '镐': '木镐', '镐头': '木镐', '镐子': '木镐',
  '剑': '木剑', '锹': '木锹', '锄': '木锄',
};

// 把口语化的物品说法归一化到 CRAFT 表里的中文名（一把木斧头→木斧、幕府→木斧）
function normalizeItem(w) {
  let t = String(w || '').trim();
  t = t.replace(/^(?:一把|一个|一|几把|几个|一些|些|把|个|只|条|块|根|组)\s*/, '');
  t = t.replace(/(?:头|子|儿)$/, '');
  if (TYPO[t]) t = TYPO[t];
  if (ALIAS[t]) t = ALIAS[t];
  return t;
}

async function craft(ctx, name, count = 1) {
  const rec = CRAFT[name];
  if (!rec) return '这个我还不会合成，你可以说「合成」+ 想合的东西，比如「合成工作台」「合成木棍」。';
  const items = await inventory(ctx, CLIENT);
  const have = {};
  for (const it of items) have[it.id] = (have[it.id] || 0) + it.count;
  const miss = [];
  for (const [mat, need] of Object.entries(rec.need)) {
    const lack = need * count - (have[mat] || 0);
    if (lack > 0) miss.push(cn(mat) + ' 缺 ' + lack + ' 个');
  }
  if (miss.length) return '合成' + name + '×' + count + ' 还' + miss.join('、') + '，先去采集（比如「砍树」「挖圆石」）吧。';
  for (const [mat, need] of Object.entries(rec.need)) {
    await srv(ctx, 'clear ' + CLIENT + ' ' + mat + ' ' + (need * count));
  }
  await srv(ctx, 'give ' + CLIENT + ' ' + rec.id + ' ' + (rec.n * count));
  return '合成好了：' + name + '×' + (rec.n * count) + '（材料已从背包里扣掉）。';
}

// ───────── 时间 / 天气 ─────────
function clockText(ticks) {
  const t = ((Number(ticks) % 24000) + 24000) % 24000;
  const h = (Math.floor(t / 1000) + 6) % 24, m = Math.floor((t % 1000) * 0.06);
  return { h, m, text: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'), phase: (t >= 13000 || t < 2000) ? '夜里' : (t < 11000 ? '白天' : '傍晚') };
}
function stateLoad() { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return {}; } }
function stateSave(s) { try { fs.mkdirSync(path.dirname(STATEFILE), { recursive: true }); fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 1), 'utf8'); } catch { } }
function noteWeather(cmd) {                     // 大脑自己改过天气就记一笔（服务器不给查天气，只能靠自己记）
  const m = String(cmd).match(/^weather\s+(clear|rain|thunder)/i);
  if (!m) return;
  const s = stateLoad(); s.weather = { v: m[1].toLowerCase(), ts: Date.now() }; stateSave(s);
}
async function weatherText(ctx) {
  const bolt = await srv(ctx, 'execute if entity @e[type=minecraft:lightning_bolt]');
  if (/Test passed/i.test(bolt)) return '外面在打雷';
  const s = stateLoad();
  if (s.weather && Date.now() - s.weather.ts < 30 * 60 * 1000) {
    return { clear: '现在是晴天', rain: '现在在下雨', thunder: '现在是雷雨天' }[s.weather.v] || '';
  }
  return '';
}

// ───────── 方块中文名 → id（挖矿/找方块用）─────────
const BLOCK = {
  钻石: 'diamond_ore', 钻石矿: 'diamond_ore', 深层钻石: 'deepslate_diamond_ore', 铁: 'iron_ore', 铁矿: 'iron_ore', 深层铁: 'deepslate_iron_ore', 煤矿: 'coal_ore', 煤: 'coal_ore', 深层煤: 'deepslate_coal_ore',
  金: 'gold_ore', 金矿: 'gold_ore', 深层金: 'deepslate_gold_ore', 铜: 'copper_ore', 铜矿: 'copper_ore', 深层铜: 'deepslate_copper_ore', 红石: 'redstone_ore', 深层红石: 'deepslate_redstone_ore', 青金石: 'lapis_ore', 深层青金石: 'deepslate_lapis_ore',
  绿宝石: 'emerald_ore', 深层绿宝石: 'deepslate_emerald_ore', 石英: 'nether_quartz_ore', 下界石英: 'nether_quartz_ore', 远古残骸: 'ancient_debris',
  石头: 'stone', 圆石: 'cobblestone', 深板岩: 'deepslate', 泥土: 'dirt', 沙子: 'sand', 砂砾: 'gravel', 黑曜石: 'obsidian', 草: 'grass_block', 花岗岩: 'granite', 闪长岩: 'diorite', 安山岩: 'andesite', 玄武岩: 'basalt', 凝灰岩: 'tuff', 下界岩: 'netherrack', 灵魂沙: 'soul_sand', 萤石: 'glowstone', 黏土: 'clay',
  木头: 'oak_log', 树干: 'oak_log', 树: 'oak_log', 原木: 'oak_log', 橡木: 'oak_log', 橡树: 'oak_log',
  云杉: 'spruce_log', 云杉木: 'spruce_log', 白桦: 'birch_log', 白桦木: 'birch_log', 丛林: 'jungle_log', 丛林木: 'jungle_log', 金合欢: 'acacia_log', 金合欢木: 'acacia_log', 深色橡木: 'dark_oak_log', 深色橡树: 'dark_oak_log', 樱花: 'cherry_log', 樱花木: 'cherry_log', 红树: 'mangrove_log', 红树木: 'mangrove_log',
};
const blockOf = (w) => BLOCK[w] || (/^[a-z_]{3,}$/.test(w) ? w : '');
const BLOCK_WORDS = '深层钻石矿|深层青金石矿|深层绿宝石矿|深层铁矿|深层煤矿|深层金矿|深层铜矿|深层红石矿|下界石英矿|远古残骸|钻石矿|青金石|绿宝石|深板岩|黑曜石|花岗岩|闪长岩|安山岩|玄武岩|凝灰岩|下界岩|灵魂沙|萤石|铁矿|煤矿|金矿|铜矿|红石|石英|石头|圆石|泥土|沙子|砂砾|黏土|云杉木|白桦木|丛林木|金合欢木|深色橡木|深色橡树|樱花木|红树木|橡木|橡树|云杉|白桦|丛林|金合欢|樱花|红树|木头|原木|树干|钻石|铁|煤|金|铜|草';

// ───────── 给指令去壳：去掉唤醒词和标点，才好看首字 ─────────
function strip(text, wakeWords) {
  let t = String(text || '').trim();
  for (const w of (wakeWords || [])) t = t.split(w).join(' ');
  for (const [bad, good] of Object.entries(TYPO)) t = t.split(bad).join(good);   // 语音同音错别字纠正（幕府→木斧、砍数→砍树、儿童→合成）
  t = t.replace(/[，,。！!？?、~～\s]+/g, ' ').trim();
  let prev;                                        // 「去/快/帮我…」这类口气词去掉（注意别动「给我」，那是给东西的句式）
  do { prev = t; t = t.replace(/^(?:帮我(?!拿)|请|麻烦|你|快|去|立刻|马上|赶紧)\s*/, ''); } while (t !== prev && t);
  t = t.replace(/^来(?=砍|挖|跟|打|捡|收|回|找|逛|停|种|探|过)/, '');   // 「来+动作」当口气词删（来砍树→砍树），「来我这里/来一下」不删
  return t;
}

// ───────── 指令表：每条 = { name, re, run(ctx, m) → 回话 } ─────────
const RULES = [
  {
    name: '开始战斗', re: /^(开始战斗|开启战斗|打开战斗|战斗开启|去战斗|打架|去打架|打怪|帮我打|帮我打架|开战斗|开打)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await mewfight(ctx, 'on');
      if (!r.ok) return '我这边开不了战斗，好像出问题了。';
      return '战斗模式已开启，附近的怪物我来打。';
    },
  },
  {
    name: '停止战斗', re: /^(停止战斗|关闭战斗|关掉战斗|关战斗|别打了|不打了|停火|停止攻击|停战)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await mewfight(ctx, 'off');
      if (!r.ok) return '我这边关不了战斗，好像出问题了。';
      return '好，不打了，收剑。';
    },
  },
  {
    name: '跟着我', re: /^(跟着我|跟紧我|跟着我走|跟着走|跟好我|跟着)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      let r = await baritone(ctx, '#follow player ' + PLAYER);
      if (r.bad || !r.said.some(l => /Following these entities/i.test(l))) {
        await sleep(700);
        r = await baritone(ctx, '#follow player ' + PLAYER);      // 同一个问题最多试 2 次
      }
      return r.said.some(l => /Following these entities/i.test(l)) ? pick(['好，我跟着你了。', '嗯，跟上了。']) : '我看不到你，走近点再喊我。';
    },
  },
  {
    name: '停下', re: /^(停下|停下来|停下吧|别走了|站住|停)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#cancel'); return pick(['好，停下了。', '停了。']); },
  },
  {
    name: '过来', re: /^(过来|来我这里|来我这|到我这儿|来一下|过来吧)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      let r = await baritone(ctx, '#follow player ' + PLAYER);
      if (r.bad || !r.said.some(l => /Following these entities/i.test(l))) {
        await sleep(700);
        r = await baritone(ctx, '#follow player ' + PLAYER);   // #come 依赖 /msg 记录，语音说话没有 msg，改用 #follow player 明确指定玩家
      }
      return r.said.some(l => /Following these entities/i.test(l)) ? '来了来了。' : '我看不到你，走近点再喊我。';
    },
  },
  {
    name: '回家', re: /^(回家|回窝|回家吧|回家里)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await baritone(ctx, '#home');
      if (r.said.some(l => /No waypoints found|Unable|cancel/i.test(l))) return '我还不知道家在哪儿，先跟我说一句「记住这是家」。';
      return '往回走了，家我还记得。';
    },
  },
  {
    name: '记住这是家', re: /^(记住)?(这里|这儿|这)?(是|当作?|设成)?家(了|吧|哦)?$/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#sethome'); return '记住了，这儿就是家。'; },
  },
  {
    name: '挖矿', re: new RegExp('^挖(?:点|一点|些|几个|块|一下)?(' + BLOCK_WORDS + ')'), 
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const b = blockOf(m[1]); if (!b) return '这个我不会挖。';
      const r = await baritone(ctx, '#mine ' + b);
      return r.bad ? '这附近好像没有' + m[1] + '。' : '去挖' + m[1] + '了。';
    },
  },
  {
    name: '挖矿(没说挖啥)', re: /^(挖矿|去挖矿|挖点矿)/,
    run: async () => '挖什么？钻石、铁、煤、金、红石都行。',
  },
  {
    name: '砍树', re: /^砍(?:点|一些|几棵|几颗|一下)?(树|木头|原木|橡木|橡树|云杉|云杉木|白桦|白桦木|丛林|丛林木|金合欢|金合欢木|深色橡木|深色橡树|樱花|樱花木|红树|红树木)?/,
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const kind = m[1] ? (BLOCK[m[1]] || 'oak_log') : 'oak_log';
      const r = await baritone(ctx, '#mine ' + kind);
      return r.bad ? '附近没找到这种树。' : '去砍' + (m[1] || '树') + '了。';
    },
  },
  {
    name: '随便逛', re: /^(随便逛|到处逛逛|去逛逛|逛逛|到处走走|去探索|探索一下)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#explore'); return '那我随便逛逛去。'; },
  },
  {
    name: '收菜', re: /^(收菜|收庄稼|收农作物|去种地|收一下菜|农场)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await baritone(ctx, '#farm');
      if (r.said.some(l => /Farm failed|no crops|Unable/i.test(l))) return '附近没菜可收，我找找看有没有别的田。';
      return '去收菜了。';
    },
  },
  {
    name: '捡东西', re: /^(捡东西|捡一下|捡捡东西|把东西捡了|东西捡了|捡起来)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#pickup'); return '我去把东西捡回来。'; },
  },
  {
    name: '还有多久到', re: /^(还有多久到|多久能到|还有多远|快到了吗|到哪了|还要多久)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await baritone(ctx, '#eta', { wait: 2500 });
      if (r.said.some(l => /No process in control/i.test(l))) return '我现在没在走路，没得算。';
      const hit = r.said.filter(l => /\d/.test(l)).pop();
      if (!hit) return '我算不出来，可能还没定目标。';
      const sec = hit.match(/([\d.]+)\s*s\b/);
      return sec ? '大概还要 ' + Math.round(Number(sec[1])) + ' 秒到。' : '看它的说法：' + hit.replace(/Goal:\s*/i, '').slice(0, 30);
    },
  },
  {
    name: '暂停', re: /^(暂停|先停一下|歇会儿|歇一下|休息一下)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#pause'); return '好，我先停这儿。'; },
  },
  {
    name: '恢复', re: /^(恢复|继续|接着走|继续吧|接着干)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#resume'); return '好，继续。'; },
  },
  {
    name: '取消', re: /^(取消|算了|别挖了|终止|别干了|不干了)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#cancel'); return '行，那就不干了。'; },
  },
  {
    name: '报坐标', re: /^(报坐标|你的坐标|你在哪|你在哪儿|你的位置|报位置|你现在在哪|你在什么地方)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const p = await posOf(ctx, CLIENT);
      return p ? '我在 ' + p.x + ' ' + p.y + ' ' + p.z + '，过来找我吧。' : '我现在读不到自己的位置。';
    },
  },
  {
    name: '离我远点', re: /^(离我远点|别贴着我|你走开点|站远点|退后|离远点)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const me = await posOf(ctx, CLIENT), you = await posOf(ctx, PLAYER);
      if (!me || !you) return '你不在附近，我找不到你。';
      let dx = me.x - you.x, dz = me.z - you.z;
      const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      const t = { x: Math.round(you.x + dx * 9), y: me.y, z: Math.round(you.z + dz * 9) };
      await baritone(ctx, '#goto ' + t.x + ' ' + t.y + ' ' + t.z);
      return '好，我走开点。';
    },
  },
  {
    name: '给我指定东西', re: /^(?:帮我拿|我想要|给我点|给我来|来一把|我要|给我)\s*(?!看|查|报|说|讲)(.+)$/,
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const w = normalizeItem(m[1]);
      if (CRAFT[w]) return craft(ctx, w);
      const cnId = Object.keys(CN).find(id => CN[id] === w);
      if (cnId) return '「' + m[1].trim() + '」这个我不能凭空变，得先采集材料合成；说「敲指令 give ' + CLIENT + ' ' + cnId + '」可以跳过采集直接给我。';
      return null;   // 没听出是什么物品，交给 AI 兜底
    },
  },
  {
    name: '给我东西', re: /^(给我东西|把东西给我|把你背包的东西给我|把背包的东西给我|东西给我|把东西都给我)/,
    run: async (ctx) => {
      if (!await online(ctx)) return OFFLINE;
      const items = await inventory(ctx, CLIENT);
      if (!items.length) return '我身上是空的，没东西给你。';
      const moved = [];
      for (const it of items) {
        const r = String(await srv(ctx, 'give ' + PLAYER + ' ' + it.id + ' ' + it.count));
        if (/No player was found/i.test(r)) return '你不在游戏里，等你进来我再给你。';
        moved.push(cn(it.id) + (it.count > 1 ? '×' + it.count : ''));
      }
      await srv(ctx, 'clear ' + CLIENT);
      return '都给你了：' + moved.slice(0, 4).join('、') + '。';
    },
  },
  {
    name: '合成', re: new RegExp('^合成(?:([一二两三四五六七八九十]+|[0-9]+)个?)?(' + CRAFT_NAMES + ')(?:吧|哦|了)?$'),
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const n = m[1] ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1]] || parseInt(m[1], 10) || 1) : 1;
      return craft(ctx, m[2], Math.min(64, Math.max(1, n)));
    },
  },
  {
    name: '去坐标', re: /^(?:去|走到|到)?(?:坐标|位置)?\s*(-?\d+)\s*[，,、\s]\s*(-?\d+)/,
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const r = await baritone(ctx, '#goto ' + m[1] + ' ' + m[2]);
      return r.bad ? '我走不过去。' : '去坐标 ' + m[1] + ',' + m[2] + ' 了。';
    },
  },
  {
    name: '到地表', re: /^(到地表|回地面|上到地面|回到地面|到地面|上去)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#surface'); return '我往地面走。'; },
  },
  {
    name: '挖隧道', re: /^(?:挖|打|开)(?:一个|一条|个|条)?隧道/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await baritone(ctx, '#tunnel'); return '开始往前挖隧道（1×2 的大小）。'; },
  },
  {
    name: '切创造', re: /^(切创造|改成创造|开创造|创造模式|切换创造|变创造)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await srv(ctx, 'gamemode creative ' + CLIENT); return '好，我切到创造模式了（能飞、秒破方块、不掉东西）。'; },
  },
  {
    name: '切生存', re: /^(切生存|改成生存|开生存|生存模式|切换生存|变生存)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; await srv(ctx, 'gamemode survival ' + CLIENT); return '好，我切回生存模式了（挖方块会掉东西了）。'; },
  },
  {
    name: '丢弃', re: /^(?:丢掉|扔掉|丢弃|扔了|扔)(.+)/,
    run: async (ctx, m) => {
      if (!await online(ctx)) return OFFLINE;
      const w = String(m[1] || '').trim();
      let id = blockOf(w) || Object.keys(CN).find(k => CN[k] === w) || (/^[a-z_]{3,}$/.test(w) ? w : '');
      if (!id) return '丢什么？说清楚点，比如「丢掉圆石」。';
      const r = await srv(ctx, 'clear ' + CLIENT + ' ' + id);
      return /No items were found/i.test(r) ? '我身上没有' + w + '。' : '把' + w + '都扔了。';
    },
  },
  {
    name: '看你背包', re: /^(看你背包|看看你的背包|你背包里有什么|你身上有什么|你带了什么|看看你的包|你包里有什么)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; const s = await invLine(ctx, CLIENT); return s ? '我身上有：' + s + '。' : '我身上什么都没有。'; },
  },
  {
    name: '看我背包', re: /^(看我背包|看看我的背包|我背包里有什么|我身上有什么|我有什么东西|看看我的包)/,
    run: async (ctx) => { if (!await online(ctx)) return OFFLINE; const s = await invLine(ctx, PLAYER); return s ? '你身上有：' + s + '。' : '你身上也是空的。'; },
  },
  {
    name: '时间天气', re: /^(现在几点|几点了|现在什么时间|什么时间了|现在什么天气|天气怎么样|什么天气|今天天气|时间[和跟]天气)/,
    run: async (ctx) => {
      const raw = await srv(ctx, 'time query time');
      const mm = raw.match(/at\s+(\d+)/);
      const c = clockText(mm ? mm[1] : 0);
      const w = await weatherText(ctx);
      return '现在游戏里是 ' + c.text + '，' + c.phase + (w ? '，' + w : '') + '。';
    },
  },
  {
    name: '设token', re: /^(?:设置|设|调|改|限制)(?:token|字数|长度|回复长度)[^0-9]{0,4}(\d{2,4})/,
    run: async (ctx, m) => {
      const n = Math.max(50, Math.min(2000, parseInt(m[1], 10)));
      applyTokenStyle(ctx, n, Math.max(10, Math.round(n / 7.5)));
      return '好，以后每条回复最多 ' + n + ' token。';
    },
  },
  {
    name: '回复详细', re: /详细点|长一点|多讲点|说详细点|说多点|别太短|具体点|详细些|说长点|详细一点|长一些/,
    run: async (ctx) => {
      applyTokenStyle(ctx, 800, 120);
      return '好，以后我回复详细点、多讲几句。';
    },
  },
  {
    name: '回复简短', re: /短一点|简短点|简洁点|少说点|别啰嗦|精炼点|短些|说短点|简短一点|简略点/,
    run: async (ctx) => {
      applyTokenStyle(ctx, 200, 30);
      return '好，以后我说话短一点。';
    },
  },
];

// ───────── 对外：把一句话交给本地指令表 ─────────
async function localCommand(text, ctx) {
  const t = strip(text, ctx.wakeWords || ctx.CFG && ctx.CFG.wakeWords);
  if (!t) return null;
  for (const r of RULES) {
    const m = t.match(r.re);
    if (!m) continue;
    try {
      const reply = await r.run(ctx, m);
      if (reply) { ctx.log('本地指令「' + r.name + '」← ' + t.slice(0, 20)); return { name: r.name, reply: String(reply) }; }
    } catch (e) { ctx.log('本地指令「' + r.name + '」出错: ' + (e && e.message)); }
    return null;                                   // 命中但执行不了：交给 AI 兜底
  }
  return null;
}
function listRules() { return RULES.map(r => r.name); }

module.exports = { localCommand, listRules, noteWeather, hdSend, RULES, PLAYER, CLIENT };
