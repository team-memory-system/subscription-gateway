# Local LLM Proxy

Independent source, dependencies, lifecycle, and logs for the local Codex and
Claude OpenAI-compatible services. Honcho and WeKnora consume HTTP endpoints.

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
and shared keys. Labels: `com.chenjing.llm-proxy.codex` and
`com.chenjing.llm-proxy.claude`. Configuration lives in `~/Library/LaunchAgents/`;
logs and migration backups live in `~/.local/share/llm-proxy/`.
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
outside the repository under `~/.local/share/llm-proxy/backups/`.
