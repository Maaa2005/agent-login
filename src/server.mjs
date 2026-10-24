// Playwright MCP を組み込み、その前に立つ MCP サーバー。
// AI からの通信はほぼそのまま中へ渡し、次の3点だけ手を入れる。
//   1. 道具の一覧に login / login_sites を足し、login はこちらで処理する（値は AI に返さない）。
//   2. 道具の呼び出しを1つずつ順番に通す（ログインの途中に画面情報を取らせない）。
//   3. 中から出てくる返事・通知と保存ファイルから、入力したパスワードを伏せ字にする。
//   4. AI がコードを動かした住所・別の画面から開かれた画面・危ない種類の住所ではログインしない。
import { createConnection } from '@playwright/mcp';
import fs, { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { createBrowser, focusApp } from './browser.mjs';

// 置き場（ログイン後の画面の写し・ブラウザの保存先）は本人だけが読めるようにする。
// 同じ Mac の別の利用者から見えないよう、既にある置き場も締め直し、この後に作る物も本人だけにする。
export function keepPrivate(dir) {
  process.umask(0o077);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

const MASK = '********';

const LOGIN_TOOL = {
  name: 'login',
  description:
    'Sign in on the login form that is open in the current tab, using credentials the user registered in advance. ' +
    'The user is asked to approve on their Mac (Touch ID or Mac password) and the form is filled only after approval. ' +
    'The password is never returned to you. Open the login page with browser_navigate first and keep exactly one tab open. ' +
    'Use login_sites to see registered site names. Two-factor codes are entered by the user.',
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', description: 'Registered site name (see login_sites)' },
      reason: { type: 'string', description: 'Short reason shown to the user in the approval dialog' },
    },
    required: ['site', 'reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Log in with approval', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const SITES_TOOL = {
  name: 'login_sites',
  description: 'List site names and origins registered for the login tool, and whether login can work in this launch (login_ready). No passwords or user IDs are returned.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Registered login sites', readOnlyHint: true, openWorldHint: false },
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

// このサーバーと同じプロセスで任意のコードを動かす道具。ログイン中の通信を横取りできるので出さない。
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe']);

// 画面の中で AI が書いたコードを動かす道具。動かした住所は、そのコードが入力欄を見張れるので以後ログインしない。
const CODE_TOOLS = new Set(['browser_evaluate']);

// 開いてよい住所の種類。javascript: や data: は画面の中でコードを動かせ、file: は手元のファイルを読めるので断る。
// 読めない住所は Playwright が https:// を付けて開くのでそのまま通す。
export function urlAllowed(raw) {
  if (typeof raw !== 'string') return true;
  let u;
  try { u = new URL(raw); } catch { return true; }
  return u.protocol === 'https:' || u.protocol === 'http:' || u.href === 'about:blank';
}
function urlArgOf(name, args) {
  if (name === 'browser_navigate') return args?.url;
  if (name === 'browser_tabs') return args?.url;
  return undefined;
}

// 1つずつ順番に通すための鍵。
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// パスワードが通信や記録に現れうる形をまとめて持つ。
// 記号は JSON・JS 文字列・URL・HTML で別の書き方に化けるので、1文字ずつ「そのまま／\ 付き／%XX／&…;／\uXXXX」を許して探す。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HTML_NAMED = { '&': ['&amp;'], '"': ['&quot;'], "'": ['&apos;', '&#39;'], '<': ['&lt;'], '>': ['&gt;'], ' ': ['&nbsp;'] };
function charPattern(ch) {
  if (/[A-Za-z0-9]/.test(ch)) return ch;
  const code = ch.codePointAt(0);
  const hex4 = code.toString(16).padStart(4, '0');
  const forms = new Set([ch, `&#${code};`, `&#x${code.toString(16)};`, ...(HTML_NAMED[ch] ?? [])]);
  if (ch === ' ') forms.add('+');
  const alts = [...forms].map(escapeRe);
  alts.push(`\\\\[uU]0*${hex4}`);
  // %XX は二重に URL 化されても拾う（%2521 など）。
  alts.push([...Buffer.from(ch, 'utf8')].map((b) => `%(?:25)?${b.toString(16).padStart(2, '0')}`).join(''));
  return `(?:\\\\*(?:${alts.join('|')}))`;
}
export function createMasker() {
  const variants = new Set();
  const patterns = [];
  const add = (pw) => {
    if (!pw || variants.has(pw)) return;
    variants.add(pw);
    patterns.push(new RegExp([...pw].map(charPattern).join(''), 'gi'));
  };
  const maskString = (s) => {
    let out = s;
    for (const re of patterns) out = out.replace(re, MASK);
    return out;
  };
  const maskDeep = (value) => {
    if (typeof value === 'string') return maskString(value);
    if (Array.isArray(value)) return value.map(maskDeep);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
      return out;
    }
    return value;
  };
  const scrubFile = (file) => {
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) return;
      const buf = readFileSync(file);
      const text = buf.toString('utf8');
      const masked = maskString(text);
      if (masked !== text) writeFileSync(file, masked);
    } catch {}
  };
  const scrubDir = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scrubDir(p);
      else if (e.isFile()) scrubFile(p);
    }
  };
  return { add, maskString, maskDeep, scrubDir, scrubFile, get active() { return variants.size > 0; } };
}

