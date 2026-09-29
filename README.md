# Local LLM Proxy

Turns subscription accounts into OpenAI-compatible HTTP APIs, plus a router that
picks between them. Honcho and WeKnora are consumers; neither packages nor manages
these services.

## Read this first (for agents)

One of three repositories in the memory system.

| Repository | What it is | Installed where |
|---|---|---|
| [`honcho-selfhost`](https://github.com/team-memory-system/honcho-selfhost) | The memory server, a fork of `plastic-labs/honcho` (AGPL-3.0) | One computer per person |
| [`honcho-agent-bridge`](https://github.com/team-memory-system/honcho-agent-bridge) | Collector, installer, agent plugin | Every machine that runs an agent |
| **`subscription-gateway`** (this one) | Subscription-to-API adapters and a router | Only the computer that runs Honcho |

### Why these cannot move into Docker

This keeps coming up, so: they are on the host because they reach host-only things.

| Service | Host dependency |
|---|---|
| `codex-openai-proxy` | Reads `~/.codex/auth.json` **and writes the rotated refresh token back to it** |
| `claude-print-proxy` | `spawn`s the host's `claude` CLI, with that user's login |
| `router` | None — this one could be containerised, but then it would be calling two host processes anyway |

### Who starts them

Three things can, and they are separate:

- `proxyctl.py` — macOS LaunchAgents, `subscription-gateway.*`. This is what runs
  on the owner's machine today. It preserves an existing plist's OAuth source and
  shared keys, and never copies credentials into this repository.
- `honcho-agent-bridge`'s `scripts/host-manager.mjs` — cross-platform, spawns a
  supervisor detached that keeps all three alive. It needs `llmProxyRoot` in its host
  profile to point at this checkout. It registers nothing with the OS, so nothing
  restarts them after a reboot.
- `ui/server.mjs` — the gateway's own screen (`npm run ui`, http://127.0.0.1:11450).
  It keeps its own logins and ports under the app directory and starts one adapter
  per account plus the router (11400). When it starts, it connects whatever is
  logged in; every 30 seconds it starts again any of those that stopped (one
  stopped from the screen stays down until the next connect).
  `node gateway/cli.mjs install` registers it to start at login on macOS, Windows
  and Linux, so all of it comes up by itself; on macOS that is the same LaunchAgent
  `python3 proxyctl.py install ui` writes (`subscription-gateway.ui`). See
  [Command line](#command-line).

Do not let two of them manage the same service at once. `proxyctl.py` refuses to
install `ui` next to its own `router`, since both run a router on 11400, and so does
`gateway/cli.mjs install`; `all` means the single-account three, not `ui`.

### Installing it from another program

`gateway/cli.mjs` is the interface for installers (honcho-agent-bridge's included):
`install`, `uninstall`, `status`, `connect-info`, `open`, each printing one JSON
object. It needs only Node. `connect-info` prints the router's client key, and is
the only command that prints a secret.

To replace a checkout, run the old copy's `uninstall`, swap the folders, then run
the new copy's `install`. `uninstall` leaves nothing of the old folder running
(on Windows a running process keeps its folder from being renamed), and the new
screen connects every account that is logged in, from the logins and
`accounts.json` that `uninstall` kept.

### Several accounts per subscription

The screen holds any number of Codex and Claude logins. Each account is written to
`accounts.json` in the app directory, gets its own CLI config directory
(`auth/<backend>/<id>/`), and runs its own adapter on a port chosen once, from
`GATEWAY_ADAPTER_PORT_BASE` (default 11460). The router receives every logged-in
account as a separate backend, in the file's order, plus a `routing.mode`:

- `drain` — use the first account until it hits its limit, then the next.
- `balance` — send each request to the account used least in the last five hours.

An adapter reports an exhausted account as `429` with
`{"error":{"type":"usage_limit_reached",...}}` and, when it knows, `retry-after`.
The router then rests that account until the reset and sends the same request to
the next one. Those rests live in the router's memory: every reconnect, mode change
or reorder restarts the router and forgets them.

Put in only the operator's own accounts. OpenAI's terms say "You may not share your
account credentials or make your account available to anyone else", and Anthropic's
consumer terms say the same.

### Things that will bite you

- **A shared secret has to match on both sides.** Each service reads its own
  (`CODEX_PROXY_SHARED_SECRET`, `CLAUDE_PROXY_SHARED_SECRET`); Honcho presents the
  Codex one as `LLM_VLLM_API_KEY`. If they disagree the call fails with 401 and
  nothing explains why. Nothing invents a key for a service it does not manage.
- **`router/config.json` is not in the repository.** `config.example.json` is the
  template; the real one names backends and which env var holds each key.
- **Only `codex-openai-proxy` has dependencies** (`@mariozechner/pi-ai`). The other
  two run from a bare Node. Its `package-lock.json` (what `npm ci` and
  `cli.mjs install` use) and `pnpm-lock.yaml` pin the same 168 packages at the same
  versions; change both together.
- **The owner's LaunchAgents run these files from this checkout.** An edit to an
  adapter reaches the live Honcho path (11435, 11446) the next time that
  LaunchAgent restarts, committed or not.
- **A failed upstream request is a status code, not an empty stream.** The Codex
  adapter starts an SSE response only after pi-ai's first event, so a usage limit
  answers `429` and any other upstream failure `502` before a byte is streamed.
- **The Codex model list is the login's, not pi-ai's.** `GET /v1/models` on the
  Codex adapter asks `https://chatgpt.com/backend-api/codex/models` (what the Codex
  CLI's picker uses) and lists the `visibility: "list"` models, refreshed every 10
  minutes. pi-ai's built-in catalog was out of date: nine of its ten ids were
  refused for a ChatGPT login. The backend hides models newer than the
  `client_version` asked with, so the adapter asks as `9999.0.0`
  (`CODEX_MODELS_CLIENT_VERSION`).
- **`codex login status` answers on stderr**, with exit 0 when logged in and exit 1
  when not. Reading only stdout makes every login look missing.
- **On Windows, `codex` and `claude` are npm `.cmd` shims.** `spawn("codex")` fails
  there (spawn looks only for `.exe` and `.com`), and Node refuses to start a `.cmd`
  without a shell. Every spawn of either CLI goes through `gateway/command.mjs`,
  which finds the command on PATH with PATHEXT and runs what the shim runs: a
  JavaScript entry under this Node, a native `.exe` directly. Only a batch file it
  cannot read goes through `cmd.exe /d /s /c`, with every argument escaped. On
  macOS and Linux it hands spawn the command exactly as before.
- **On Windows no request text goes on a command line.** The Claude adapter's
  prompt is stdin everywhere; on Windows the system prompt goes through a private
  file (`--system-prompt-file`, removed after the run) instead of
  `--system-prompt`. `--json-schema` has no file form and stays on the command
  line, which reaches `claude.exe` directly and never `cmd.exe`: the adapter
  refuses a `CLAUDE_BIN` that only `cmd.exe` could run.

### Verify a change

```sh
npm test                                               # all of the below
cd codex-openai-proxy && node --test server.test.mjs   # 23
cd claude-print-proxy && node --test server.test.mjs   # 60
cd router            && node --test server.test.mjs    # 42
cd ui                && node --test server.test.mjs    # 13
node --test gateway/command.test.mjs                   # 7
node --test gateway/cli.test.mjs                       # 18 (3 skip on a Windows host)
python3 -m unittest test_proxyctl.py                   # 5
```

`gateway/cli.test.mjs` never reaches launchctl, `reg.exe` or systemctl, and the
real processes it starts use their own directory and free ports.

### Licence

AGPL-3.0, retained from the extraction out of the Honcho fork. See `ORIGIN.txt`.

---

## Detail

| Service | Port | Backend |
|---|---|---|
| Codex | 11435 | pi-ai with Codex OAuth |
| Claude | 11446 | Claude Code print mode |
| Router | 11400 | Dispatch by request `model` to Codex, Claude and Ollama |
| Screen | 11450 | Logins, accounts, and the router and adapters it keeps running (11460 and up) |

## Command line

`gateway/cli.mjs`, for people and for installers:

```sh
node gateway/cli.mjs install        # dependencies, keys, autostart, started now
node gateway/cli.mjs status
node gateway/cli.mjs connect-info   # prints the router key: never log this output
node gateway/cli.mjs open
node gateway/cli.mjs uninstall
```

Every command prints exactly one JSON object, on one line, on stdout and exits 0.
A failure prints `{"ok":false,"error":"..."}` and exits 1 (2 for a usage error).
Diagnostics, if any, go to stderr.

| Command | Output |
|---|---|
| `install` | `{"ok":true,"autostart":"launchd","uiUrl":"http://127.0.0.1:11450","routerUrl":"http://127.0.0.1:11400/v1"}` — `autostart` is `launchd`, `windows-run` or `systemd` |
| `uninstall` | `{"ok":true,"stopped":["router","codex-1","claude-1"]}` — the services it stopped |
| `status` | `{"ok":true,"ui":{"url":"http://127.0.0.1:11450","ok":true},"router":{"url":"http://127.0.0.1:11400/v1","ok":true},"autostart":{"kind":"launchd","installed":true},"accounts":[{"id":"codex-1","backend":"codex","loggedIn":true,"serving":true}],"models":["gpt-5.5"]}` |
| `connect-info` | `{"ok":true,"ready":true,"baseUrl":"http://127.0.0.1:11400/v1","apiKey":"<router key>","models":["gpt-5.5"]}`, plus `"reason":"..."` when `ready` is false |
| `open` | `{"ok":true,"url":"http://127.0.0.1:11450"}` |

- **`install`** runs `npm ci --omit=dev --no-audit --no-fund` in each service
  folder whose dependencies are missing (today only `codex-openai-proxy`; `npm.cmd`
  on Windows), creates the app directory and `secrets.json` (keys that exist are
  kept), registers the autostart below, starts the screen through it and waits up
  to 30 seconds for `GET /health`. It is idempotent: a second run changes nothing
  that is already right and does not restart a screen that runs as registered.
  What cannot work at all (no `systemctl --user`, proxyctl's own
  `subscription-gateway.router` installed) fails before anything is downloaded. A
  screen that does not answer in time leaves the autostart registered, and the
  error names the log to read.
- **`uninstall`** removes the autostart and stops the screen it runs (on Windows,
  with its supervisor), then the router and every account's adapter the screen
  started, in that order: the screen's keeper would start again what is stopped
  under it. `stopped` names them. Logins, `accounts.json`, the keys and the router
  config stay, so the next `install` connects the same accounts again. Each
  service is stopped by its pid file, and only if it answers on its port: after a
  restart the number in a pid file can belong to another program, so a pid whose
  service does not answer is not signalled (its pid file is dropped), and a
  service something else started is left alone. A service that will not stop
  makes `uninstall` fail with its name.
- **`status`** is the screen's own `/api/status` when the screen answers, and
  otherwise the same report made in the CLI, which creates no keys. `router.ok`
  means the router answers `/health`; `serving` means the router routes to that
  account.
- **`connect-info`** is the only command that prints a secret: `apiKey`, the
  router's client key, sent as `Authorization: Bearer`. Whatever runs it must not
  log that output, show it, or pass the key on a command line. `ready` is true
  only when the router just listed at least one model for that key. It creates the
  keys if there are none yet.
- **`open`** tries `open`, `rundll32 url.dll,FileProtocolHandler` or `xdg-open`
  and does not report whether a browser appeared.

The same overrides apply as everywhere else: `GATEWAY_HOME`, `GATEWAY_UI_PORT`,
`GATEWAY_ROUTER_PORT`, `GATEWAY_ADAPTER_PORT_BASE`, and on macOS proxyctl's
`GATEWAY_LAUNCHD_PREFIX` and `GATEWAY_STATE_DIR`. `install` writes the gateway
variables it was run with (`GATEWAY_HOME`, `GATEWAY_USER_HOME`, the two ports,
`GATEWAY_OLLAMA_BASE_URL`, `CODEX_BIN`, `CLAUDE_BIN`) into the autostart, so the
screen started at login uses the same directory and ports. Nothing else of the
installing shell's environment is copied.

| OS | `autostart` | What is registered |
|---|---|---|
| macOS | `launchd` | `~/Library/LaunchAgents/subscription-gateway.ui.plist`, byte for byte what `proxyctl.py install ui` writes (a test runs proxyctl.py and compares): RunAtLoad, KeepAlive, `PATH` from where node, codex and claude are plus the system folders, logs in `~/.local/share/subscription-gateway/logs/` |
| Windows | `windows-run` | the value `SubscriptionGateway` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which runs `wscript.exe //B //NoLogo <app>\autostart\ui.vbs`; see [Windows](#windows) |
| Linux | `systemd` | `~/.config/systemd/user/subscription-gateway-ui.service` with `Restart=always` and `KillMode=process` (the router and adapters outlive a restart of the screen). Needs a working `systemctl --user`; `loginctl enable-linger` makes it start without a login session |

None of them needs admin rights.

## Windows

The app directory is `%LOCALAPPDATA%\SubscriptionGateway`. Nothing on Windows
registers a per-user program without admin rights and restarts it when it exits,
so the autostart is three parts:

1. The HKCU Run value, which Windows runs at logon with the user's own rights.
2. `<app>\autostart\ui.vbs`, run by `wscript` so that no console window opens. It
   sets the screen's variables and starts `gateway/supervise.mjs` hidden.
3. `gateway/supervise.mjs`, which does what KeepAlive does on macOS: it runs
   `ui/server.mjs` and starts it again when it exits — after 1 second if it ran for
   a minute or more, otherwise after 2, 4, 8 … up to 60 seconds. One supervisor
   runs per app directory, the one holding the pipe
   `\\.\pipe\subscription-gateway-ui-<hash>`; `install` and `uninstall` ask it
   over that pipe whether it runs and tell it to stop. Its log is
   `<app>\logs\ui-supervisor.log`, the screen's `<app>\logs\ui.log`.

`install` starts the same chain right away. Things to know:

- The entry shows up among the startup apps in Task Manager and Settings. Turning
  it off there is respected: `install` does not turn it back on, and `uninstall`
  clears that choice along with the entry.
- VBScript is still installed by default on Windows 11, but Microsoft plans to
  turn it off by default in a later release. Without it the Run value does nothing:
  `install` then times out and `ui-supervisor.log` is never written.
- The screen, the supervisor, the router and the adapters run with folders of
  the checkout as their working directories, which on Windows keeps the checkout
  from being renamed or deleted while they run. `uninstall` stops all of them. A
  screen started by hand (`npm run ui`) is not the autostart's and keeps running,
  and its keeper starts the rest again.
- Logging in from the screen shares the screen's hidden console rather than
  running detached, so no console window opens; a login still waiting for the
  browser ends if the screen exits.

## Manage on macOS

Requires Node.js, Python 3, and authenticated Codex/Claude installations.

```sh
cd codex-openai-proxy
pnpm install --frozen-lockfile
cd ..
npm test
python3 proxyctl.py install
python3 proxyctl.py status
python3 proxyctl.py restart claude
python3 proxyctl.py logs codex
python3 proxyctl.py stop claude
python3 proxyctl.py start claude
```

For several accounts per subscription, install the screen instead of `router`:

```sh
node gateway/cli.mjs install        # the same LaunchAgent, plus dependencies and keys
python3 proxyctl.py install ui      # or: LaunchAgent subscription-gateway.ui on 11450
python3 proxyctl.py status ui
python3 proxyctl.py logs ui         # the screen; each service logs under the app directory
```

Its plist gets `PATH` from where `node`, `codex` and `claude` are, plus the system
folders, rather than the installing shell's `PATH`.

Installation migrates existing LaunchAgents while retaining their environment
and shared keys. Labels: `subscription-gateway.codex` and
`subscription-gateway.claude`. Configuration lives in `~/Library/LaunchAgents/`;
logs and migration backups live in `~/.local/share/subscription-gateway/`.
Credentials, installed plists, and backups must never enter a release archive.
Fresh installations bind to loopback only. Configure shared client keys using
`CODEX_PROXY_SHARED_SECRET` and `CLAUDE_PROXY_SHARED_SECRET` in the installed
LaunchAgent environment, then run `proxyctl.py install` to reload it.

## Consumers

- Host: `http://127.0.0.1:11435/v1`, `http://127.0.0.1:11446/v1`.
- One endpoint for all of them: `http://127.0.0.1:11400/v1` selects the backend
  from the request's `model` field and forwards the body unchanged. See
  `router/README.md`.
- Docker: replace `127.0.0.1` with `host.docker.internal`.
- WeKnora's application-specific model/effort and OCR router remains in ubionRAG
  on port 18086 and consumes the Codex endpoint.
- Honcho packaging no longer bundles these sources or owns these services by
  default. Supply the independently configured endpoint and existing client key.

Claude accepts Opus 5.5 and 5, Sonnet 5.5 and 5, Fable 5.1 and 5, and Haiku 4.5
by id (`claude-print-proxy/README.md` lists them). An omitted model or `opus`
selects the default, `claude-opus-5-5`; `CLAUDE_PROXY_MODEL` overrides that
default. `GET /v1/models` returns the supported IDs. Effort remains a
separate `reasoning_effort` parameter (default low).

## Authentication boundary

This extraction separates code, distribution, processes, and logs. Codex still
uses its existing `~/.codex/auth.json`; Claude still uses its existing CLI login.
The launch environment can configure `CODEX_AUTH_PATH` or `CLAUDE_CONFIG_DIR`.
A dedicated application OAuth login UI and independent account enrollment are
not implemented. Existing OAuth credentials were not copied or reissued.

## Provenance

Extracted on 2026-09-23 from the Honcho checkout's `codex-openai-proxy/` and
`claude-print-proxy/`. The original LICENSE is preserved. Source revision is
recorded in ORIGIN.txt. Original sources and installed plist backups are retained
outside the repository under `~/.local/share/subscription-gateway/backups/`.
