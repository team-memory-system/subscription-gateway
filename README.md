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

Two things can, and they are separate:

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
  stopped from the screen stays down until the next connect). On macOS,
  `python3 proxyctl.py install ui` makes it a LaunchAgent (`subscription-gateway.ui`),
  so all of it comes up at login.

Do not let two of them manage the same service at once. `proxyctl.py` refuses to
install `ui` next to its own `router`, since both run a router on 11400, and
`all` means the single-account three, not `ui`.

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
  two run from a bare Node.
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

### Verify a change

```sh
npm test                                               # all of the below
cd codex-openai-proxy && node --test server.test.mjs   # 23
cd claude-print-proxy && node --test server.test.mjs   # 56
cd router            && node --test server.test.mjs    # 42
cd ui                && node --test server.test.mjs    # 13
python3 -m unittest test_proxyctl.py                   # 5
```

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
python3 proxyctl.py install ui      # LaunchAgent subscription-gateway.ui on 11450
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
