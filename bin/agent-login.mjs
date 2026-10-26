#!/usr/bin/env node
// agent-login serve [--headless] [--executable-path <path>]   Claude Code から起動される MCP サーバー（--executable-path の起動ではキーチェーン係が値を渡さない）
// agent-login add <site> <origin>                             ID とパスワードをキーチェーンに登録（パスワードは画面に出ない）
// agent-login import <file.csv>                               パスワード管理の書き出し（CSV）から選んだ物だけ登録
// agent-login list | remove <site> | check | help
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { keychain } from '../src/keychain.mjs';
import { runImport } from '../src/import.mjs';
import { helpText, sitesView } from '../src/cli-view.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const configDir = join(homedir(), '.config', 'agent-login');
const dataDir = join(homedir(), '.cache', 'agent-login');

function loadSites() {
  const file = join(configDir, 'sites.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Ctrl-D は空の答え（=やめる）、Ctrl-C は何もせず終える。
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    let answered = false;
    rl.on('SIGINT', () => { process.stderr.write('\nやめました（何も登録していません）\n'); process.exit(130); });
    rl.on('close', () => { if (!answered) { process.stderr.write('\n'); res(''); } });
    rl.question(question, (a) => { answered = true; rl.close(); res(a); });
  });
}

// 入力を画面に出さずに1行読む。
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('パスワードは端末から直接入力してください（パイプ不可）'));
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { value = value.slice(0, -1); continue; }
        value += c;
      }
    };
    stdin.on('data', onData);
  });
}

function opt(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

switch (cmd) {
  case 'serve': {
    // SIGUSR1 で調べる道具（インスペクター）を後付けされると、中のパスワードを読まれうるので無視する。
    process.on('SIGUSR1', () => {});
    const caller = await keychain.callerCheck().catch((e) => ({ ok: false, why: e.message }));
    console.error(caller.ok ? 'agent-login: 鍵係の確認 ok' : `agent-login: この起動では鍵を受け取れません（${caller.why}）。npm run build-helper で作り直すか、node ${process.argv[1]} serve の形で起動してください`);
    const { createAgentLogin, keepPrivate } = await import('../src/server.mjs');
    keepPrivate(dataDir);
    const { stdioTransport } = await import('../src/stdio.mjs');
    const app = await createAgentLogin({
      credentials: keychain,
      sites: loadSites(),
      outputDir: join(dataDir, 'output'),
      profileDir: join(dataDir, 'profile'),
      headless: rest.includes('--headless'),
      executablePath: opt('--executable-path'),
    });
    const transport = stdioTransport();
    await app.connect(transport);
    const shutdown = async () => { await app.close().catch(() => {}); process.exit(0); };
    transport.onclose = shutdown;
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }
  case 'add': {
    const [site, origin] = rest;
    if (!site || !origin) { console.error('使い方: agent-login add <名前> <https://ログイン画面の住所>'); process.exit(64); }
    let o;
    try { o = new URL(origin).origin; } catch { console.error('住所が読めません'); process.exit(64); }
    const user = (await ask(`${o} の ID（メールアドレス等）: `)).trim();
    const password = await askHidden('パスワード（画面には出ません）: ');
    if (!password) { console.error('パスワードが空です'); process.exit(64); }
    const r = await keychain.add(site, { origin: o, user, password });
    console.error(`登録しました: ${r.site} → ${r.origin}`);
    break;
  }
  case 'import': {
    const [file] = rest;
    if (!file) { console.error('使い方: agent-login import <書き出した CSV>'); process.exit(64); }
    if (!process.stdin.isTTY) { console.error('選ぶのは本人だけにするため、端末から直接動かしてください（パイプ不可）'); process.exit(64); }
    // 大きすぎる物は読み込む前に断る（読んでから数えると、その間にメモリを使い切る）。
    let size; try { size = statSync(file).size; } catch { console.error('CSV を読めません'); process.exit(66); }
    if (size > 20 * 1024 * 1024) { console.error('CSV が大きすぎます（20MB まで）'); process.exit(65); }
    let bytes; try { bytes = readFileSync(file); } catch { console.error('CSV を読めません'); process.exit(66); }
    if (bytes.length > 20 * 1024 * 1024) { console.error('CSV が大きすぎます（20MB まで）'); process.exit(65); }
    // 読めない文字を置き換えて読むと、壊れたパスワードを登録してしまうので断る。
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { console.error('CSV が UTF-8 ではありません（書き出し直してください）'); process.exit(65); }
    let result;
    try {
      result = await runImport({ text, keychain, ask, print: (s) => console.error(s) });
    } catch (e) { console.error(e.message); process.exit(65); }
    console.error('CSV にはパスワードがそのまま入っています。終わったら消して、ゴミ箱も空にしてください');
    if (result.failed) process.exit(1); // 1件でも登録できなければ、呼んだ側に分かるように
    break;
  }
  case 'list': {
    const rows = await keychain.list();
    // 端末なら表、パイプ先（ほかの道具）には今までどおりタブ区切り。
    if (process.stdout.isTTY) console.log(sitesView(rows));
    else for (const r of rows) console.log(`${r.site}\t${r.origin}`);
    break;
  }
  case 'remove': {
    if (!rest[0]) { console.error('使い方: agent-login remove <名前>'); process.exit(64); }
    const r = await keychain.remove(rest[0]);
    console.error(r.removed ? `削除しました: ${r.site}` : `登録がありません: ${r.site}`);
    break;
  }
  case 'check': {
    const r = await keychain.canAuth();
    console.log(r.ok ? 'この Mac で承認の画面を出せます' : `承認の画面を出せません: ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }
  case undefined: case 'help': case '-h': case '--help':
    console.log(helpText());
    break;
  default:
    console.error(`知らないコマンドです: ${cmd}\n\n${helpText()}`);
    process.exit(64);
}
