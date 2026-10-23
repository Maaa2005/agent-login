#!/bin/sh
# 鍵係を作る。既定は手元の場所（../build）に、手元の bin/agent-login.mjs を焼き込んで作る。
# 入れる用には AGENT_LOGIN_SERVER（焼き込むサーバーの絶対パス）と AGENT_LOGIN_OUT（出力先）で別の場所へ作れる。
set -eu
cd "$(dirname "$0")"
out="${AGENT_LOGIN_OUT:-../build}"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
server="${AGENT_LOGIN_SERVER:-$(cd ../bin && pwd -P)/agent-login.mjs}"
case "$server" in /*) ;; *) echo "サーバーの場所は絶対パスで: $server" >&2; exit 1 ;; esac
case "$server" in *'"'*|*'\'*) echo "場所に \" や \\ を含むと作れません: $server" >&2; exit 1 ;; esac
printf '// build.sh が作る。手で直さない。\nlet serverScript = "%s"\n' "$server" > "$out/config.swift"
cp agent-login-helper.swift "$out/main.swift"
xcrun swiftc -O -swift-version 5 -o "$out/agent-login-helper" "$out/main.swift" "$out/config.swift"
# hardened runtime 付き・get-task-allow なしで署名する（同じ利用者のデバッガを断る）。
codesign --force --sign - --options runtime --identifier dev.agent-login.helper "$out/agent-login-helper"
echo "built: $out/agent-login-helper (server: $server)"
