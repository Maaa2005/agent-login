# agent-login

[English](README.en.md)

Claude Code や Codex CLI にブラウザ作業をさせているとき、ログイン画面で本人が指紋認証で承認すると、Mac のキーチェーンに置いた ID とパスワードをこの道具が直接入力する MCP サーバー（Mac 専用・無料）。

できること: 本人の承認後に対応サイトへログイン情報を入力し、会話や設定ファイルへのパスワードの貼り付けを減らす。
できないこと: AI が本気で取り出そうとするのを完全に止めること（下の「限界」）。

## 入れ方

必要な物:

- macOS（確かめたのは macOS 26.7・Apple シリコンの1台）
- `/Applications` の Google Chrome
- Xcode のコマンドラインツール（`xcode-select --install`）
- Node.js v20 以上と npm（nodejs.org の Mac 版、または fnm・nvm で入れた物。Homebrew 版は使えない）

**AI を動かしていない時に**、自分のターミナルで実行する。

```sh
git clone <このリポジトリの URL> agent-login
cd agent-login
./install.sh
```

最後に管理者パスワードを1回聞く。やる事:

1. 本体と部品を `/opt/agent-login` に置き、全部を管理者（root）の持ち物にする。AI は本人と同じ権限で動くので、中身を書き換えられない。
2. いま使っている node を写し、デバッガをつなげない形（hardened runtime 付き・get-task-allow なし）で署名し直す。
3. キーチェーン係（helper）をその場で作り、同じ形で署名する。
4. `/usr/local/bin/agent-login` から本体へのリンクを置く。そこに既に別の物があれば、何も変えずに止まる。

入った後の確認（全部 PASS なら終了コード 0）:

```sh
sh tests/install-check.sh
```

AI に登録する。リンクではなく `/opt` の場所をそのまま書く。前に別の形で登録していたら、先に `claude mcp remove agent-login -s user` ／ `codex mcp remove agent-login` で外す。

```sh
claude mcp add agent-login -s user -- /opt/agent-login/bin/agent-login serve   # Claude Code
codex mcp add agent-login -- /opt/agent-login/bin/agent-login serve            # Codex CLI
```

サイトを登録する（ID とパスワードを聞く。パスワードは画面に出ない）:

```sh
/opt/agent-login/bin/agent-login check                                      # 承認画面を出せるか確かめる
/opt/agent-login/bin/agent-login add github https://github.com/login
```

更新するとき、また node を新しくした時は `./install.sh` をやり直す（入れた物は写した node を使い続けるため）。やり直すとキーチェーン係も作り直すので、登録済みの項目で一度キーチェーンの許可を求められることがある。

入れる前（開発用の形）に登録したキーチェーンの項目を、入れた形で読めるかは確かめていない。最初のログインが失敗したら、`agent-login remove <名前>` の後に `add` で登録し直す。

### 試験用に入れる

管理者パスワードを使わず、持ち主も変えずに、好きな場所へ入れて動きを確かめられる。守りは本番より弱い。

```sh
AGENT_LOGIN_TEST=1 AGENT_LOGIN_PREFIX=/private/tmp/t/agent-login AGENT_LOGIN_BINDIR=/private/tmp/t/bin ./install.sh
AGENT_LOGIN_TEST=1 sh tests/install-check.sh /private/tmp/t/agent-login
```

`AGENT_LOGIN_PREFIX`（入れる場所。最後は `agent-login`）と `AGENT_LOGIN_BINDIR`（リンクの場所）は本番でも使える。本番では、入れる場所より上の階層が全部管理者の持ち物で、他の人が書き込めない事を確かめてから入れる。

## 消し方

```sh
/opt/agent-login/bin/agent-login list                # 登録してあるサイト
/opt/agent-login/bin/agent-login remove <名前>       # キーチェーンのパスワードも消すなら、先に1件ずつ
./uninstall.sh                                       # /opt/agent-login とリンクを消す（管理者パスワードを1回聞く）
./uninstall.sh --purge                               # 加えて ~/.config/agent-login と ~/.cache/agent-login も消す
claude mcp remove agent-login -s user                # AI の登録を外す
codex mcp remove agent-login
```

