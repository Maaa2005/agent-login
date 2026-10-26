// 受入試験: login を通した後、AI が見られる経路（返事・画面情報・ページ上の値・通信の記録・保存ファイル）に
// 合成パスワードが1件も出ないこと、拒否や住所違いでは入力しないことを確かめる。
// ブラウザは本体の Chrome を画面なしで使う。ネットには出ない（127.0.0.1 の試験用サーバーだけ）。
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, existsSync, chmodSync, readlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentLogin, urlAllowed, keepPrivate } from '../src/server.mjs';
import { createKeychain } from '../src/keychain.mjs';
import { parseCsv, planImport, parseSelection, runImport } from '../src/import.mjs';
import { width, table, helpText, sitesView, clean } from '../src/cli-view.mjs';

// 判定は英数字だけの芯（CORE）で行う。記号はどの書き方に化けても、芯はそのまま残る。
const CORE = 'Zq7SYNTH' + Math.random().toString(36).slice(2, 10);
const PASSWORD = CORE + '-pw! &%"\'<>\\';
const USER = 'synthetic-user@example.invalid';
const root = mkdtempSync(join(tmpdir(), 'agent-login-acc-'));

// ---- 試験用のログイン画面 ----
const received = []; // 送信されたパスワード（正しく届いたかの確認用）
const page = (body) => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;
const FORM = (action = '/login') => `<form method="post" action="${action}">
  <label>ID <input name="user" type="email" autocomplete="username"></label>
  <label>パスワード <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">ログイン</button></form>`;
const pages = {
  '/login': page(FORM()),
  '/login-js': page(`<form id="f"><input id="u" type="text" aria-label="ID"><input id="p" type="password" aria-label="パスワード">
    <button>ログイン</button></form><p id="msg"></p>
    <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = JSON.stringify({ user: u.value, password: p.value });
      await new Promise((r) => setTimeout(r, 50));
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      document.getElementById('msg').textContent = res.ok ? 'ok' : 'IDかパスワードが違います';
    });
    </script>`),
  // 悪い作りのページ: 送信時にパスワードを画面・隠し欄・コンソールに書き写す（伏せ字が効くかを見る）。
  '/echo': page(`<form id="f"><input id="u" type="text" aria-label="ID"><input id="p" type="password" aria-label="パスワード">
    <input id="h" type="hidden"><button>ログイン</button></form><p id="shown"></p>
    <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = p.value;
      h.value = v; shown.textContent = 'sent: ' + v;
      console.log('debug password', v);
      setTimeout(() => console.log('late password', v), 1000);
      await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: u.value, password: v }) });
    });
    </script>`),
  '/iframe': page(`<iframe src="/login" width="400" height="200"></iframe>`),
  '/two': page(`<form><input type="password" aria-label="a"><input type="password" aria-label="b"></form>`),
  '/home': page('<h1>ようこそ</h1>'),
  '/other': page('<h1>別の画面</h1>'),
  '/opener': page('<a href="/login" target="_blank">ログイン画面を開く</a>'),
  '/login-2fa': page(FORM('/login-2fa')),
  '/login-otp': page(FORM('/login-otp')),
  '/sessions/two-factor/webauthn': page('<h1>パスキーで確認してください</h1>'),
  '/next': page('<label>確認コード <input name="code" autocomplete="one-time-code"></label>'),
};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path === '/login') {
      const f = new URLSearchParams(body);
      received.push({ path, user: f.get('user'), password: f.get('password') });
      // わざと失敗させ、ID だけ残した画面を返す（失敗後の画面に値が残らないかを見る）。
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(`<p>IDかパスワードが違います</p>${FORM()}`));
    }
    // 二段階認証へ進むログイン（パスキーの画面・確認コード欄のある画面）
    if (req.method === 'POST' && (path === '/login-2fa' || path === '/login-otp')) {
      const f = new URLSearchParams(body);
      received.push({ path, user: f.get('user'), password: f.get('password') });
      res.writeHead(303, { location: path === '/login-2fa' ? '/sessions/two-factor/webauthn' : '/next' });
      return res.end();
    }
    if (req.method === 'POST' && path === '/api/login') {
      const j = JSON.parse(body);
      received.push({ path, user: j.user, password: j.password });
      res.writeHead(j.password === PASSWORD ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: j.password === PASSWORD }));
    }
    if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages[path]);
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const OTHER_ORIGIN = `http://localhost:${server.address().port}`; // 同じ試験用サーバーを別の住所として使う

// ---- 偽の鍵係（本人の承認を差し替える） ----
function fakeCredentials({ origin = ORIGIN, decide = async () => true } = {}) {
  const calls = [];
  return {
    calls,
    async list() { return [{ site: 'test', origin }]; },
    async info(site) { return site === 'test' ? { site, origin, user: USER } : null; },
    async get(site, o, reason) {
      calls.push({ site, origin: o, reason });
      if (site !== 'test') return { status: 'not_registered' };
      if (o !== origin) return { status: 'origin_mismatch' };
      if (!(await decide())) return { status: 'denied' };
      return { status: 'ok', origin, user: USER, password: PASSWORD };
    },
  };
}

