// 端末に出す説明と一覧の形。中身を変えず、読みやすく並べるだけ。

// 端末を動かす文字（制御文字・向きを変える文字）と見えない文字は \uXXXX の形で見せる。ID は CSV から来るので何が入るか分からない。
// 結合用の ZWJ・ZWNJ（200C・200D）は、英数字以外の字の後ろなら絵文字や文字の一部なので残す（幅は前の字に含めて数える）。
export function clean(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    // ZWJ・ZWNJ が先頭や英数字・記号・空白（と別の ZWJ・ZWNJ）の後ろにあると、つなぐ相手が無く見えないだけなので見せる。
    .replace(/(?<![^\x00-\x7f\u200c\u200d])[\u200c\u200d]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

// 見た目の幅（全角と絵文字は2・結合文字は前の字に含める）。™ © ↔ のような文字に近い記号は1（絵文字の形を指定した時だけ2）。名前と住所は英数字だが、ID に日本語（𠮷 のような拡張の漢字や 𛀀 のような古い仮名も）が入る事がある。
const graphemes = new Intl.Segmenter();
export function width(s) {
  let w = 0;
  for (const { segment } of graphemes.segment(s)) {
    // 結合文字（\p{M}）を除いた字で決める。後ろに付く結合文字は幅に数えず、前に付く記号（U+0600 など）があっても後ろの漢字で2になる。
    const base = segment.replace(/\p{M}/gu, '');
    w += /\p{Emoji_Presentation}|\ufe0f/u.test(segment) || /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{16fe0}-\u{18dff}\u{1b000}-\u{1b2ff}\u{20000}-\u{3fffd}]/u.test(base) ? 2 : 1;
  }
  return w;
}

// ID の見せ方。前後の空白も ID の一部なので、ある時は "" で囲んで見えるようにする（空白だけの ID も同じ）。
// 前後が " の ID も囲む（中の " は \" になるので、空白入りの ID と見分けられる）。
export function showId(user) {
  if (!user) return '（ID なし）';
  return /^[\s"]|[\s"]$/.test(user) ? JSON.stringify(user) : user;
}

export function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

// 行の配列（各行は文字の配列）を、列の幅をそろえて並べる。最後の列は詰めない。
// 件数が多くても止まらないよう、幅は1行ずつ数える。
export function table(rows, indent = '  ') {
  const cells = rows.map((r) => r.map(clean));
  const w = [];
  for (const r of cells) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, width(c)); });
  return cells.map((r) => indent + r.map((c, i) => (i < r.length - 1 ? pad(c, w[i]) : c)).join('   ').trimEnd());
}

export function helpText() {
  // 2つの表を1つとして並べ、説明の列の位置をそろえる。
  const own = [
    ['list', '登録してあるサイトを見る'],
    ['add <名前> <住所>', '1件を手で登録する（例: add github https://github.com）'],
    ['import <CSV>', 'パスワード管理の書き出しから選んで登録する'],
    ['remove <名前>', '1件を消す'],
    ['check', '承認の画面（指紋）を出せるか確かめる'],
    ['help', 'この説明を出す'],
  ];
  const lines = table([...own, ['serve [--headless]', 'Claude Code・Codex が起動する']]);
  return [
    'agent-login  AI 用のログイン係（パスワードは Mac のキーチェーンに置く）',
    '',
    '登録と確認:',
    ...lines.slice(0, own.length),
    '',
    'AI 側が使う（自分で打つ事はない）:',
    ...lines.slice(own.length),
    '',
    '入力欄が見つからないサイトの指定: ~/.config/agent-login/sites.json',
  ].join('\n');
}

// 登録一覧。rows は keychain.list() の結果（{site, origin}）。
export function sitesView(rows) {
  if (!rows.length) return 'まだ登録がありません。agent-login add か import で足せます';
  const sorted = [...rows].sort((a, b) => a.site.localeCompare(b.site));
  return [`登録 ${rows.length} 件`, ...table([['名前', 'サイト'], ...sorted.map((r) => [r.site, r.origin])])].join('\n');
}
