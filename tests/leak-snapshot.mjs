// 受入試験の前段: Playwright MCP の画面情報にパスワード欄の値が出るかを合成パスワードで確かめる。
// 使い方: node tests/leak-snapshot.mjs <@playwright/mcp の cli.js のパス>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = process.argv[2];
const FAKE = 'Zq7-fake-PASS-9xK';
const dir = mkdtempSync(join(tmpdir(), 'agent-login-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const page = join(dir, 'login.html');
writeFileSync(page, `<!doctype html><title>login</title>
<form onsubmit="event.preventDefault();document.getElementById('err').textContent='ログインに失敗しました'">
<label>ID <input id="u" name="u"></label>
<label>パスワード <input id="p" name="p" type="password"></label>
<button>ログイン</button><p id="err"></p></form>`);

const outDir = join(dir, 'out');
const mcp = spawn('node', [cli, '--output-dir', outDir, '--headless', '--isolated', '--allow-unrestricted-file-access'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
  }
});
let id = 0;
const call = (method, params) => new Promise((res) => {
  const n = ++id; waiters.set(n, res);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
});
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  return JSON.stringify(r);
};

await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'leak-test', version: '0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const results = {};
results.navigate = await tool('browser_navigate', { url: 'file://' + page });
const snap0 = await tool('browser_snapshot', {});
const ref = (label) => {
  const m = snap0.match(new RegExp(`textbox \\\\"${label}\\\\"[^\\]]*\\[ref=(e\\d+)\\]`));
  return m?.[1];
};
const pRef = ref('パスワード');
results.type = await tool('browser_type', { element: 'パスワード', target: pRef, text: FAKE });
results.snapshotAfterType = await tool('browser_snapshot', {});
results.click = await tool('browser_click', { element: 'ログイン', target: snap0.match(/button \\"ログイン\\" \[ref=(e\d+)\]/)?.[1] });
results.snapshotAfterFail = await tool('browser_snapshot', {});
results.evaluate = await tool('browser_evaluate', { function: "() => document.querySelector('#p').value" });
results.fillForm = await tool('browser_fill_form', { fields: [{ element: 'パスワード', target: pRef, name: 'パスワード', type: 'textbox', value: FAKE }] });
results.console = await tool('browser_console_messages', {});

// 試験自体が成り立っているか: 道具の失敗・入力されていない状態での「漏れなし」は無効にする。
let leaked = false, broken = !pRef;
for (const [k, v] of Object.entries(results)) {
  const hit = v.includes(FAKE);
  const err = JSON.parse(v).result?.isError === true;
  leaked ||= hit; broken ||= err;
  console.log(`${hit ? 'LEAK' : err ? 'ERR ' : 'ok  '} ${k}`);
}
// 画面情報はファイルにも保存されるので、保存物も調べる。
for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
  const hit = readFileSync(join(outDir, f), 'utf8').includes(FAKE);
  leaked ||= hit;
  console.log(`${hit ? 'LEAK' : 'ok  '} file:${f}`);
}
console.log(`passwordRef=${pRef}`);
console.log(broken ? 'RESULT: 試験不成立' : leaked ? 'RESULT: 平文が出た' : 'RESULT: 平文は出なかった');
if (process.env.SHOW) for (const k of Object.keys(results)) console.log(k, results[k].slice(0, 600));
process.exitCode = broken ? 2 : leaked ? 1 : 0;
mcp.kill();