async function start(opts = {}) {
  const outputDir = mkdtempSync(join(root, 'out-'));
  const credentials = opts.credentials ?? fakeCredentials();
  const app = await createAgentLogin({ credentials, outputDir, headless: true, allowInsecureHosts: true, submitWaitMs: 3000, ...opts.app });
  const waiters = new Map();
  const transport = {
    async start() {}, async close() {},
    async send(m) { if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } },
  };
  await app.connect(transport);
  let id = 0;
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waiters.set(n, r); transport.onmessage({ jsonrpc: '2.0', id: n, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } });
  transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const toolAsync = (name, args = {}) => rpc('tools/call', { name, arguments: args }).then((m) => m.result);
  return { app, credentials, outputDir, rpc, tool, toolAsync };
}

const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return null; } };
const hasPw = (v) => JSON.stringify(v ?? '').includes(CORE);
function filesWithPw(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 50e6) {
        const t = readFileSync(p).toString('utf8');
        if (t.includes(CORE)) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

// AI が見られる経路を一通り叩き、平文の出た経路を返す。
async function probe(s, { network = true } = {}) {
  const workspaceFile = join(process.cwd(), 'snap-after-login.yml');
  try { unlinkSync(workspaceFile); } catch {}
  const leaks = [];
  const broken = [];
  let posts = 0;
  const check = async (label, name, args) => {
    const r = await s.tool(name, args);
    if (r?.isError) broken.push(`${label}: ${JSON.stringify(r).slice(0, 200)}`);
    if (hasPw(r)) leaks.push(label);
    return r;
  };
  await check('画面情報', 'browser_snapshot', {});
  await check('画面情報(保存)', 'browser_snapshot', { filename: 'snap-after-login.yml' });
  if (!existsSync(workspaceFile)) broken.push(`画面情報(保存): ${workspaceFile} が作られない`);
  await check('欄の値', 'browser_evaluate', { function: '() => [...document.querySelectorAll("input,textarea")].map((e) => e.value).join("|")' });
  await check('コンソール', 'browser_console_messages', { level: 'debug', all: true });
  if (network) {
    const list = await check('通信一覧', 'browser_network_requests', { static: true });
    const textOut = JSON.stringify(list);
    const idx = [...textOut.matchAll(/(\d+)\.\s*\[POST\]/g)].map((m) => Number(m[1]));
    posts = idx.length;
    for (const i of idx) await check(`通信の中身#${i}`, 'browser_network_request', { index: i, part: 'request-body' });
    if (process.env.SHOW) console.log(textOut.slice(0, 600));
  }
  for (const f of filesWithPw(s.outputDir)) leaks.push(`保存ファイル ${f}`);
  try { if (readFileSync(workspaceFile, 'utf8').includes(CORE)) leaks.push(`保存ファイル ${workspaceFile}`); } catch {}
  return { leaks, broken, posts };
}

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK ' : 'NG '} ${name}${detail ? ' — ' + detail : ''}`); };
const cleanup = [];

async function scenario(name, fn) {
  try { await fn(); } catch (e) { record(name, false, `例外: ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`); }
}

// 1. 道具の一覧
await scenario('一覧に login が出て、任意コードの道具は出ない', async () => {
  const s = await start(); cleanup.push(s);
  const list = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name);
  record('一覧に login が出て、任意コードの道具は出ない',
    list.includes('login') && list.includes('login_sites') && !list.includes('browser_run_code_unsafe') && list.includes('browser_snapshot'),
    `${list.length} 個`);
  const blocked = parse(await s.tool('browser_run_code_unsafe', { code: 'async (page) => 1' }));
  record('任意コードの道具は呼んでも断る', blocked?.status === 'blocked');
  const sites = parse(await s.tool('login_sites'));
  record('登録一覧はパスワードと ID を含まない', sites?.status === 'ok' && !hasPw(sites) && !JSON.stringify(sites).includes(USER));
  // 鍵係が値を渡せない起動なら、一覧でそれが分かる（ログインを試す前に気づける）
  const no = await start({ credentials: { ...fakeCredentials(), async callerCheck() { return { ok: false, why: 'NODE_OPTIONS is set' }; } } }); cleanup.push(no);
  const yes = await start({ credentials: { ...fakeCredentials(), async callerCheck() { return { ok: true, why: '' }; } } }); cleanup.push(yes);
  const n = parse(await no.tool('login_sites')), y = parse(await yes.tool('login_sites'));
  record('登録一覧でログインできる起動かが分かる', n?.login_ready === false && n.login_not_ready_reason.includes('NODE_OPTIONS') && y?.login_ready === true, JSON.stringify(n));
});

