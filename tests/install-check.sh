#!/bin/sh
# 入れた後の確認。1つでも FAIL なら終了コード 1。
#   sh tests/install-check.sh                      /opt/agent-login を確かめる
#   AGENT_LOGIN_TEST=1 sh tests/install-check.sh /private/tmp/t/agent-login
#                                                  試験用に入れた物を確かめる（持ち主の確認は飛ばす）
set -u
P="${1:-${AGENT_LOGIN_PREFIX:-/opt/agent-login}}"
TEST="${AGENT_LOGIN_TEST:-0}"
pass=0 fail=0 skip=0
ok()   { pass=$((pass + 1)); printf 'PASS %s\n' "$*"; }
ng()   { fail=$((fail + 1)); printf 'FAIL %s\n' "$*"; }
skp()  { skip=$((skip + 1)); printf 'SKIP %s\n' "$*"; }

[ -d "$P" ] || { echo "FAIL $P がありません"; exit 1; }
# 入れる時と同じく、リンクをたどった絶対パスにそろえる（相対パスでも上の階層の確認が終わるように）。
Q=$(cd "$P" && pwd -P) || { echo "FAIL $P に入れません"; exit 1; }
P=$Q
NODE="$P/runtime/node" HELPER="$P/app/build/agent-login-helper" LAUNCH="$P/bin/agent-login"

# 1. 持ち主と書き込み権
if [ "$TEST" = 1 ]; then
  skp "持ち主の確認（試験用に入れた物）"
else
  bad=$(find "$P" \( ! -user root -o -perm +022 \) -print 2>&1 | head -3)
  [ -z "$bad" ] && ok "中身は全部 root の持ち物で、他の人は書き込めない" || ng "root 以外か書き込める物がある: $bad"
  d=$(dirname "$P") badp=
  while [ "$d" != / ]; do
    if [ "$(stat -f %Su "$d")" != root ] || [ -n "$(find "$d" -maxdepth 0 -perm +022 2>&1)" ]; then badp="$badp $d"; fi
    d=$(dirname "$d")
  done
  [ -z "$badp" ] && ok "上の階層も root の持ち物で、他の人は書き込めない" || ng "上の階層に書き換えられる所がある:$badp"
fi

# 1b. 他のユーザーも読めて起動できること（入れた時の umask に左右されていないか）
# find が読めずに失敗した時も、その出力で FAIL にする（2>&1）。
unread=$(find "$P" \( \( -type d ! -perm -005 \) -o \( -type f ! -perm -004 \) \) -print 2>&1 | head -3)
noexec=$(find "$LAUNCH" "$NODE" "$HELPER" ! -perm -001 -print 2>&1)
[ -z "$unread$noexec" ] && ok "他のユーザーも読めて起動できる" || ng "他のユーザーが読めないか起動できない物がある: $unread $noexec"

# 2. 署名（hardened runtime 付き・get-task-allow なし）
for f in "$NODE" "$HELPER"; do
  n=$(basename "$f")
  codesign --verify --strict "$f" 2>/dev/null && ok "$n: 署名が壊れていない" || ng "$n: 署名の確認に失敗"
  codesign -d --verbose=2 "$f" 2>&1 | grep -q '^CodeDirectory .*flags=.*runtime' && ok "$n: hardened runtime 付き" || ng "$n: hardened runtime なし"
  ents=$(codesign -d --entitlements - --xml "$f" 2>/dev/null || true)
  if printf '%s' "$ents" | grep -q -e get-task-allow -e disable-library-validation -e allow-dyld-environment-variables; then
    ng "$n: デバッガや外の部品を許す権限が付いている"
  else
    ok "$n: デバッガや外の部品を許す権限なし"
  fi
done

# 3. 動いている node にデバッガが付けないこと。
# 断られただけでは理由が分からない（開発者モードが無い等でも断られる）ので、
# Mac の記録に「hardened で get-task-allow が無いから断った」と残っている事まで確かめる。
if command -v lldb >/dev/null 2>&1; then
  "$NODE" -e 'setTimeout(() => {}, 30000)' &
  pid=$!
  sleep 1
  out=$(perl -e 'alarm 25; exec @ARGV' lldb -p "$pid" --batch -o 'process detach' 2>&1 || true)
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  sleep 1
  why=$(/usr/bin/log show --last 60s --style compact --predicate "eventMessage CONTAINS \"(pid: $pid)\"" 2>/dev/null \
    | grep 'macOSTaskPolicy' | grep 'is hardened' | grep "doesn't have get-task-allow" | head -1)
  if ! printf '%s' "$out" | grep -q 'Not allowed to attach'; then
    ng "node: デバッガを断らなかった: $(printf '%s' "$out" | tail -1)"
  elif [ -z "$why" ] && [ -z "$(/usr/bin/log show --last 60s --style compact 2>/dev/null | head -2 | tail -1)" ]; then
    # 管理者でない利用者は Mac の記録を読めない。読めない時は失敗ではなく飛ばす（読めて理由が無い時は失敗のまま）。
    skp "node: デバッガは断った。Mac の記録を読めない（管理者でない等）ので理由の確認は飛ばす"
  elif [ -z "$why" ]; then
    ng "node: デバッガは断ったが、署名のおかげかを Mac の記録で確かめられない（判定できない）"
  else
    ok "node: デバッガを断る（Mac の記録: hardened・get-task-allow なしのため）"
  fi
else
  skp "lldb が無いのでデバッガの確認を飛ばす"
fi

# 4. 起動口と鍵係の確認
grep -q '^exec /usr/bin/env -i ' "$LAUNCH" && grep -Fq "\"$P/runtime/node\" \"$P/app/bin/agent-login.mjs\"" "$LAUNCH" \
  && ok "起動口: 環境を空にして、入れた node と本体を使う" || ng "起動口の中身が想定と違う"
line=$(cd / && perl -e 'alarm 20; exec @ARGV' "$LAUNCH" serve </dev/null 2>&1 | head -1)
case "$line" in *"鍵係の確認 ok"*) ok "起動時の鍵係の確認: $line" ;; *) ng "起動時の鍵係の確認: $line" ;; esac

printf '%s passed, %s failed, %s skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
