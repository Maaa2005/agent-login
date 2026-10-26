// パスワード管理の書き出し（CSV）から、選んだ物だけをキーチェーンへ移す。
// 試験した形: Chrome・Firefox・Bitwarden の CSV。ほかも url（login_uri）と password の列があれば読む。
// パスワードは画面に一度も出さない。登録済みの名前は上書きしない。
import { showId, table } from './cli-view.mjs';

const SITE_RULE = /^[A-Za-z0-9._-]{1,64}$/; // server.mjs の login が受ける名前と同じ
const COLUMNS = {
  url: ['url', 'login_uri', 'website'],
  user: ['username', 'login_username'],
  password: ['password', 'login_password'],
  name: ['name', 'title'],
};

// RFC 4180 の CSV を行の配列にする（引用符・"" ・引用符の中の改行と , ・CRLF・先頭の BOM）。
// 引用符が崩れていたら全体を断る。崩れた所から列がずれ、パスワードの欠片が ID の欄に入るため。
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, line = 1;
  const broken = () => new Error(`CSV の ${line} 行目あたりで引用符が崩れています（何も登録していません）`);
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else { if (c === '\n') line++; field += c; }
    } else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false; line++;
    } else if (closed || (c === '"' && field !== '')) throw broken();
    else if (c === '"') quoted = true;
    else field += c;
  }
  if (quoted) throw broken();
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function slug(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

function firstHttps(value) {
  for (const part of value.split(/[\s,]+/)) {
    try {
      const u = new URL(part);
      if (u.protocol === 'https:') return u;
    } catch {}
  }
  return null;
}

// CSV の行から登録候補を作る。existing は keychain.list() の結果（{site, origin}）。
export function planImport(rows, existing = []) {
  if (!rows.length) throw new Error('CSV が空です');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(COLUMNS)) col[key] = head.findIndex((h) => names.includes(h));
  if (col.url < 0 || col.password < 0) throw new Error('見出しの行に住所（url）とパスワード（password）の列がありません');
  const typeCol = head.indexOf('type');
  const realmCol = head.indexOf('httprealm');

  const taken = new Set(existing.map((e) => e.site.toLowerCase()));
  const knownOrigins = new Set(existing.map((e) => e.origin));
  const seen = new Set();
  const nextNumber = new Map(); // 同じ名前の次の番号（件数が多くても遅くならないよう）
  const items = [], skipped = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k) => (col[k] >= 0 ? (r[col[k]] ?? '') : '');
    const skip = (reason) => skipped.push({ line, reason });
    if (r.length !== head.length) return skip('列の数が合わない（引用符の崩れなど）');
    if (typeCol >= 0 && r[typeCol] && r[typeCol].trim().toLowerCase() !== 'login') return skip('ログイン以外の項目');
    if (realmCol >= 0 && (r[realmCol] ?? '').trim()) return skip('ブラウザの認証窓の項目');
    const password = get('password');
    if (!password) return skip('パスワードが空');
    const url = firstHttps(get('url'));
    if (!url) return skip(get('url').trim() ? 'https の住所ではない（アプリ・http など）' : '住所が空');
    const user = get('user'); // 前後の空白も ID の一部として残す（削ると別の ID と重なる）
    const key = JSON.stringify([url.origin, user, password]);
    if (seen.has(key)) return skip('同じ内容が重複');
    seen.add(key);

    const base = slug(get('name')) || slug(url.hostname.replace(/^www\./, '')) || 'site';
    let site = base;
    if (taken.has(site)) {
      let n = nextNumber.get(base) ?? 2;
      while (taken.has(`${base}-${n}`)) n++;
      site = `${base}-${n}`;
      nextNumber.set(base, n + 1);
    }
    if (!SITE_RULE.test(site)) return skip('名前を作れない');
    taken.add(site);
    items.push({ site, origin: url.origin, user, password, sameOrigin: knownOrigins.has(url.origin) });
  });
  return { items, skipped };
}

// 「1,3,5-7」「all」を 0 始まりの番号にする。空なら [] (=やめる)、読めなければ null。
export function parseSelection(answer, count) {
  const a = answer.trim().toLowerCase();
  if (!a) return [];
  if (a === 'all') return [...Array(count).keys()];
  const picked = new Set();
  for (const tok of a.split(/[\s,、]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) return null;
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (from < 1 || to > count || from > to) return null;
    for (let n = from; n <= to; n++) picked.add(n - 1);
  }
  return [...picked].sort((x, y) => x - y);
}

// 対話の流れ全体。keychain は { list, add }、ask は質問して答えを返す関数、print は1行出す関数。
export async function runImport({ text, keychain, ask, print }) {
  const { items, skipped } = planImport(parseCsv(text), await keychain.list());
  const reasons = {};
  for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(reasons)) print(`飛ばす: ${reason} ${n} 件`);
  if (!items.length) { print('登録できる項目がありません'); return { added: 0, failed: 0 }; }

  print(`登録できる項目 ${items.length} 件（パスワードは表示しません）:`);
  const rows = items.map((it, i) => [`${i + 1}.`, it.site, it.origin, showId(it.user), it.sameOrigin ? '※同じ住所が登録済み' : '']);
  for (const line of table([['番号', '名前', 'サイト', 'ID', ''], ...rows])) print(line);
  let picked = null;
  for (let tries = 0; picked === null && tries < 3; tries++) {
    picked = parseSelection(await ask('AI に使わせる物の番号（例 1,3,5-7 / all / 空でやめる）: '), items.length);
    if (picked === null) print(`読めませんでした。1〜${items.length} の番号で入れてください`);
  }
  if (!picked?.length) { print('やめました（何も登録していません）'); return { added: 0, failed: 0 }; }
  const ok = (await ask(`${picked.length} 件を登録します。よければ yes: `)).trim().toLowerCase();
  if (ok !== 'yes') { print('やめました（何も登録していません）'); return { added: 0, failed: 0 }; }

  let added = 0, failed = 0;
  for (const i of picked) {
    const it = items[i];
    try {
      await keychain.add(it.site, { origin: it.origin, user: it.user, password: it.password });
      print(`登録しました: ${it.site} → ${it.origin}`);
      added++;
    } catch {
      print(`登録できませんでした: ${it.site}`);
      failed++;
    }
  }
  print(`登録 ${added} 件・失敗 ${failed} 件`);
  return { added, failed };
}