// 0. 対照: この道具を通さずに値を入れると、試験が平文を見つけられること（見る目が効いているかの確認）
await scenario('対照', async () => {
  const s = await start({ app: { mask: false } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/echo` });
  await s.tool('browser_evaluate', { function: `() => { document.querySelector('#u').value = ${JSON.stringify(USER)}; document.querySelector('#p').value = ${JSON.stringify(PASSWORD)}; document.querySelector('#f').requestSubmit(); }` });
  await new Promise((r) => setTimeout(r, 1500));
  const { leaks, broken, posts } = await probe(s);
  // 保存付きの画面情報は返事に中身が出ず、作業場所のファイルに書かれる。
  const want = ['画面情報', '欄の値', 'コンソール', '通信の中身', `保存ファイル ${join(process.cwd(), 'snap-after-login.yml')}`];
  const missed = want.filter((w) => !leaks.some((l) => l.startsWith(w)));
  record('対照: 試験は各経路の平文を見つけられる', broken.length === 0 && posts >= 1 && missed.length === 0 && leaks.some((l) => l.startsWith('保存ファイル')),
    `見つけた: ${leaks.join(', ')}${missed.length ? '／見逃し: ' + missed.join(', ') : ''}`);
});

// 2. 通常の送信で失敗するログイン（失敗後の画面に値が残らない・届いた値は正しい）
for (const maskOn of [true, false]) {
  const tag = maskOn ? '' : '（伏せ字なし＝欄を空にするだけで防げるか）';
  await scenario(`通常送信・失敗${tag}`, async () => {
    const s = await start({ app: { mask: maskOn } }); cleanup.push(s);
    await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
    const before = received.length;
    const r = await s.tool('login', { site: 'test', reason: '受入試験' });
    const out = parse(r);
    record(`通常送信: 送信できた${tag}`, out?.status === 'submitted', JSON.stringify(out));
    record(`通常送信: login の返事に値が無い${tag}`, !hasPw(r));
    const got = received.slice(before);
    record(`通常送信: サーバーに正しい ID とパスワードが届いた${tag}`, got.length === 1 && got[0].password === PASSWORD && got[0].user === USER);
    record(`通常送信: 失敗したことが返事で分かる${tag}`, out?.password_field_still_visible === true);
    const { leaks, broken, posts } = await probe(s, { network: maskOn });
    record(`通常送信: 試験の道具がすべて動いた${tag}`, broken.length === 0 && (!maskOn || posts >= 1), broken.join(' / ') + ` 送信記録 ${posts} 件`);
    record(`通常送信: AI が見られる経路に平文 0 件${tag}`, leaks.length === 0, leaks.join(', '));
  });
}

// 3. JS で非同期に送るページ（欄を空にする時機が早すぎないか）
await scenario('JS送信', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-js` });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  const got = received.slice(before);
  record('JS送信: サーバーに正しいパスワードが届いた', got.length === 1 && got[0].password === PASSWORD && got[0].user === USER, JSON.stringify(out));
  const { leaks, broken, posts } = await probe(s);
  record('JS送信: 試験の道具がすべて動いた', broken.length === 0 && posts >= 1, broken.join(' / ') + ` 送信記録 ${posts} 件`);
  record('JS送信: AI が見られる経路に平文 0 件', leaks.length === 0, leaks.join(', '));
});

// 3b. 写し取るページ・本番と同じ保存先あり（伏せ字・保存ファイルの掃除・時間差の書き込み・ブラウザの保存先）
await scenario('写し取るページ', async () => {
  const profileDir = mkdtempSync(join(root, 'profile-'));
  const s = await start({ app: { profileDir } });
  await s.tool('browser_navigate', { url: `${ORIGIN}/echo` });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  const got = received.slice(before);
  record('写し: サーバーに正しいパスワードが届いた', got.length === 1 && got[0].password === PASSWORD, JSON.stringify(out));
  // 道具を呼ばずに待つ間も、保存先に平文が残らないか（AI はファイルを直接読める）。
  await new Promise((r) => setTimeout(r, 1500));
  const idle = filesWithPw(s.outputDir);
  record('写し: 待っている間の保存ファイルに平文 0 件', idle.length === 0, idle.join(', '));
  // 写しが実際に記録へ出て、伏せ字になっていること（何も書かれていないだけの合格を防ぐ）。
  const maskedLogs = readdirSync(s.outputDir).filter((f) => f.startsWith('console-') && readFileSync(join(s.outputDir, f), 'utf8').includes('debug password ********'));
  record('写し: コンソールの記録は伏せ字で書かれた', maskedLogs.length >= 1, readdirSync(s.outputDir).join(', '));
  const { leaks, broken, posts } = await probe(s);
  record('写し: 試験の道具がすべて動いた', broken.length === 0 && posts >= 1, broken.join(' / ') + ` 送信記録 ${posts} 件`);
  record('写し: AI が見られる経路に平文 0 件', leaks.length === 0, leaks.join(', '));
  await new Promise((r) => setTimeout(r, 1500));
  const late = filesWithPw(s.outputDir);
  record('写し: 遅れて出た記録も保存ファイルに平文 0 件', late.length === 0, late.join(', '));
  await s.app.close();
  const prof = filesWithPw(profileDir);
  record('写し: ブラウザの保存先に平文 0 件', prof.length === 0, prof.slice(0, 5).join(', '));
});

