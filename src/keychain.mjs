// 鍵係（helper/agent-login-helper）を呼ぶ。パスワードはこのプロセスの中だけを通り、標準出力やログには出さない。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const helperPath = fileURLToPath(new URL('../build/agent-login-helper', import.meta.url));

function run(args, input) {
  return new Promise((resolve, reject) => {
    if (!existsSync(helperPath)) return reject(new Error('鍵係が未作成です。npm run build-helper を実行してください'));
    const p = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8').trim() }));
    p.stdin.end(input ?? '');
  });
}

export const keychain = {
  async info(site) {
    const r = await run(['info', site]);
    if (r.code === 3) return null;
    if (r.code !== 0) throw new Error(`keychain info failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  },
  async list() {
    const r = await run(['list']);
    if (r.code !== 0) throw new Error(`keychain list failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  },
  async add(site, { origin, user, password }) {
    const r = await run(['add', site], JSON.stringify({ origin, user, password }));
    if (r.code !== 0) throw new Error(`登録に失敗: ${r.stderr}`);
    return JSON.parse(r.stdout);
  },
  async remove(site) {
    const r = await run(['remove', site]);
    if (r.code !== 0) throw new Error(`削除に失敗: ${r.stderr}`);
    return JSON.parse(r.stdout);
  },
  // 本人の承認（指紋または Mac のパスワード）を通ったときだけ値を返す。
  async get(site, origin, reason) {
    const r = await run(['get', site, origin, reason]);
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
    const r = await run(['check-caller']);
    return r.code === 0 ? JSON.parse(r.stdout) : { ok: false, why: r.stderr };
  },
  async canAuth() {
    const r = await run(['can-auth']);
    return r.code === 0 ? JSON.parse(r.stdout) : { ok: false, error: r.stderr };
  },
};
