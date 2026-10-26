# agent-login

[日本語](README.md)

An MCP server for macOS (free) that lets Claude Code or Codex CLI log in to sites while they work in a browser. When the agent reaches a login page, you approve with Touch ID, and this tool types the username and password stored in your macOS Keychain directly into the page.

What it does: after your approval, it fills in the login form of a registered site, so you paste passwords into chats and config files less often.
What it does not do: fully stop an agent that is determined to extract a password (see "Limitations" below).

## Install

Requirements:

- macOS (tested only on one Apple silicon Mac running macOS 26.7)
- Google Chrome in `/Applications`
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js v20 or later with npm (the macOS build from nodejs.org, or one installed with fnm or nvm; the Homebrew build is not supported)

Run this in your own terminal **while no AI agent is running**:

```sh
git clone <this repository's URL> agent-login
cd agent-login
./install.sh
```

It asks for your administrator password once, at the end. What it does:

1. Places the program and its dependencies in `/opt/agent-login` and makes everything owned by root. Agents run with your user rights, so they cannot modify it.
2. Copies the node you are using and re-signs it so debuggers cannot attach (hardened runtime, no get-task-allow).
3. Builds the Keychain helper on your Mac and signs it the same way.
4. Creates a link at `/usr/local/bin/agent-login`. If something else is already there, it stops without changing anything.

Check the result (exit code 0 if nothing FAILs; SKIP lines still give 0):

```sh
sh tests/install-check.sh
```

Register it with your agent. Use the `/opt` path, not the link. If you registered it another way before, remove that first with `claude mcp remove agent-login -s user` / `codex mcp remove agent-login`.

```sh
claude mcp add agent-login -s user -- /opt/agent-login/bin/agent-login serve   # Claude Code
codex mcp add agent-login -- /opt/agent-login/bin/agent-login serve            # Codex CLI
```

Register a site (it asks for the username and password; the password is not shown):

```sh
/opt/agent-login/bin/agent-login check                                      # checks that the approval prompt can be shown
/opt/agent-login/bin/agent-login add github https://github.com/login
```

To update, or after you upgrade node, run `./install.sh` again (the installed copy keeps using the node it copied). Reinstalling rebuilds the Keychain helper, so macOS may ask once for Keychain permission on existing items.

On the author's one Mac, Keychain items registered with the development setup (before installing) could be read by the installed form (approval, password filled, then the two-factor page). This has not been tested elsewhere. If the first login fails, run `agent-login remove <name>` and then `add` again.

### Test install

You can install to any location (an absolute path whose last part is `agent-login`, with no spaces or special characters) without the administrator password and without changing ownership, to try it out. Protection is weaker than a real install.

```sh
AGENT_LOGIN_TEST=1 AGENT_LOGIN_PREFIX=/private/tmp/t/agent-login AGENT_LOGIN_BINDIR=/private/tmp/t/bin ./install.sh
AGENT_LOGIN_TEST=1 sh tests/install-check.sh /private/tmp/t/agent-login
AGENT_LOGIN_TEST=1 AGENT_LOGIN_PREFIX=/private/tmp/t/agent-login AGENT_LOGIN_BINDIR=/private/tmp/t/bin ./uninstall.sh   # removes the test install
```

`AGENT_LOGIN_PREFIX` (install location; must end in `agent-login`) and `AGENT_LOGIN_BINDIR` (link location) also work for a real install. A real install checks that every parent directory is owned by root and not writable by others before installing.

## Uninstall

```sh
/opt/agent-login/bin/agent-login list                # registered sites
/opt/agent-login/bin/agent-login remove <name>       # to delete Keychain passwords too, do this first, one by one
./uninstall.sh                                       # removes /opt/agent-login and the link (asks for the administrator password once)
./uninstall.sh --purge                               # also removes ~/.config/agent-login and ~/.cache/agent-login
claude mcp remove agent-login -s user                # unregister from the agents
codex mcp remove agent-login
```

`uninstall.sh` shows the site list and waits for you to type `yes` before deleting. It refuses to delete a location that does not look like an agent-login install.

Run `--purge` only after quitting every Claude Code and Codex session that uses agent-login (while they run, the browser keeps writing to that folder). If you removed the tool before deleting the Keychain passwords, install it again and then run `remove`.