// 4. ログインと画面情報を同時に呼ぶ（承認待ちの間に割り込ませない）
await scenario('同時呼び出し', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const credentials = fakeCredentials({ decide: async () => { await gate; return true; } });
  const s = await start({ credentials }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-js` });
  const order = [];
  const login = s.toolAsync('login', { site: 'test', reason: '受入試験' }).then((r) => { order.push('login'); return r; });
  const snaps = [0, 1, 2].map(() => s.toolAsync('browser_snapshot', {}).then((r) => { order.push('snap'); return r; }));
  const evals = s.toolAsync('browser_evaluate', { function: '() => document.querySelector("#p").value' }).then((r) => { order.push('eval'); return r; });
  await new Promise((r) => setTimeout(r, 300));
  release();
  const all = await Promise.all([login, ...snaps, evals]);
  record('同時呼び出し: 承認待ちの間、他の道具は待たされた', order[0] === 'login', order.join(','));
  record('同時呼び出し: どの返事にも平文 0 件', all.every((r) => !hasPw(r)));
});

// 5. 本人が拒否
await scenario('拒否', async () => {
  const s = await start({ credentials: fakeCredentials({ decide: async () => false }) }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  const val = await s.tool('browser_evaluate', { function: '() => document.querySelector("input[type=password]").value' });
  record('拒否: 何も入力・送信しない', out?.status === 'denied' && received.length === before && !hasPw(val), JSON.stringify(out));
});

// 6. 登録と違う住所（承認の画面を出す前に止める）
await scenario('住所違い', async () => {
  const credentials = fakeCredentials({ origin: ORIGIN.replace('127.0.0.1', 'localhost') });
  const s = await start({ credentials }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('住所違い: 承認を求めず断る', out?.status === 'origin_mismatch' && credentials.calls.length === 0, JSON.stringify(out));
});

// 7. 埋め込み枠の中のログイン欄は断る
await scenario('埋め込み枠', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/iframe` });
  await new Promise((r) => setTimeout(r, 300));
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('埋め込み枠: 承認を求めず断る', out?.status === 'iframe_not_supported' && s.credentials.calls.length === 0, JSON.stringify(out));
});

// 8. パスワード欄が2つ
await scenario('欄が2つ', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/two` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('欄が2つ: 承認を求めず断る', out?.status === 'ambiguous_password_field' && s.credentials.calls.length === 0, JSON.stringify(out));
});

// 9. 承認待ちの間に画面が変わった
await scenario('承認中の移動', async () => {
  let s;
  const credentials = fakeCredentials({
    decide: async () => {
      const ctx = await s.app.browser.peekContext();
      await ctx.pages()[0].goto(`${ORIGIN}/other`);
      return true;
    },
  });
  s = await start({ credentials }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('承認中の移動: 入力せず断る', out?.status === 'page_changed' && received.length === before, JSON.stringify(out));
});

// 10. 設定でパスワード以外の欄を指定されても入れない
await scenario('欄の指定が不正', async () => {
  const s = await start({ app: { sites: { test: { password: 'input[name=user]' } } } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('欄の指定が不正: 承認を求めず断る', out?.status === 'not_a_password_field' && s.credentials.calls.length === 0, JSON.stringify(out));
});

// 11. タブが2つ
await scenario('タブが2つ', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  await s.tool('browser_tabs', { action: 'new', url: `${ORIGIN}/other` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('タブが2つ: 承認を求めず断る', out?.status === 'too_many_tabs' && s.credentials.calls.length === 0, JSON.stringify(out));
});

// 12. http は試験用の許可が無ければ断る
await scenario('http', async () => {
  const s = await start({ app: { allowInsecureHosts: false } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('http: 承認を求めず断る', out?.status === 'insecure_origin' && s.credentials.calls.length === 0, JSON.stringify(out));
});

// 13. AI がコードを動かした住所ではログインしない（入力欄を見張るコードを仕込まれても値が渡らない）
const SPY = `() => { window.__spy = []; document.addEventListener('input', (e) => window.__spy.push(e.target.value), true);
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', { set(v) { window.__spy.push(v); d.set.call(this, v); }, get() { return d.get.call(this); } });
  return 'armed'; }`;
await scenario('コードの後', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  await s.tool('browser_evaluate', { function: SPY });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  const spied = parse(await s.tool('browser_evaluate', { function: '() => JSON.stringify(window.__spy ?? [])' })) ?? (await s.tool('browser_evaluate', { function: '() => JSON.stringify(window.__spy ?? [])' }));
  record('コードの後: 承認を求めず断る', out?.status === 'code_was_run' && s.credentials.calls.length === 0 && received.length === before, JSON.stringify(out));
  record('コードの後: 仕込んだ見張りに値が渡らない', !hasPw(spied));
  // 同じ住所なら別の画面に移っても断る（Service Worker 等で次の画面に仕込める）。
  await s.tool('browser_navigate', { url: `${ORIGIN}/home` });
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const again = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('コードの後: 同じ住所の別の画面でも断る', again?.status === 'code_was_run' && s.credentials.calls.length === 0, JSON.stringify(again));
  await s.tool('browser_navigate', { url: `${ORIGIN}/home` });
  await s.tool('browser_navigate_back');
  const back = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('コードの後: 戻るで戻った画面でも断る', back?.status === 'code_was_run' && s.credentials.calls.length === 0, JSON.stringify(back));
});

// 14. 対照: 別の住所でコードを動かしても、ログイン先の住所では通る（断りすぎていないか）
await scenario('別の住所のコード', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${OTHER_ORIGIN}/home` });
  await s.tool('browser_evaluate', { function: '() => document.title' });
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-js` });
  const before = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  await new Promise((r) => setTimeout(r, 300));
  const got = received.slice(before);
  record('対照: 別の住所でコードを動かしてもログインできる', out?.status === 'submitted' && got.length === 1 && got[0].password === PASSWORD, JSON.stringify(out));
});

// 15. 別の画面から開かれた画面ではログインしない（開いた側が中身を書き換えられる）
await scenario('開かれた画面', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/opener` });
  const snap = JSON.stringify(await s.tool('browser_snapshot'));
  const ref = snap.match(/ログイン画面を開く\\?"? \[ref=(e\d+)\]/)?.[1];
  await s.tool('browser_click', { element: 'ログイン画面を開く', target: ref });
  await new Promise((r) => setTimeout(r, 500));
  await s.tool('browser_tabs', { action: 'close', index: 0 });
  const tabs = JSON.stringify(await s.tool('browser_tabs', { action: 'list' }));
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('開かれた画面: 承認を求めず断る', out?.status === 'popup_tab' && s.credentials.calls.length === 0, `${JSON.stringify(out)} ref=${ref} tabs=${tabs.includes('/login')}`);
});

