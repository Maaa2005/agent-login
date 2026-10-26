// 端末に出す説明と一覧の形。中身を変えず、読みやすく並べるだけ。

// 見た目の幅（全角は2）。名前と住所は英数字だが、ID に日本語が入る事がある。
export function width(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

export function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

// 行の配列（各行は文字の配列）を、列の幅をそろえて並べる。最後の列は詰めない。
export function table(rows, indent = '  ') {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = [...Array(cols).keys()].map((i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  return rows.map((r) => indent + r.map((c, i) => (i < r.length - 1 ? pad(c, w[i]) : c)).join('   ').trimEnd());
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