`uninstall.sh` は消す前に一覧を見せ、`yes` の入力を待つ。中身が agent-login の形でない場所は消さない。

## 使い方

Claude Code や Codex では「github にログインして〇〇して」のように頼む。AI は `browser_navigate` でログイン画面を開き、`login` を呼ぶ。Mac の承認画面が出るので、内容を見て指紋（またはパスワード）で承認する。

Claude Code と Codex を同時に使うと、サーバーも2つ動く。ブラウザの保存先は1つのブラウザしか使えないので、後から起動した方は `~/.cache/agent-login/profile-2`（さらに後は -3 … -5）を使う。ログイン状態（クッキー）は保存先ごとに別になる。

その他: `agent-login list`（登録一覧）、`agent-login remove <名前>`（削除）、`serve --headless`。`serve --executable-path <Chrome の場所>` も動くが、その起動ではキーチェーン係が値を渡さない（ログインは使えない）。

### 入力欄が自動で見つからないサイト

`~/.config/agent-login/sites.json` に CSS セレクタを書く（どれも省略可）。

```json
{
  "github": { "username": "#login_field", "password": "#password", "submit": "input[type=submit]" }
}
```

## 仕組み

- Playwright MCP（0.0.83）をこの道具の中に組み込み、ブラウザ操作の道具はそのまま使える。足すのは `login` と `login_sites` の2つ。
- `login(site, reason)` が呼ばれると:
  1. 開いているタブが1つで、https で、パスワード欄が1つだけで、住所が登録した住所と完全に一致するかを確かめる。
  2. Mac の承認画面（指紋またはパスワード）を出す。拒否ならパスワードはこの道具にも読み込まれない。
  3. 承認待ちの間に画面が変わっていないかを確かめ直す。
  4. ID とパスワードを入力して送信し、成功・失敗に関係なくパスワード欄を空にする。
  5. AI に返すのは結果（送信した／拒否／理由）だけ。値は返さない。
- AI に返す前の内容と、ブラウザ道具が書き出すファイルは、パスワードを伏せ字にする。JSON・URL・HTML の書き方に変わった形も伏せる。
- 任意のコードを実行する道具（`browser_run_code_unsafe`）は止めている。
- キーチェーン係は、決まった形で起動したサーバーから呼ばれた時だけ値を読む。別のコードを読み込ませる指定が付いた起動では、承認画面を出す前に断る。AI が係を直接実行しても承認画面は出ない。
- サーバーは外から調べる道具をつなぐ合図（SIGUSR1）を無視する。
- ブラウザで開ける住所は http・https・about:blank だけ（javascript:・data:・file: 等は開かない）。
- `browser_evaluate` でコードを動かした住所では、そのサーバーが動いている間ずっとログインしない。動かした後は、その住所の Service Worker とキャッシュを消す。
- 別の画面から開かれたタブではログインしない（開いた側が中身を書き換えられるため）。
- `login_sites` は登録一覧に加え、この起動でキーチェーン係が値を渡せるか（`login_ready`）を返す。渡せない起動なら理由も返すので、承認画面を出す前に分かる。
- 入れた形（`install.sh`）の起動口は、環境変数を空にしてから、写して署名し直した node で本体を起動する。

## 開発用の形

このフォルダから直接動かす形。コードが本人の持ち物のままなので、入れた形の守り（管理者の持ち物・デバッガを断る署名）は無い。試験と開発に使う。

```sh
npm install
npm run build-helper                      # キーチェーン係を ./build に作る
npm test
node bin/agent-login.mjs check
claude mcp add -s user agent-login -- "$(command -v node)" "$PWD/bin/agent-login.mjs" serve
```