// 15b. 対照: AI が自分で開いた新しいタブ（開いた画面がない）では、ログインに進む（断りすぎていないか）
await scenario('自分で開いたタブ', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/home` });
  await s.tool('browser_tabs', { action: 'new', url: `${ORIGIN}/login` });
  await s.tool('browser_tabs', { action: 'close', index: 0 });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('対照: 自分で開いたタブではログインに進む', out?.status === 'submitted' && s.credentials.calls.length === 1, JSON.stringify(out));
});

// 16. コードを動かせる・手元のファイルを読める種類の住所は開かない
await scenario('住所の種類', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/home` });
  const bad = ['javascript:document.title="x"', 'data:text/html,<script>1</script>', 'file:///etc/hosts', 'blob:http://127.0.0.1/x', 'chrome://settings', 'view-source:https://example.com'];
  const nav = [];
  for (const url of bad) nav.push(parse(await s.tool('browser_navigate', { url }))?.status);
  const tab = parse(await s.tool('browser_tabs', { action: 'new', url: 'data:text/html,hi' }))?.status;
  const tabs = JSON.stringify(await s.tool('browser_tabs', { action: 'list' }));
  record('住所の種類: javascript・data・file 等は開かない', nav.every((x) => x === 'blocked') && tab === 'blocked' && !tabs.includes('data:') && tabs.includes('/home'), `${nav.join(',')} tab=${tab}`);
  const ok = ['https://example.com/', 'http://127.0.0.1:1/', 'about:blank', 'example.com'].every(urlAllowed) && !urlAllowed('JavaScript:1') && !urlAllowed(' javascript:1');
  record('住所の種類: http・https・about:blank・種類なしは通す', ok);
});

// 17. 同じブラウザ置き場で2つ同時に動かす（Claude Code と Codex を同時に使う等）
await scenario('同時に2つ', async () => {
  const profileDir = mkdtempSync(join(root, 'shared-'));
  const a = await start({ app: { profileDir } }); cleanup.push(a);
  const b = await start({ app: { profileDir } }); cleanup.push(b);
  await a.tool('browser_navigate', { url: `${ORIGIN}/home` });
  const nb = await b.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const out = parse(await b.tool('login', { site: 'test', reason: '受入試験' }));
  record('同時に2つ: 後から起動した方も画面を開いてログインできる', !nb?.isError && out?.status === 'submitted', JSON.stringify(out) ?? JSON.stringify(nb).slice(0, 200));
  const pa = a.app.browser.pid(), pb = b.app.browser.pid();
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const lockB = Number(readlinkSync(join(`${profileDir}-2`, 'SingletonLock')).split('-').pop());
  record('同時に2つ: 窓を前に出す相手はそれぞれ自分のブラウザ', Number.isInteger(pa) && Number.isInteger(pb) && pa !== pb && alive(pa) && alive(pb) && pb === lockB, `a=${pa} b=${pb} lockB=${lockB}`);
  await b.app.close();
  record('同時に2つ: 後から起動した方は別の置き場を使う', existsSync(`${profileDir}-2`) && filesWithPw(`${profileDir}-2`).length === 0);
});

// 18. 二段階認証の画面に進んだら、窓を前に出し、本人に任せるよう AI に伝える
await scenario('二段階認証', async () => {
  const focused = [];
  const s = await start({ app: { focusWindow: async (pid) => { focused.push(pid); return true; } } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-2fa` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('二段階認証: パスキーの画面に進んだら窓を前に出す', out?.status === 'submitted' && out.next_step === 'two_factor' && out.window_brought_to_front === true && focused.length === 1 && /two-factor/.test(out.note ?? ''), JSON.stringify(out));
  record('二段階認証: 返事・画面情報に平文が出ない', !hasPw(out) && !hasPw(await s.tool('browser_snapshot')));
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-otp` });
  const otp = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('二段階認証: 確認コード欄のある画面も見分ける', otp?.next_step === 'two_factor' && focused.length === 2, JSON.stringify(otp));
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const plain = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('対照: 二段階認証でない画面では窓を動かさない', plain?.status === 'submitted' && plain.next_step === undefined && focused.length === 2, JSON.stringify(plain));
});