// Playwright MCP は同じ処理の中でファイルを書く（コンソールの記録は道具を呼ばなくても随時追記される）。
// 書く瞬間に伏せ字を掛け、後から掃除するまでの間に平文がディスクへ出ないようにする。
const writeMaskers = new Set();
let writeGuardInstalled = false;
function maskData(data) {
  if (!writeMaskers.size) return data;
  const isBuf = Buffer.isBuffer(data) || data instanceof Uint8Array;
  if (typeof data !== 'string' && !isBuf) return data;
  const text = isBuf ? Buffer.from(data).toString('utf8') : data;
  let out = text;
  for (const m of writeMaskers) out = m.maskString(out);
  if (out === text) return data;
  return isBuf ? Buffer.from(out, 'utf8') : out;
}
function installWriteGuard() {
  if (writeGuardInstalled) return;
  writeGuardInstalled = true;
  const p = fs.promises;
  for (const name of ['writeFile', 'appendFile']) {
    const orig = p[name].bind(p);
    p[name] = (file, data, ...rest) => orig(file, maskData(data), ...rest);
    const origSync = fs[`${name}Sync`].bind(fs);
    fs[`${name}Sync`] = (file, data, ...rest) => origSync(file, maskData(data), ...rest);
    const origCb = fs[name].bind(fs);
    fs[name] = (file, data, ...rest) => origCb(file, maskData(data), ...rest);
  }
}

const isRequest = (m) => typeof m?.method === 'string' && m.id !== undefined;
const isResponse = (m) => m && m.method === undefined && m.id !== undefined;
// 承認が通らなかったときの理由を、本人に伝えられる言葉にする（鍵係のエラー出力は番号だけで、秘密は含まない）。
function credentialFailure(status, message) {
  const code = /keychain error (-?\d+)/.exec(message ?? '')?.[1];
  const hint = {
    denied: 'The user cancelled or failed the Touch ID / Mac password check. Ask the user before trying again.',
    timeout: 'Nobody approved the Touch ID / keychain prompt in time, so the request was cancelled. A prompt still on screen can be dismissed; approving it does nothing. Calling login again shows a new prompt.',
    not_registered: 'This site is not registered in the keychain. The user registers it with `agent-login add`.',
    origin_mismatch: 'The page address differs from the registered one. Nothing was entered.',
    caller_not_allowed: 'This server is not the one the keychain helper trusts. Reinstall agent-login.',
  }[status] ?? ({
    '-128': 'The user pressed Deny (拒否) on the keychain prompt.',
    '-25293': 'macOS keychain did not allow access. Ask the user to approve the prompt with "Always Allow" (常に許可), or register the site again with `agent-login add`.',
    '-25308': 'macOS keychain could not show its prompt (no user interaction allowed). Ask the user to unlock the Mac and try again.',
    '-25300': 'The keychain item was not found. Register the site again with `agent-login add`.',
  }[code] ?? 'The keychain helper failed. Show the message to the user.');
  return { message: message ? String(message).slice(0, 200) : undefined, hint };
}

// 二段階認証（ワンタイムコード・パスキー・確認コード）の画面らしいか。外れても窓を前に出すだけなので広めに取る。
const TWO_FACTOR_PATH = /two[-_]?factor|2fa|mfa|otp|totp|webauthn|passkey|verif|challenge|security[-_]?code/i;
async function looksLikeTwoFactor(page, url) {
  if (TWO_FACTOR_PATH.test(url.pathname)) return true;
  const n = await page.locator('input[autocomplete="one-time-code"]').locator('visible=true').count().catch(() => 0);
  return n > 0;
}

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: obj.status !== 'submitted' && obj.status !== 'ok' });