fnm や nvm を使っている場合、`command -v node` が一時的な場所を指すことがある。その場合は既定版の固定の場所（fnm なら `~/.local/share/fnm/aliases/default/bin/node`）を使う。このフォルダを動かしたら `npm run build-helper` で作り直す（キーチェーン係が覚えたサーバーの場所が変わるため）。

## 試験

`npm test`: 合成パスワード（毎回ランダム）を使い、ローカルの試験用サイトで次を確かめる（48件）。

- 対照: 伏せ字を切ると、画面情報・欄の値・コンソール・通信の中身・コンソール記録ファイル・保存した画面情報ファイルのすべてで平文が見つかること（見つける力の確認）。
- 本番: 普通のフォーム・JS で送るフォーム・値を写し取るページ・道具の同時呼び出しのそれぞれで、AI への返事とファイルに平文が0件。
- 拒否: 承認拒否・住所の不一致・埋め込み枠・パスワード欄が2つ・欄の指定が不正・タブ2つ・http・承認中の画面変化で、何も入力しない。
- コードを動かした住所・別の画面から開かれたタブでは断り、対照（別の住所・自分で開いたタブ）では通る。javascript:・data:・file: 等は開かない。
- `login_sites` が、キーチェーン係に断られる起動では `login_ready: false` と理由を返す。
- 同じ保存先で2つ起動しても、後の方は別の保存先でブラウザを開いてログインでき、その保存先にも平文が残らない。

この試験は本物のキーチェーン係ではなく試験用の係を使う。本物の係と指紋の承認は手で確かめる。

`tests/install-check.sh`: 入れた物について、管理者の持ち物か（上の階層も）・他のユーザーも読めて起動できるか・署名が壊れていないか・hardened runtime 付きか・デバッガや外の部品を許す権限が無いか・動いている node にデバッガがつながらないか（Mac の記録で理由まで）・起動時にキーチェーン係の確認を通るか、を確かめる。

手で確かめた事:

- キーチェーン係の呼び出し元の確認を、起動の形を変えたサーバーの起動記録で確かめた。
- Codex CLI 0.163.0 で、登録した起動が確認を通ること（`login_ready: true`）と、Claude Code 側が動いている間にもブラウザを開けること。
- 本物の承認（指紋）を通したログインは、開発用の形で 2026-10-23 に Claude Code から GitHub で成功（ID・パスワード送信→二段階認証の画面へ進んだ）。入れた形と Codex からは未実施。

## 限界

- AI は本人と同じ権限で動くので、この道具は取り出しを難しくするだけで、完全には止められない。
- キーチェーン係からサーバーへパスワードを渡す経路は、本人と同じ権限で動く物から完全には守れておらず、作り直しはまだしていない。
- node の起動時に付けられる追加の守りは、キーチェーン係の呼び出し元の確認と合わないため付けていない。
- Chrome 本体・サイトの一覧（`sites.json`）・ブラウザの保存データは本人の持ち物のままで、管理者の持ち物にはしていない。
- 他のアプリや道具に既に与えた Mac の権限（画面の操作など）は、この道具では制限しない。
- 入れる途中は本人の持ち物の一時フォルダで組み立てるので、AI を動かしていない時に入れる前提にしている。
- 開発用の形には、入れた形の守り（管理者の持ち物・デバッガを断る署名）が無い。
- 承認画面の理由文は AI が書くので、内容が正しいとは限らない。
- 二段階認証のコードは本人が入れる。
- 1つのタブの最上位の画面だけが対象で、埋め込み枠（iframe）の中のログイン欄には入力しない。
- ブラウザ道具が書き出すファイルの伏せ字は、すべての書き込み方を覆ってはおらず、道具の呼び出し後の掃除で補っている。
- キーチェーンの項目そのものには指紋の条件を付けておらず、指紋の承認はこの道具が出している。
- Apple の有料の署名はしておらず、署名は入れる Mac の上でその場で行う。
- 入れた形のキーチェーン係で、指紋の承認からログインまでを通した確認はまだしていない。

## ライセンス

Apache-2.0
