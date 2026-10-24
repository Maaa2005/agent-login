#!/bin/sh
# agent-login を管理者の持ち物として入れる（Mac 専用）。
#   ./install.sh    /opt/agent-login に入れる。最後に管理者パスワードを1回聞く。
# 試験用（sudo を使わず、持ち主も変えない）:
#   AGENT_LOGIN_TEST=1 AGENT_LOGIN_PREFIX=/private/tmp/t/agent-login AGENT_LOGIN_BINDIR=/private/tmp/t/bin ./install.sh
# AI を動かしていない時に、自分のターミナルで実行すること。
set -eu
# 作る物の権限を、本人の umask に左右されない形にする。
umask 022

# /opt を既定にする: 上の階層に他の道具の部品置き場（/usr/local/lib/node_modules など）が無い。
PREFIX="${AGENT_LOGIN_PREFIX:-/opt/agent-login}"
BINDIR="${AGENT_LOGIN_BINDIR:-/usr/local/bin}"
TEST="${AGENT_LOGIN_TEST:-0}"
SRC="$(cd "$(dirname "$0")" && pwd -P)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

die() { printf 'agent-login install: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
# まだ無い場所は、ある所まで遡ってリンクをたどり、本当の場所にそろえる。
canon() {
  d=$1 rest=
  while [ ! -d "$d" ]; do rest="/$(basename "$d")$rest"; d=$(dirname "$d"); done
  d=$(cd "$d" && pwd -P); [ "$d" = / ] && d=
  printf '%s%s\n' "$d" "$rest"
}

# ---- 事前の確認 ----
[ "$(uname -s)" = Darwin ] || die "Mac 専用です (macOS only)"
[ "$(id -u)" -ne 0 ] || die "sudo を付けずに実行してください。必要な所だけ管理者パスワードを聞きます (run without sudo)"
plain() {
  case "$1" in *[[:space:]]*|*'"'*|*'\'*|*"'"*|*'$'*|*'`'*) die "場所に空白や記号（\" ' \\ \$ \`）は使えません: $1" ;; esac
}
for p in "$PREFIX" "$BINDIR"; do
  case "$p" in /*) ;; *) die "場所は絶対パスで指定してください: $p" ;; esac
  plain "$p"
done
[ "$(basename "$PREFIX")" = agent-login ] || die "入れる場所の最後は agent-login にしてください: $PREFIX"
# 鍵係に焼き込む場所と、実際に起動する場所を一致させる。
PREFIX="$(canon "$(dirname "$PREFIX")")/agent-login"
BINDIR="$(canon "$BINDIR")"
[ -n "$BINDIR" ] || die "リンクの場所に / は使えません"
# リンクをたどった後の場所も確かめる（起動口と置く手順にそのまま書くため）。
plain "$PREFIX"; plain "$BINDIR"
LINK="$BINDIR/agent-login"
# リンクは入れる場所の外に置き、このインストールが作ったリンク以外は上書きしない。
case "$BINDIR" in "$PREFIX"|"$PREFIX"/*) die "リンクの場所を入れる場所の中にはできません: $BINDIR" ;; esac
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$PREFIX/bin/agent-login" ] \
    || die "$LINK に別の物があります。自分で片付けるか、AGENT_LOGIN_BINDIR で別の場所を指定してください"
fi

# 上の階層を管理者以外が書き換えられると、入れた物ごと差し替えられる。本番ではそこも確かめる。
if [ "$TEST" != 1 ]; then
  d=$(dirname "$PREFIX")
  while [ "$d" != / ]; do
    if [ -e "$d" ]; then
      [ "$(stat -f %Su "$d")" = root ] || die "$d の持ち主が管理者ではありません。AGENT_LOGIN_PREFIX で別の場所を指定してください"
      [ -z "$(find "$d" -maxdepth 0 -perm +022)" ] || die "$d は管理者以外も書き込めます。AGENT_LOGIN_PREFIX で別の場所を指定してください"
    fi
    d=$(dirname "$d")
  done
fi

xcrun --find swiftc >/dev/null 2>&1 || die "Swift が見つかりません。xcode-select --install で開発ツールを入れてください"
[ -x "$CHROME" ] || die "Google Chrome が /Applications にありません"
command -v npm >/dev/null 2>&1 || die "npm が見つかりません"

NODE_FROM="${AGENT_LOGIN_NODE:-$(command -v node || true)}"
[ -n "$NODE_FROM" ] || die "node が見つかりません。nodejs.org の Mac 版（v20 以上）を入れてください"
# volta・asdf などの中継ぎではなく、本物の node の場所を node 自身に聞く（realpath が無い古い Mac でも動く）。
NODE_FROM="$("$NODE_FROM" -p 'require("fs").realpathSync(process.execPath)' 2>/dev/null)" \
  || die "node を起動できません: ${AGENT_LOGIN_NODE:-$(command -v node)}"
file -b "$NODE_FROM" | grep -q '^Mach-O' || die "node の本体が見つかりません: $NODE_FROM"
"$NODE_FROM" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null \
  || die "この node は古すぎます（v20 以上が必要）: $NODE_FROM"
# 署名し直した node は Mac 標準以外の部品を読めなくなる。Homebrew 版などは断る。
otool -L "$NODE_FROM" | awk '/^\t/ {print $1}' | while read -r lib; do
  case "$lib" in /usr/lib/*|/System/*) ;; *) exit 1 ;; esac
done || die "この node は Mac 標準以外の部品に頼っています（Homebrew 版など）。nodejs.org 版か fnm・nvm の node を使ってください: $NODE_FROM"

# ---- 組み立て（自分の権限で、使い捨ての場所に） ----
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/agent-login-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
trap 'exit 1' HUP INT TERM
ROOT="$STAGE/root"
mkdir -p "$ROOT/bin" "$ROOT/runtime" "$ROOT/app/build"

say "1/4 本体と部品をそろえる"
cp -R "$SRC/bin" "$SRC/src" "$ROOT/app/"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/LICENSE" "$ROOT/app/"
(cd "$ROOT/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

say "2/4 鍵係を作る"
AGENT_LOGIN_SERVER="$PREFIX/app/bin/agent-login.mjs" AGENT_LOGIN_OUT="$STAGE/helper-build" sh "$SRC/helper/build.sh"
cp "$STAGE/helper-build/agent-login-helper" "$ROOT/app/build/"

say "3/4 node を写して署名し直す（デバッガを断る形）"
cp "$NODE_FROM" "$ROOT/runtime/node"
chmod 755 "$ROOT/runtime/node"
cat > "$STAGE/node.entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
</dict></plist>
EOF
codesign --force --sign - --options runtime --entitlements "$STAGE/node.entitlements" \
  --identifier dev.agent-login.node "$ROOT/runtime/node"

# 起動口: 環境を空にし、決まった node で起動する。
# node の旗や NODE_ で始まる設定は鍵係の確認が断るので付けない（README の限界に書いた）。
cat > "$ROOT/bin/agent-login" <<EOF
#!/bin/sh
# install.sh が作る。手で直さない。
exec /usr/bin/env -i HOME="\$HOME" USER="\${USER:-}" LOGNAME="\${LOGNAME:-}" TMPDIR="\${TMPDIR:-/tmp}" \\
  LANG="\${LANG:-en_US.UTF-8}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
  "$PREFIX/runtime/node" "$PREFIX/app/bin/agent-login.mjs" "\$@"
EOF
chmod 755 "$ROOT/bin/agent-login"

check_sig() {
  codesign --verify --strict "$1" || die "署名の確認に失敗: $1"
  codesign -d --verbose=2 "$1" 2>&1 | grep -q '^CodeDirectory .*flags=.*runtime' || die "hardened runtime が付いていません: $1"
  if codesign -d --entitlements - --xml "$1" 2>/dev/null | grep -q get-task-allow; then die "get-task-allow が付いています: $1"; fi
}
check_sig "$ROOT/runtime/node"
check_sig "$ROOT/app/build/agent-login-helper"
"$ROOT/runtime/node" -e 0 || die "署名し直した node が動きません"

# ---- 置く（ここだけ管理者の権限） ----
say "4/4 $PREFIX に置く"
PLACE='set -eu
umask 022
stage=$1 prefix=$2 bindir=$3 test=$4
link="$bindir/agent-login" want="$prefix/bin/agent-login"
new="$prefix.new.$$" old="$prefix.old.$$"
# 置き換える前に確かめる。リンクの場所に別の物がある時や、既にある物が agent-login でない時は何も変えない。
if [ -e "$link" ] || [ -L "$link" ]; then
  if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$want" ]; then echo "$link に別の物があるので変えません" >&2; exit 1; fi
fi
if [ -e "$prefix" ] || [ -L "$prefix" ]; then
  if [ -L "$prefix" ] || [ ! -x "$prefix/runtime/node" ] || [ ! -x "$prefix/bin/agent-login" ]; then
    echo "既にある $prefix は agent-login ではないので消しません" >&2; exit 1
  fi
fi
mkdir -p "$(dirname "$prefix")" "$bindir"
# 前に同じ番号で止まった時の残りがあれば消してから始める。
rm -rf "$new" "$old"
mkdir -m 755 "$new"
# 途中で止まったら、作りかけを消し、退避した前の版を戻す（新しい版を置いた後でも、リンクまで済むまでは戻す）。
fin=0
undo() {
  rm -rf "$new"
  if [ "$fin" != 1 ] && [ -d "$old" ]; then rm -rf "$prefix"; mv "$old" "$prefix"; fi
}
trap undo EXIT
trap "exit 1" HUP INT TERM
cp -R "$stage/." "$new/"
if [ "$test" != 1 ]; then chown -R root:wheel "$new"; fi
chmod -R go-w,a+rX "$new"
for f in "$new/runtime/node" "$new/app/build/agent-login-helper"; do codesign --verify --strict "$f"; done
if [ -e "$prefix" ]; then mv "$prefix" "$old"; fi
mv "$new" "$prefix"
[ -L "$link" ] || ln -s "$want" "$link"
# 前の版は、全部済んでから消す。
fin=1
rm -rf "$old"'
if [ "$TEST" = 1 ]; then
  /bin/sh -c "$PLACE" sh "$ROOT" "$PREFIX" "$BINDIR" 1
else
  say "管理者パスワードを聞きます（置き場所を管理者の持ち物にするため）"
  # 途中で失敗・中断しても、管理者の許可を残さない。
  trap 'rm -rf "$STAGE"; sudo -k' EXIT
  sudo /bin/sh -c "$PLACE" sh "$ROOT" "$PREFIX" "$BINDIR" 0
  sudo -k
fi

say ""
say "入りました: $PREFIX"
say "AI に登録する（前に登録していれば、先に remove してから）:"
say "  Claude Code: claude mcp add agent-login -s user -- $PREFIX/bin/agent-login serve"
say "  Codex CLI:   codex mcp add agent-login -- $PREFIX/bin/agent-login serve"
say "サイトの登録: $PREFIX/bin/agent-login add <名前> <https://ログイン画面の住所>"