/**
 * credentials: { info(site) -> {origin,user}|null, get(site, origin, reason) -> {status, user?, password?}, list() }
 * sites: { [site]: { username?: selector, password?: selector, submit?: selector } }
 */
export async function createAgentLogin({
  credentials, sites = {}, outputDir, profileDir, headless = false, channel = 'chrome', executablePath,
  allowInsecureHosts = false, submitWaitMs = 5000, mask = true,
  focusWindow = headless ? null : focusApp, // 二段階認証の画面に進んだら窓を前に出す（試験では差し替える）
} = {}) {
  if (!credentials) throw new Error('credentials is required');
  if (!outputDir) throw new Error('outputDir is required');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const browser = createBrowser({ profileDir, headless, channel, executablePath });
  const masker = createMasker();
  if (mask) { installWriteGuard(); writeMaskers.add(masker); }
  const lock = createLock();
  const taintedOrigins = new Set(); // AI がコードを動かした住所（このサーバーが動いている間ずっと）
  const popupPages = new WeakSet();  // 別の画面から開かれた画面（開いた側から中身を書き換えられうる）
  const watched = new WeakSet();
  const watchPage = (p) => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('popup', (child) => { popupPages.add(child); watchPage(child); });
  };
  const watchContext = (c) => {
    if (watched.has(c)) return c;
    watched.add(c);
    c.pages().forEach(watchPage);
    c.on('page', watchPage);
    return c;
  };
  const inner = await createConnection({ outputDir, saveSession: false }, async () => watchContext(await browser.getContext()));

  let client = null;               // 外側（AI 側）の通信路
  const pendingToInner = new Map(); // AI の要求 id -> { method, resolve }
  const clean = (m) => (mask ? masker.maskDeep(m) : m);
  const sendToClient = (m) => client.send(clean(m));
  const savedFileArgs = new Map();  // 要求 id -> filename 引数（保存先の後始末用）

  // 中（Playwright MCP）との通信路。
  const innerTransport = {
    async start() {},
    async close() {},
    async send(msg) {
      if (isResponse(msg)) {
        const pending = pendingToInner.get(msg.id);
        pendingToInner.delete(msg.id);
        if (pending?.method === 'tools/list' && msg.result && !msg.result.nextCursor) {
          const tools = (msg.result.tools ?? []).filter((t) => !BLOCKED_TOOLS.has(t.name));
          msg = { ...msg, result: { ...msg.result, tools: [...tools, LOGIN_TOOL, SITES_TOOL] } };
        }
        if (pending?.method === 'tools/call' && mask && masker.active) {
          masker.scrubDir(outputDir);
          const fn = savedFileArgs.get(msg.id);
          if (fn) masker.scrubFile(isAbsolute(fn) ? fn : resolve(process.cwd(), fn));
          for (const p of pathsIn(msg)) masker.scrubFile(p);
        }
        savedFileArgs.delete(msg.id);
        await sendToClient(msg);
        pending?.resolve();
        return;
      }
      await sendToClient(msg); // 中からの通知・要求（roots/list など）
    },
  };
  await inner.connect(innerTransport);

  const forward = (msg) => new Promise((done) => {
    pendingToInner.set(msg.id, { method: msg.method, resolve: done });
    if (msg.method === 'tools/call' && typeof msg.params?.arguments?.filename === 'string') savedFileArgs.set(msg.id, msg.params.arguments.filename);
    innerTransport.onmessage(msg);
  });

  async function handleClient(msg) {
    if (!isRequest(msg)) { innerTransport.onmessage(msg); return; } // 通知・中の要求への返事
    if (msg.method !== 'tools/call') { await forward(msg); return; }
    const name = msg.params?.name;
    if (BLOCKED_TOOLS.has(name)) {
      await sendToClient({ jsonrpc: '2.0', id: msg.id, result: text({ status: 'blocked', message: `${name} is disabled by agent-login.` }) });
      return;
    }
    if (!urlAllowed(urlArgOf(name, msg.params?.arguments))) {
      await sendToClient({ jsonrpc: '2.0', id: msg.id, result: text({ status: 'blocked', message: 'Only http, https and about:blank URLs can be opened.' }) });
      return;
    }
    if (CODE_TOOLS.has(name)) {
      await lock(async () => {
        await taintAll();
        await forward(msg);
        await clearWorkers();
      });
      return;
    }
    if (name === 'login' || name === 'login_sites') {
      await lock(async () => {
        let result;
        try {
          result = name === 'login' ? text(await doLogin(msg.params.arguments ?? {})) : text({ status: 'ok', sites: await listSites(), ...(await readiness()) });
        } catch (e) {
          result = text({ status: 'error', message: String(e?.message ?? e) });
        }
        await sendToClient({ jsonrpc: '2.0', id: msg.id, result });
      });
      return;
    }
    await lock(() => forward(msg));
  }

  // コードを動かす前に、開いている全画面・全枠の住所を記録する。about:blank 等の枠は親の住所を継ぐ。
  async function taintAll() {
    const context = watchContext(await browser.getContext());
    for (const page of context.pages()) {
      for (const frame of page.frames()) {
        for (let f = frame; f; f = f.parentFrame()) {
          let o = 'null';
          try { o = new URL(f.url()).origin; } catch {}
          if (o !== 'null') { taintedOrigins.add(o); break; }
        }
      }
    }
  }

  // コードが仕込んだ Service Worker と Cache を消す（次の読み込みで偽の画面を返させない）。
  async function clearWorkers() {
    const context = await browser.peekContext();
    const page = context?.pages().find((p) => !p.isClosed());
    if (!page) return;
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
      for (const origin of taintedOrigins) {
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'service_workers,cache_storage' }).catch(() => {});
      }
    } catch {} finally { await cdp?.detach().catch(() => {}); }
  }

  // この起動で鍵係が値を渡せるか（渡せない起動の形なら、承認画面を出す前に断られる）。
  async function readiness() {
    if (!credentials.callerCheck) return {};
    const c = await credentials.callerCheck().catch((e) => ({ ok: false, why: String(e?.message ?? e) }));
    return c.ok ? { login_ready: true } : { login_ready: false, login_not_ready_reason: `${c.why}. Ask the user to check how agent-login is started.` };
  }

  async function listSites() {
    const rows = (await credentials.list?.()) ?? [];
    return rows.map((r) => ({ site: r.site, origin: r.origin }));
  }

  function originAllowed(u) {
    if (u.protocol === 'https:') return true;
    return allowInsecureHosts && u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  }

  // 今の画面がログインしてよい状態かを確かめ、入力先を決める。
  async function inspect(site) {
    const context = await browser.peekContext();
    if (!context) return { status: 'no_browser', message: 'Open the login page with browser_navigate first.' };
    const pages = context.pages().filter((p) => !p.isClosed());
    if (pages.length !== 1) return { status: 'too_many_tabs', message: `Exactly one tab must be open (found ${pages.length}).` };
    const page = pages[0];
    let url;
    try { url = new URL(page.url()); } catch { return { status: 'bad_url' }; }
    if (!originAllowed(url)) return { status: 'insecure_origin', origin: url.origin, message: 'Only https pages are supported.' };
    if (popupPages.has(page)) return { status: 'popup_tab', origin: url.origin, message: 'This tab was opened by another page. Open the login page with browser_navigate in a normal tab.' };
    if (taintedOrigins.has(url.origin)) {
      return { status: 'code_was_run', origin: url.origin, message: 'Code was run on this site with browser_evaluate in this session. Ask the user to restart agent-login, then log in before running code.' };
    }
    const conf = sites[site] ?? {};
    const pwSel = conf.password ?? 'input[type="password"]';
    const pw = page.locator(pwSel).locator('visible=true');
    const count = await pw.count();
    if (count !== 1) {
      const inFrames = await Promise.all(page.frames().filter((f) => f !== page.mainFrame())
        .map((f) => f.locator('input[type="password"]').count().catch(() => 0)));
      if (count === 0 && inFrames.some((n) => n > 0)) return { status: 'iframe_not_supported', origin: url.origin };
      return { status: count === 0 ? 'no_password_field' : 'ambiguous_password_field', origin: url.origin };
    }
    const type = await pw.evaluate((el) => (el instanceof HTMLInputElement ? el.type : '')).catch(() => '');
    if (type !== 'password') return { status: 'not_a_password_field', origin: url.origin };
    const userLoc = conf.username
      ? page.locator(conf.username).locator('visible=true')
      : pw.locator('xpath=preceding::input[not(@type) or @type="text" or @type="email" or @type="tel"][1]').locator('visible=true');
    const hasUser = (await userLoc.count()) === 1;
    return { status: 'ready', page, url, pw, user: hasUser ? userLoc : null, conf };
  }

  async function doLogin({ site, reason }) {
    if (typeof site !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(site)) return { status: 'bad_site' };
    if (typeof reason !== 'string' || !reason.trim()) return { status: 'reason_required' };
    const info = await credentials.info(site);
    if (!info) return { status: 'not_registered', site };

    const before = await inspect(site);
    if (before.status !== 'ready') return before;
    const origin = before.url.origin;
    if (origin !== info.origin) return { status: 'origin_mismatch', site, page_origin: origin, registered_origin: info.origin };

    // ここで本人に承認を求める。拒否・不一致ならパスワードはこのプロセスにも来ない。
    const cred = await credentials.get(site, origin, reason.trim().slice(0, 120));
    if (cred.status !== 'ok') return { status: cred.status, site, ...credentialFailure(cred.status, cred.message) };
    if (cred.origin && cred.origin !== origin) return { status: 'origin_mismatch', site };
    const password = cred.password;
    masker.add(password);

    // 承認を待つ間に画面が変わっていないかを確かめ直す。
    const now = await inspect(site);
    if (now.status !== 'ready' || now.page !== before.page || now.url.href !== before.url.href) {
      return { status: 'page_changed', site, message: 'The page changed while waiting for approval. Nothing was entered.' };
    }
    const { page, pw, user, conf } = now;

    let submitted = false;
    try {
      if (user && cred.user) await user.fill(cred.user);
      await pw.fill(password);
      const signal = Promise.race([
        page.waitForNavigation({ timeout: submitWaitMs }).catch(() => null),
        page.waitForRequest((r) => r.method() !== 'GET' && r.frame() === page.mainFrame(), { timeout: submitWaitMs }).catch(() => null),
      ]);
      if (conf.submit) await page.locator(conf.submit).click();
      else await pw.press('Enter');
      submitted = true;
      await signal;
      await page.waitForLoadState('domcontentloaded', { timeout: submitWaitMs }).catch(() => {});
    } finally {
      await clearPasswords(page, password);
    }
    const after = new URL(page.url());
    const stillOnForm = (await page.locator('input[type="password"]').locator('visible=true').count().catch(() => 0)) > 0;
    // 二段階認証は本人がその窓で行う。パスキーは窓が前に無いと気づけないので前に出す。
    const twoFactor = submitted && await looksLikeTwoFactor(page, after);
    let focused = false;
    if (twoFactor && focusWindow) {
      await page.bringToFront().catch(() => {});
      focused = await Promise.resolve(focusWindow(browser.pid())).catch(() => false);
    }
    return {
      status: submitted ? 'submitted' : 'error',
      site,
      origin: after.origin,
      path: after.pathname,
      password_field_still_visible: stillOnForm,
      ...(twoFactor ? { next_step: 'two_factor', window_brought_to_front: focused } : {}),
      note: twoFactor
        ? `The site asks for two-factor authentication. ${focused ? 'The browser window was brought to the front. ' : ''}Ask the user to finish it (passkey, code, etc.) in the agent-login browser window, then check with browser_snapshot. Do not enter codes yourself unless the user gives them.`
        : stillOnForm ? 'A password field is still shown. Login may have failed or needs another step; check with browser_snapshot.' : undefined,
    };
  }

  // 送信後、パスワード欄と同じ値の欄を空にする。値そのものは同じ住所の画面にだけ渡す。
  async function clearPasswords(page, password) {
    const origin = new URL(page.url()).origin;
    for (const frame of page.frames()) {
      let sameOrigin = false;
      try { sameOrigin = new URL(frame.url()).origin === origin; } catch {}
      await frame.evaluate(([pw]) => {
        for (const el of document.querySelectorAll('input, textarea')) {
          if (el.type === 'password' || (pw !== null && el.value === pw)) el.value = '';
        }
      }, [sameOrigin ? password : null]).catch(() => {});
    }
  }

  return {
    async connect(transport) {
      client = transport;
      transport.onmessage = (msg) => { handleClient(msg).catch((e) => process.stderr.write(`agent-login: ${e?.stack ?? e}\n`)); };
      transport.onclose = () => { browser.close(); };
      await transport.start?.();
    },
    async close() {
      await clearWorkers();
      await browser.close();
      await inner.close?.();
      writeMaskers.delete(masker);
    },
    browser,
  };
}

// 返事に出てくる保存ファイルの場所を拾う（中が出力先の外に書いた場合の後始末）。
function pathsIn(msg) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\]\((\/[^)\s]+)\)/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(msg.result);
  return [...found];
}