## Usage

In Claude Code or Codex, ask something like "log in to github and do X". The agent opens the login page with `browser_navigate` and calls `login`. A macOS approval prompt appears; read it and approve with Touch ID (or your password).

If you use Claude Code and Codex at the same time, two servers run. A browser profile can be used by only one browser at a time, so the server started later uses `~/.cache/agent-login/profile-2` (then -3 … -5). Login state (cookies) is separate for each profile.

`~/.cache/agent-login` keeps page copies, screenshots and logs from after login (`output/`) and the browser's login state. Each start sets it to owner-only (700). `./uninstall.sh --purge` removes it when you no longer need it. `output/` is not cleaned up automatically. `remove` does not clear that site's login state (cookies). Screenshots or page copies that the AI saves under a file name it chooses go to the AI's working folder instead, and `--purge` does not remove them.

Other commands: `agent-login list` (registered sites), `agent-login remove <name>` (delete), `serve --headless`. `serve --executable-path <path to Chrome>` also works, but in that mode the Keychain helper does not hand over passwords (login is unavailable).

### Importing from a password manager

Export your passwords as CSV from your password manager, then run this in your own terminal (it only runs when typed directly in a terminal; piped input is refused):

```sh
agent-login import ~/Downloads/passwords.csv
```

It lists the importable entries without showing any password, then asks which numbers to register (e.g. `1,3,5-7`, `all`, or empty to cancel) and asks for `yes` before writing. Only https logins are taken; app entries, http, empty passwords, duplicates and HTTP-auth entries are skipped, and existing names are never overwritten (a new name gets `-2`). One-time codes (TOTP) and notes in the CSV are not imported. Register only the sites you want the AI to use. The CSV contains every password in plain text, so delete it (and $1
The tests cover the Chrome, Firefox and Bitwarden export layouts. Other CSVs are read if the header row has a `url` (or `login_uri`) column and a `password` column.

### Sites where the form fields are not found automatically

Write CSS selectors in `~/.config/agent-login/sites.json` (all optional):

```json
{
  "github": { "username": "#login_field", "password": "#password", "submit": "input[type=submit]" }
}
```

## How it works

- Playwright MCP (0.0.83) is embedded, so its browser tools work as usual. Two tools are added: `login` and `login_sites`.
- When `login(site, reason)` is called:
  1. It checks that exactly one tab is open, the page is https, there is exactly one password field, and the page's origin (the `https://host` part) matches the origin of the registered URL.
  2. It shows the macOS approval prompt (Touch ID or password). If you deny, the password is never loaded, not even into this tool.
  3. After approval it checks again that the page did not change while waiting.
  4. It fills in the username and password and submits, then clears the password field whether or not the login succeeded.
  5. It returns only the outcome (submitted / denied / reason) to the agent, never the values.
- Responses to the agent and files written by the browser tools are masked. Passwords re-encoded as JSON, URL or HTML are masked too.
- The tool that runs arbitrary code (`browser_run_code_unsafe`) is disabled.
- The Keychain helper reads a value only when called by the server started in the expected way. A server started with options that load other code is refused before the approval prompt appears. Running the helper directly does not show the approval prompt.
- The server ignores SIGUSR1, the signal that attaches an inspector.
- URLs the AI opens with `browser_navigate` or `browser_tabs` must be http, https or about:blank (javascript:, data:, file: and so on are refused). Links and redirects inside a page are outside this check.
- Once `browser_evaluate` has run code on an origin, `login` refuses that origin for as long as the server runs. After such code runs, the origin's Service Workers and cache are cleared.
- `login` refuses tabs opened by another page (the opener can modify their content).
- `login_sites` returns the site list plus whether the Keychain helper will hand over values for this server (`login_ready`). If not, it also returns the reason, so you know before any approval prompt appears.
- The launcher of the installed form (`install.sh`) clears the environment and starts the program with the copied, re-signed node.

## Development setup

Runs directly from this folder. The code stays owned by you, so the installed form's protections (root ownership, signing that refuses debuggers) are not present. Use it for testing and development.

```sh
npm install
npm run build-helper                      # builds the Keychain helper in ./build
npm test
node bin/agent-login.mjs check
claude mcp add -s user agent-login -- "$(command -v node)" "$PWD/bin/agent-login.mjs" serve
```

With fnm or nvm, `command -v node` may point to a temporary location. In that case use the fixed path of the default version (for fnm, `~/.local/share/fnm/aliases/default/bin/node`). If you move this folder, rebuild with `npm run build-helper` (the helper remembers the server's location).

## Tests

`npm test` uses a synthetic password (random each run) against a local test site and checks the following (72 tests):

- Controls: with masking turned off, the plaintext is found in snapshots, field values, console, network bodies, console log files and saved snapshot files (proves the detector works).
- Real runs: for a plain form, a JS-submitted form, a page that copies the value, and concurrent tool calls, zero plaintext in agent responses and files.
- Refusals: nothing is filled in on denial, URL mismatch, iframe, two password fields, invalid field selectors, two tabs, http, or a page change during approval.
- Origins where code was run and tabs opened by another page are refused; the controls (another origin, a tab you opened) pass. javascript:, data:, file: and similar URLs are not opened.
- `login_sites` returns `login_ready: false` and a reason when the helper would refuse the server.
- With two servers on the same profile, the later one opens its browser in another profile, can log in, and leaves no plaintext there either.
- The data folder (`~/.cache/agent-login`) is set to owner-only (700), and anything created in it later is owner-only too.
- `import` reads Chrome, Firefox and Bitwarden CSV layouts (quotes, commas and line breaks inside fields, CRLF, BOM), skips what it should, keeps generated names within what `login` accepts, registers only the chosen numbers after `yes`, and never prints a password, even in error messages. These tests use a fake Keychain.

These tests use a test helper, not the real Keychain helper. The real helper and Touch ID approval are checked by hand.

`tests/install-check.sh` checks the installed copy: root ownership (including parent directories), that other users can read and run it, intact signatures, hardened runtime, no entitlements that allow debuggers or outside libraries, that a debugger cannot attach to a running node (confirmed by the reason in the macOS log), and that the server passes the Keychain helper's check at startup.

Checked by hand:

- The Keychain helper's caller check, using server startup records with different launch forms.
- With Codex CLI 0.163.0, the registered launch passes the check (`login_ready: true`), and it can open a browser while the Claude Code server is running.
- A real Touch ID–approved login succeeded on GitHub from Claude Code with the development setup on 2026-10-23 (username and password submitted, then the two-factor page). On 2026-10-24 it also succeeded with the installed form (Touch ID, the keychain access prompt, autofill, then the passkey in the agent-login browser window). Not yet done from Codex.
- `import` writing to the real Keychain has not been tried by hand yet.

## Limitations

- Agents run with your user rights, so this tool makes extracting a password harder but cannot fully prevent it.
- The path that passes the password from the Keychain helper to the server is not fully protected from processes running with your user rights, and it has not been redesigned yet.
- Extra node launch flags are not applied because they conflict with the Keychain helper's caller check.
- Chrome itself, the site settings (`sites.json`) and the browser profile data stay owned by you, not by root.
- macOS permissions you already granted to other apps or tools (such as screen control) are not restricted by this tool.
- The install is assembled in a temporary folder you own, so it assumes no agent is running while you install.
- The development setup lacks the installed form's protections (root ownership, signing that refuses debuggers).
- The reason text in the approval prompt is written by the agent and may not be true.
- Two-factor steps (codes, passkeys) are done by you. When the login reaches a two-factor page, the agent-login browser window is brought to the front (macOS, non-headless).
- If the Touch ID or keychain prompt is not approved within 4 minutes, the request is cancelled and `timeout` is returned. A prompt left on screen can be dismissed; approving it does nothing.
- After the Keychain helper is rebuilt (reinstall), the next approval shows a keychain access prompt. Choosing "Always Allow" stops it from appearing again.
- Only the top-level page of a single tab is handled; login fields inside iframes are not filled.
- Masking of files written by the browser tools does not cover every way of writing; it is supplemented by cleanup after each tool call.
- The Keychain items themselves carry no Touch ID requirement; the Touch ID approval is shown by this tool.
- There is no paid Apple signing; signing is done locally on the Mac you install on.

## License

Apache-2.0