// 18b. 画面なしで動かすとき（既定）は窓を前に出そうとしない
await scenario('二段階認証・画面なし', async () => {
  const s = await start(); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login-2fa` });
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('二段階認証: 画面なしでは前に出さず、そのことを返す', out?.next_step === 'two_factor' && out.window_brought_to_front === false, JSON.stringify(out));
});

// 19. 承認が通らなかったとき、理由を返す
await scenario('失敗の理由', async () => {
  const base = fakeCredentials();
  const s = await start({ credentials: { ...base, async get() { return { status: 'error', message: 'keychain error -25293' }; } } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const n = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('失敗の理由: キーチェーンが許可しなかったと分かる', out?.status === 'error' && out.message === 'keychain error -25293' && /常に許可/.test(out.hint ?? '') && received.length === n, JSON.stringify(out));
  const d = await start({ credentials: fakeCredentials({ decide: async () => false }) }); cleanup.push(d);
  await d.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const den = parse(await d.tool('login', { site: 'test', reason: '受入試験' }));
  record('失敗の理由: 本人が断ったと分かる', den?.status === 'denied' && /cancel/.test(den.hint ?? ''), JSON.stringify(den));
});

// 20. 承認の画面が押されないまま放置されたら、鍵係を止めて時間切れを返す（偽の鍵係で確かめる）
await scenario('承認の時間切れ', async () => {
  const dir = mkdtempSync(join(root, 'helper-'));
  const pidFile = join(dir, 'pid');
  const helper = join(dir, 'fake-helper');
  writeFileSync(helper, `#!/bin/sh
case "$1" in
  info) printf '{"site":"test","origin":"${ORIGIN}","user":"${USER}"}' ;;
  get) if [ "$2" = slow ]; then echo $$ > "${pidFile}"; exec sleep 999; fi
       printf '{"origin":"${ORIGIN}","user":"${USER}","password":"fake-ok"}' ;;
  *) exit 64 ;;
