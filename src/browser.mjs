// ブラウザはこの道具が起動し、Playwright MCP には同じ画面を渡す。外部から繋ぐ口は開かない。
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// ブラウザ自身にパスワードを保存させない（自動操作用のブラウザは保存の鍵が弱い）。
function disablePasswordSaving(profileDir) {
  const dir = join(profileDir, 'Default');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'Preferences');
  let prefs = {};
  if (existsSync(file)) {
    try { prefs = JSON.parse(readFileSync(file, 'utf8')); } catch { prefs = {}; }
  }
  prefs.credentials_enable_service = false;
  prefs.profile = { ...(prefs.profile ?? {}), password_manager_enabled: false };
  prefs.autofill = { ...(prefs.autofill ?? {}), profile_enabled: false, credit_card_enabled: false };
  writeFileSync(file, JSON.stringify(prefs));
}

// Chrome は使っている置き場に SingletonLock（「機械名-番号」へのリンク）を置く。その番号のプロセスが生きていれば使用中。
function profileInUse(dir) {
  let target;
  try { target = readlinkSync(join(dir, 'SingletonLock')); } catch { return false; }
  const pid = Number(target.split('-').pop());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 置き場は1つのブラウザしか使えない。Claude Code と Codex など同時に動かすと、後の方は <置き場>-2, -3 … を使う。
const MAX_PROFILES = 5;

export function createBrowser({ profileDir, headless = false, channel = 'chrome', executablePath } = {}) {
  let current = null;
  const launch = async () => {
    if (profileDir) {
      for (let i = 1; i <= MAX_PROFILES; i++) {
        const dir = i === 1 ? profileDir : `${profileDir}-${i}`;
        if (profileInUse(dir)) continue;
        disablePasswordSaving(dir);
        try {
          return await chromium.launchPersistentContext(dir, {
            headless, channel: executablePath ? undefined : channel, executablePath, viewport: null,
            args: ['--disable-features=PasswordManagerOnboarding,AutofillServerCommunication'],
          });
        } catch (e) {
          if (profileInUse(dir)) continue; // 同時に起動した別のサーバーに先を越された
          throw e;
        }
      }
      throw new Error(`All ${MAX_PROFILES} browser profiles of agent-login are in use. Close other AI sessions that use agent-login.`);
    }
    const browser = await chromium.launch({ headless, channel: executablePath ? undefined : channel, executablePath });
    const context = await browser.newContext();
    context.on('close', () => browser.close().catch(() => {}));
    return context;
  };
  return {
    // Playwright MCP が呼ぶ。閉じられていたら起動し直す。
    async getContext() {
      if (current) {
        const c = await current.catch(() => null);
        if (c && !c.__closed) return c;
      }
      current = launch().then((c) => {
        c.on('close', () => { c.__closed = true; });
        return c;
      });
      return current;
    },
    // ログインは起動済みのブラウザにだけ行う。
    async peekContext() {
      if (!current) return null;
      const c = await current.catch(() => null);
      return c && !c.__closed ? c : null;
    },
    async close() {
      const c = await this.peekContext();
      if (c) await c.close().catch(() => {});
    },
  };
}
