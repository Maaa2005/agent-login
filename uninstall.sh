#!/bin/sh
# agent-login を消す（Mac 専用）。
#   ./uninstall.sh           入れた物（/opt/agent-login と /usr/local/bin/agent-login）を消す。管理者パスワードを1回聞く。
#   ./uninstall.sh --purge   加えて、サイトの一覧（~/.config/agent-login）とブラウザの記録（~/.cache/agent-login）も消す。
# キーチェーンのパスワードはこの台本では消さない。先に agent-login remove <名前> で消す。
set -eu

PREFIX="${AGENT_LOGIN_PREFIX:-/opt/agent-login}"
BINDIR="${AGENT_LOGIN_BINDIR:-/usr/local/bin}"
TEST="${AGENT_LOGIN_TEST:-0}"
PURGE=0

die() { printf 'agent-login uninstall: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
# 入れる時と同じ方法で場所をそろえる（ある所まで遡ってリンクをたどる）。
canon() {
  d=$1 rest=
  while [ ! -d "$d" ]; do rest="/$(basename "$d")$rest"; d=$(dirname "$d"); done
  d=$(cd "$d" && pwd -P); [ "$d" = / ] && d=
  printf '%s%s\n' "$d" "$rest"
}

for a in "$@"; do
  case "$a" in --purge) PURGE=1 ;; *) die "知らない指定です: $a（使えるのは --purge だけ）" ;; esac
done
[ "$(id -u)" -ne 0 ] || die "sudo を付けずに実行してください (run without sudo)"
case "$PREFIX" in /*/agent-login) ;; *) die "消す場所の最後は agent-login のはずです: $PREFIX" ;; esac
case "$BINDIR" in /*) ;; *) die "リンクの場所は絶対パスで指定してください: $BINDIR" ;; esac
PREFIX="$(canon "$(dirname "$PREFIX")")/agent-login"
BINDIR="$(canon "$BINDIR")"
[ -n "${HOME:-}" ] && [ "$HOME" != / ] || die "HOME が分かりません"

if [ -e "$PREFIX" ]; then
  [ ! -L "$PREFIX" ] && [ -x "$PREFIX/bin/agent-login" ] && [ -x "$PREFIX/runtime/node" ] && [ -f "$PREFIX/app/bin/agent-login.mjs" ] \
    || die "$PREFIX は agent-login の形ではないので消しません"
  say "登録してあるサイト:"
  "$PREFIX/bin/agent-login" list || true
  say ""
  say "キーチェーンのパスワードも消すなら、この台本の前に1件ずつ: $PREFIX/bin/agent-login remove <名前>"
else
  say "$PREFIX はありません（入れた物は消し済み）"
fi
say "AI の登録を外す: claude mcp remove agent-login -s user ／ codex mcp remove agent-login"
[ "$PURGE" = 1 ] && say "--purge: $HOME/.config/agent-login と $HOME/.cache/agent-login も消します"

if [ "${AGENT_LOGIN_YES:-0}" != 1 ]; then
  printf '消してよければ yes と入力: '
  read -r ans </dev/tty || ans=
  [ "$ans" = yes ] || die "やめました（何も消していません）"
fi

REMOVE='set -eu
prefix=$1 bindir=$2
link="$bindir/agent-login"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$prefix/bin/agent-login" ]; then rm -f "$link"; fi
if [ -e "$prefix" ]; then rm -rf "$prefix"; fi'
if [ "$TEST" = 1 ]; then
  /bin/sh -c "$REMOVE" sh "$PREFIX" "$BINDIR"
else
  say "管理者パスワードを聞きます（管理者の持ち物を消すため）"
  sudo /bin/sh -c "$REMOVE" sh "$PREFIX" "$BINDIR"
  sudo -k
fi
say "消しました: $PREFIX"

if [ "$PURGE" = 1 ]; then
  rm -rf "$HOME/.config/agent-login" "$HOME/.cache/agent-login"
  say "消しました: $HOME/.config/agent-login と $HOME/.cache/agent-login"
fi