esac
`);
  chmodSync(helper, 0o755);
  const kc = createKeychain({ helper, getTimeoutMs: 1500 });
  const ok = await kc.get('test', ORIGIN, 'x');
  record('時間切れ: 時間内に終われば値を受け取れる（対照）', ok.status === 'ok' && ok.password === 'fake-ok' && ok.user === USER);
  const t0 = Date.now();
  const slow = await kc.get('slow', ORIGIN, 'x');
  const ms = Date.now() - t0;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  record('時間切れ: 待ち続けず時間切れを返し、鍵係を止める', slow.status === 'timeout' && ms < 5000 && !alive, `${JSON.stringify(slow)} ${ms}ms alive=${alive}`);
  const s = await start({ credentials: { ...kc, info: async () => ({ site: 'test', origin: ORIGIN, user: USER }), get: (site, o, r) => kc.get('slow', o, r) } }); cleanup.push(s);
  await s.tool('browser_navigate', { url: `${ORIGIN}/login` });
  const n = received.length;
  const out = parse(await s.tool('login', { site: 'test', reason: '受入試験' }));
  record('時間切れ: login は時間切れと次の手を返し、何も入力しない', out?.status === 'timeout' && /again/.test(out.hint ?? '') && received.length === n, JSON.stringify(out));
});

// 21. 置き場（画面の写し・ブラウザの保存先）は本人だけが読める。前の版で作られた誰でも読める置き場も締め直す。
await scenario('置き場は本人だけ', async () => {
  const dir = join(root, 'data-old');
  mkdirSync(join(dir, 'output'), { recursive: true });
  chmodSync(dir, 0o755);
  keepPrivate(dir);
  record('置き場: 前の版の誰でも読める置き場を本人だけに締め直す', (statSync(dir).mode & 0o777) === 0o700, (statSync(dir).mode & 0o777).toString(8));
  const fresh = join(root, 'data-new');
  keepPrivate(fresh);
  const sub = join(fresh, 'output');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'page.yml');
  writeFileSync(file, 'x');
  const modes = [fresh, sub, file].map((p) => statSync(p).mode & 0o777);
  record('置き場: 新しく作る置き場・中のフォルダ・写しのファイルに他人の読み書きが無い', modes.every((m) => (m & 0o077) === 0), modes.map((m) => m.toString(8)).join(' '));
});

// 22. パスワード管理の書き出し（CSV）から選んで登録する。キーチェーンは偽物で、パスワードは画面に出さない。
await scenario('CSV から取り込む', async () => {
  const P = ['Fk1-imp-PASS-a', 'Fk2-imp,PASS"b', 'Fk3-imp-PASS-c', 'Fk4-imp-PASS-d', 'Fk5-imp-PASS-e', 'Fk6-imp-PASS-f'];
  const chrome = '﻿name,url,username,password,note\r\n'
    + `Example,https://example.com/login,a@example.test,${P[0]},"メモ, 改行\nあり"\r\n`
    + `"Shop, Inc",https://shop.example.net/,b@example.test,"${P[1].replace(/"/g, '""')}",\r\n`
    + `アプリ,android://hash@com.example/,c,${P[2]},\r\n`
    + `Old,http://old.example.org/,d,${P[3]},\r\n`
    + 'Empty,https://empty.example.org/,e,,\r\n'
    + `ゆうびん,https://www.post.example.jp/,f,${P[4]},\r\n`
    + `Example,https://example.com/login,a@example.test,${P[0]},\r\n`;
  const rows = parseCsv(chrome);
  record('取り込み: CSV の読み（BOM・CRLF・引用符の中の , と改行と ""）', rows.length === 8 && rows[1][4] === 'メモ, 改行\nあり' && rows[2][0] === 'Shop, Inc' && rows[2][3] === P[1], JSON.stringify(rows.map((r) => r.length)));
  const plan = planImport(rows, [{ site: 'example', origin: 'https://example.com' }]);
  const sites = plan.items.map((i) => i.site);
  record('取り込み: https だけ・空と重複は飛ばす・登録済みの名前は別名・日本語だけの名前は住所から', JSON.stringify(sites) === '["example-2","shop-inc","post-example-jp"]' && plan.skipped.length === 4, `${sites} / ${plan.skipped.map((s) => s.reason)}`);
  record('取り込み: 作る名前はログインの道具が受ける形・同じ住所の登録済みに印', plan.items.every((i) => /^[A-Za-z0-9._-]{1,64}$/.test(i.site)) && plan.items[0].sameOrigin && !plan.items[1].sameOrigin);

  const bw = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
    + `,,login,Bank,,,,"androidapp://com.bank,https://bank.example.com/signin",g,${P[5]},otpauth://x\n`
    + ',,note,Memo,秘密のメモ,,,,,,\n';
  const ff = '"url","username","password","httpRealm","formActionOrigin"\n'
    + `"https://www.mail.example.com","h","${P[2]}","",""\n"https://router.example.com","i","${P[3]}","Router",""\n`;
  const b = planImport(parseCsv(bw)), f = planImport(parseCsv(ff));
  record('取り込み: Bitwarden（複数の住所から https・メモ項目は飛ばす）と Firefox（題名なし・認証窓は飛ばす）', b.items.length === 1 && b.items[0].origin === 'https://bank.example.com' && b.skipped.length === 1 && f.items.length === 1 && f.items[0].site === 'mail-example-com' && f.skipped.length === 1, `${JSON.stringify(b.items.map((i) => i.origin))} ${JSON.stringify(f.items.map((i) => i.site))}`);
  const brokenCsv = [
    `name,url,username,password\nBroken,https://x.example.com/,"j,${P[0]},extra\nOk,https://ok.example.com/,k,${P[1]}\n`,
    `name,url,username,password\nBroken,https://x.example.com/,j",${P[0]}",tail\n`,
    `name,url,username,password\nBroken,https://x.example.com/,"j"x,${P[0]}\n`,
  ];
  const brokenOut = [];
  for (const text of brokenCsv) {
    let added = 0, msg = '';
    try { await runImport({ text, keychain: { list: async () => [], add: async () => { added++; } }, ask: async () => 'all', print: (l) => brokenOut.push(l) }); } catch (e) { msg = e.message; }
    brokenOut.push(msg + (added ? ` 登録 ${added}` : ''));
  }
  record('取り込み: 引用符が崩れた CSV は全体を断り、何も登録せず値も出さない', brokenOut.length === 3 && brokenOut.every((l) => l.includes('引用符が崩れています')) && P.every((p) => !brokenOut.join('\n').includes(p)), brokenOut.join(' / '));
  const spaced = planImport(parseCsv('url,username,password\nhttps://example.com,user,a\nhttps://example.com, user ,a\n'));
  record('取り込み: ID の前後の空白は削らず、別の ID として両方残す', spaced.items.length === 2 && spaced.items[1].user === ' user ', JSON.stringify(spaced.items.map((i) => i.user)));
  const shifted = planImport(parseCsv(`name,url,username,password\nExtra,https://x.example.com/,j,${P[0]},more\nOk,https://ok.example.com/,k,${P[2]}\n`));
  record('取り込み: 列の数が合わない行は飛ばし、一覧にも名前にも値が出ない', shifted.skipped.some((s) => s.reason.startsWith('列の数')) && shifted.items.length === 1 && shifted.items.every((i) => !P.some((p) => i.site.includes(p.toLowerCase()) || i.user.includes(p))), shifted.skipped.map((s) => s.reason).join(" / "));
  const many = 'name,url,username,password\n' + Array.from({ length: 20000 }, (_, i) => `Demo,https://example.com/,u${i},p${i}`).join('\n');
  const t0 = Date.now();
  const manyPlan = planImport(parseCsv(many));
  const ms = Date.now() - t0;
  record('取り込み: 同じ名前が2万件でもすぐ終わり、名前は重ならない', manyPlan.items.length === 20000 && new Set(manyPlan.items.map((i) => i.site)).size === 20000 && manyPlan.items[19999].site === 'demo-20000' && ms < 2000, `${ms}ms`);
  let threw = false;
  try { planImport(parseCsv('a,b\n1,2\n')); } catch { threw = true; }
  record('取り込み: 住所とパスワードの列が無い CSV は断る', threw);

  const sel = [['', 3], ['all', 3], ['1, 3', 3], ['2-3', 3], ['0', 3], ['4', 3], ['3-2', 3], ['x', 3]].map(([a, n]) => JSON.stringify(parseSelection(a, n)));
  record('取り込み: 番号の読み（空=やめる・all・範囲・範囲外や読めない物は断る）', sel.join(' ') === '[] [0,1,2] [0,2] [1,2] null null null null', sel.join(' '));

  const run = async (answers, failOn) => {
    const out = [], added = [];
    const kc = {
      list: async () => [{ site: 'example', origin: 'https://example.com' }],
      add: async (site, v) => { if (site === failOn) throw new Error(`failed with ${v.password}`); added.push([site, v]); return { site, origin: v.origin }; },
    };
    const q = [...answers];
    const r = await runImport({ text: chrome, keychain: kc, ask: async (s) => { out.push(s); return q.shift() ?? ''; }, print: (s) => out.push(s) });
    return { r, out: out.join('\n'), added };
  };
  const ok = await run(['x', '1,3', 'yes']);
  record('取り込み: 読めない番号は聞き直し、選んだ物だけ登録', ok.added.length === 2 && ok.added[0][0] === 'example-2' && ok.added[0][1].password === P[0] && ok.added[1][0] === 'post-example-jp' && ok.out.includes('読めませんでした'), JSON.stringify(ok.added.map((a) => a[0])));
  const none = [await run(['']), await run(['all', 'no']), await run(['all', 'y'])];
  record('取り込み: 空の答え・最後の確認で yes 以外（y も）なら何も登録しない', none.every((n) => n.added.length === 0 && n.out.includes('やめました')));
  const bad = await run(['all', 'yes'], 'shop-inc');
  record('取り込み: 登録に失敗しても続け、件数を出す', bad.r.added === 2 && bad.r.failed === 1 && bad.out.includes('登録できませんでした: shop-inc'), JSON.stringify(bad.r));
  const all = [ok, ...none, bad].map((x) => x.out).join('\n');
  record('取り込み: 一覧・飛ばした理由・失敗の知らせのどこにもパスワードが出ない', P.every((p) => !all.includes(p)));
});

