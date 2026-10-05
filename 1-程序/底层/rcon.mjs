// 极简 RCON 客户端：node rcon.mjs <command...>
// 默认 127.0.0.1:25575，密码从 config.json paths.serverDir 下的 server.properties 的 rcon.password 读
import net from 'node:net';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { need } = createRequire(import.meta.url)('../cfg.cjs');

const props = fs.readFileSync(need('paths', 'serverDir') + '\\server.properties', 'utf8');
const pass = (props.match(/^rcon\.password=(.*)$/m) || [, ''])[1].trim();
const host = process.env.RCON_HOST || '127.0.0.1';
const port = Number((props.match(/^rcon\.port=(\d+)/m) || [, '25575'])[1]);
const command = process.argv.slice(2).join(' ') || 'list';

function packet(id, type, body) {
  const bodyBuf = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.from([0, 0])]);
  const len = 4 + 4 + bodyBuf.length;
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

const socket = net.connect(port, host);
let buf = Buffer.alloc(0);
const timeout = setTimeout(() => { console.error('RCON timeout'); process.exit(1); }, 10000);

socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) return;
    const id = buf.readInt32LE(4);
    const type = buf.readInt32LE(8);
    const body = buf.subarray(12, 4 + len - 2).toString('utf8');
    buf = buf.subarray(4 + len);
    if (type === 2) {
      if (id === -1) { clearTimeout(timeout); console.error('AUTH FAILED'); process.exit(2); }
      socket.write(packet(2, 2, command));
    } else if (type === 0) {
      clearTimeout(timeout);
      console.log(body);
      socket.end();
    }
  }
});
socket.on('error', (e) => { clearTimeout(timeout); console.error('ERR ' + e.message); process.exit(1); });
socket.on('connect', () => socket.write(packet(1, 3, pass)));
