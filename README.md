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

Do not let both manage the same service at once.

### Things that will bite you

- **A shared secret has to match on both sides.** Each service reads its own
  (`CODEX_PROXY_SHARED_SECRET`, `CLAUDE_PROXY_SHARED_SECRET`); Honcho presents the
  Codex one as `LLM_VLLM_API_KEY`. If they disagree the call fails with 401 and
  nothing explains why. Nothing invents a key for a service it does not manage.
- **`router/config.json` is not in the repository.** `config.example.json` is the
  template; the real one names backends and which env var holds each key.
- **Only `codex-openai-proxy` has dependencies** (`@mariozechner/pi-ai`). The other
  two run from a bare Node.

### Verify a change

```sh
cd codex-openai-proxy && node --test server.test.mjs   # 11
cd claude-print-proxy && node --test server.test.mjs   # 47
cd router            && node --test server.test.mjs    # 18
python3 -m pytest test_proxyctl.py -q                  # 2
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

Claude accepts `claude-opus-5` and `claude-opus-5-5` explicitly. An omitted model
or `opus` selects the default, `claude-opus-5-5`; `CLAUDE_PROXY_MODEL` overrides
that default. `GET /v1/models` returns the supported IDs. Effort remains a
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
