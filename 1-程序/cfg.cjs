// cfg.cjs —— 全项目统一配置加载器（唯一的配置文件是仓库根目录的 config.json）
// 用法（.cjs）：const CFG = require('../cfg.cjs').load();
// 用法（.mjs）：import { createRequire } from 'module'; const CFG = createRequire(import.meta.url)('../cfg.cjs').load();
// 校验用 need()：必填项没填就抛人话错误，别让程序带着空路径乱跑。
const fs = require('fs');
const path = require('path');

const CFGFILE = path.join(__dirname, '..', 'config.json');  // __dirname=1-程序，上一级就是仓库根
let _cfg = null;

function load() {
  if (_cfg) return _cfg;
  if (!fs.existsSync(CFGFILE)) {
    throw new Error('找不到 config.json（应与本仓库根目录同级）。请先照 AGENTS.md 把它填好。');
  }
  _cfg = JSON.parse(fs.readFileSync(CFGFILE, 'utf8'));
  return _cfg;
}

// 取必填项：没填就立刻报"缺哪个键"，附一句怎么办
function need(group, key) {
  const c = load();
  const v = c[group] && c[group][key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`config.json 里 ${group}.${key} 还没填（${(c[group] && c[group]['_' + key]) || '见 AGENTS.md 配置一节'}）。填好存盘再启动。`);
  }
  return v;
}

// 取功能开关：features.voice / features.chatText / features.speaking，默认 false
function feature(name) {
  const c = load();
  return !!(c.features && c.features[name]);
}

module.exports = { load, need, feature, CFGFILE };
