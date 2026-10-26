// 鍵係（helper/agent-login-helper）を呼ぶ。パスワードはこのプロセスの中だけを通り、標準出力やログには出さない。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const helperPath = fileURLToPath(new URL('../build/agent-login-helper', import.meta.url));

// 承認の画面（指紋・キーチェーン）が誰にも押されないと鍵係は戻らない。get は時間で打ち切る（既定 4 分）。
export const DEFAULT_GET_TIMEOUT_MS = 240_000;

function run(helper, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!existsSync(helper)) return reject(new Error('鍵係が未作成です。npm run build-helper を実行してください'));
    // 入力は渡す値があるとき（add）だけつなぐ。鍵係が読む前に終わる（断った等）と書き込みが EPIPE になり、
    // 受け取り手が無いと serve ごと落ちるので、error は受け取って結果は鍵係の終わり方で決める。
    const p = spawn(helper, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false, timer = null, killer = null, inErr = null;
    p.stdin?.on('error', (e) => { inErr = e; });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        p.kill('SIGTERM');
        killer = setTimeout(() => p.kill('SIGKILL'), 2000);
      }, timeoutMs);
    }
    p.stdout.on('data', (d) => { if (!timedOut) out.push(d); });
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { clearTimeout(timer); clearTimeout(killer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killer);
      if (timedOut) return resolve({ code: null, timedOut: true, stdout: '', stderr: '' });
      const stderr = Buffer.concat(err).toString('utf8').trim();
      // 値を渡し切れなかったときは、0 で終わっても成功にしない。
      if (p.stdin && (inErr || !p.stdin.writableFinished)) {
        return resolve({ code: code === 0 ? null : code, stdout: '', stderr: stderr || `鍵係へ値を渡せませんでした（${inErr?.code ?? 'incomplete'}）` });
      }
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr });
    });
    p.stdin?.end(input);
  });
}

// helper と getTimeoutMs は試験用に差し替えられる。
export function createKeychain({ helper = helperPath, getTimeoutMs = DEFAULT_GET_TIMEOUT_MS } = {}) {
  const run_ = (args, input, timeoutMs = 0) => run(helper, args, input, timeoutMs);
  return {
    async info(site) {
      const r = await run_(['info', site]);
      if (r.code === 3) return null;
      if (r.code !== 0) throw new Error(`keychain info failed: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    async list() {
      const r = await run_(['list']);
      if (r.code !== 0) throw new Error(`keychain list failed: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    async add(site, { origin, user, password }) {
      const r = await run_(['add', site], JSON.stringify({ origin, user, password }));
      if (r.code !== 0) throw new Error(`登録に失敗: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    async remove(site) {
      const r = await run_(['remove', site]);
      if (r.code !== 0) throw new Error(`削除に失敗: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    // 本人の承認（指紋または Mac のパスワード）を通ったときだけ値を返す。
    async get(site, origin, reason) {
      const r = await run_(['get', site, origin, reason], undefined, getTimeoutMs);
      if (r.timedOut) return { status: 'timeout' };
      if (r.code === 2) return { status: 'denied' };
      if (r.code === 4) return { status: 'origin_mismatch' };
      if (r.code === 3) return { status: 'not_registered' };
      if (r.code === 5) return { status: 'caller_not_allowed', message: r.stderr };
      if (r.code !== 0) return { status: 'error', message: r.stderr };
      const data = JSON.parse(r.stdout);
      return { status: 'ok', origin: data.origin, user: data.user, password: data.password };
    },
    // このプロセスが鍵係から値を受け取れる相手か（作ったときの場所の serve か）。
    async callerCheck() {
      const r = await run_(['check-caller']);
      return r.code === 0 ? JSON.parse(r.stdout) : { ok: false, why: r.stderr };
    },
    async canAuth() {
      const r = await run_(['can-auth']);
      return r.code === 0 ? JSON.parse(r.stdout) : { ok: false, error: r.stderr };
    },
  };
}

export const keychain = createKeychain();