await scenario('端末の表示', async () => {
  const help = helpText();
  const cmds = ['list', 'add', 'import', 'remove', 'check', 'help', 'serve'];
  record('説明: 全部のコマンドが載る', cmds.every((c) => new RegExp(`^  ${c}\\b`, 'm').test(help)), cmds.filter((c) => !help.includes(`  ${c}`)).join(','));
  record('幅: 全角は2・英数字は1', width('abc') === 3 && width('名前') === 4 && width('（ID なし）') === 11, `${width('名前')} ${width('（ID なし）')}`);
  const t = table([['名前', 'サイト'], ['github', 'https://github.com'], ['a', 'https://a.example']]);
  const col = t.map((l) => width(l.slice(0, l.indexOf(l.includes('サイト') ? 'サイト' : 'https'))));
  record('表: 2列目の始まりがそろう（全角の見出しでも）', new Set(col).size === 1, JSON.stringify(col));
  const v = sitesView([{ site: 'zeta', origin: 'https://z.example' }, { site: 'alpha', origin: 'https://a.example' }]).split('\n');
  record('一覧: 件数・見出し・名前の順', v[0] === '登録 2 件' && v[1].includes('名前') && v[2].includes('alpha') && v[3].includes('zeta'), JSON.stringify(v));
  record('一覧: 空なら足し方を案内', sitesView([]).includes('add か import'));
  const evil = table([['ID'], ['alice\u001b[2J\u0007'], ['bob\u009b31m'], ['x\u202eevil'], ['line\nbreak\r']]).join('\n');
  record('表: 制御文字・向きを変える文字は見える形にして、そのまま出さない', !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/.test(evil) && evil.split('\n').length === 5 && evil.includes('alice\\u001b[2J\\u0007') && clean('a\u202eb') === 'a\\u202eb', JSON.stringify(evil));
  record('幅: 結合文字は前の字と1つ・絵文字は2', width('e\u0301') === 1 && width('👨‍👩‍👧‍👦') === 2 && width('😀') === 2, `${width('e\u0301')} ${width('👨‍👩‍👧‍👦')} ${width('😀')}`);
  const hidden = clean('a\u200bb\u00adc\u061cd\ufeffe\u2060f');
  record('表: 見えない文字（幅0の空白・ソフトハイフンなど）も見える形にする', hidden === 'a\\u200bb\\u00adc\\u061cd\\ufeffe\\u2060f', JSON.stringify(hidden));
  record('幅: 文字に近い記号（™ © ↔）は1・絵文字の形を指定した字と国旗は2', ['™', '©', '↔'].every((c) => width(c) === 1) && width('❤️') === 2 && width('🇯🇵') === 2, ['™', '©', '↔', '❤️', '🇯🇵'].map(width).join(' '));
  const filler = clean('a\u1160b\u3164c\u034fd');
  record('表: 拡張の漢字（𠮷）は幅2で列がそろい、ハングルの空き字なども見える形にする', width('𠮷') === 2 && new Set(table([['𠮷', 'x'], ['ab', 'x']]).map((l) => width(l.slice(0, l.lastIndexOf('x'))))).size === 1 && filler === 'a\\u1160b\\u3164c\\u034fd', `${width('𠮷')} ${JSON.stringify(filler)}`);
  const lone = clean('\u200d\u200cx\u200d');
  record('表: 古い仮名（𛀀）は幅2・つなぐ相手の無い先頭の ZWJ と見えないクメール文字は見える形にする', width('𛀀') === 2 && lone === '\\u200d\\u200cx\u200d' && clean('a\u17b4') === 'a\\u17b4', JSON.stringify(lone));
  let big = null;
  try { big = table(Array.from({ length: 200000 }, (_, i) => [`s${i}`, 'https://a.example'])); } catch (e) { big = e; }
  record('表: 20万行でも止まらない', Array.isArray(big) && big.length === 200000, String(big?.message ?? ''));
});

for (const s of cleanup) await s.app.close().catch(() => {});
server.close();
rmSync(root, { recursive: true, force: true });
const ng = results.filter((r) => !r.ok);
console.log(`\n${results.length - ng.length}/${results.length} 合格${ng.length ? '・不合格: ' + ng.map((r) => r.name).join(' / ') : ''}`);
process.exit(ng.length ? 1 : 0);
