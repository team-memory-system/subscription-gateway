# Router

One OpenAI-compatible endpoint in front of the local backends. The `model`
field in the request body picks the backend; the request is then forwarded
unchanged. Nothing about a request is interpreted beyond reading `model`.

| Backend | Default base URL | Models |
|---|---|---|
| codex | `http://127.0.0.1:11435/v1` | from config (it has no `/v1/models`) |
| claude | `http://127.0.0.1:11446/v1` | from config, plus `/v1/models` discovery |
| ollama | `http://127.0.0.1:11434/v1` | `/v1/models` discovery (embeddings and local chat) |

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/health` | Router status plus one entry per backend (reachability, HTTP status, latency). Public, always `status: "ok"` if the router itself is up, and never waits longer than `probeTimeoutMs` on a dead backend. |
| GET | `/v1/models` | Merged `{object:"list", data:[{id, object, owned_by}]}`. `owned_by` is the backend name. Cached for `modelsTtlMs`. A backend that is down keeps its last good list and otherwise contributes nothing; it never fails the listing. |
| POST | `/v1/chat/completions` | Dispatch by `model`, forward, relay the response. |
| POST | `/v1/embeddings` | Same dispatch. |

An unknown model is a `404` with an OpenAI-shaped body naming the model and
listing the available ids; a request with no `model` is a `400`. Upstream status
codes and error bodies are relayed as they arrive — the backends do not agree on
an error shape (codex answers `{"error": "text"}`, claude
`{"error": {"message", "type"}}`), and the router does not normalize them.

Model ids are matched exactly first, then with a legacy WeKnora display suffix
stripped (`claude-opus-5-5 [low] vision`), then with ollama's `:latest` tag
added or removed. Only the lookup key is rewritten; the body is not.

## Run

```sh
node server.mjs                      # uses config.json, else config.example.json
ROUTER_CONFIG=/path/to/config.json node server.mjs
python3 ../proxyctl.py install router   # LaunchAgent on port 11400
python3 ../proxyctl.py status router
python3 ../proxyctl.py logs router
node --test server.test.mjs
```

`proxyctl` injects `HOST` and `PORT` into the LaunchAgent environment, and both
override `listen` in the config file.

A backend that requires a key needs that key in the router's own environment,
which a fresh install does not provide. Add the variables named by the
backends' `apiKeyEnv` (`CODEX_PROXY_SHARED_SECRET`, `CLAUDE_PROXY_SHARED_SECRET`)
to `EnvironmentVariables` in
`~/Library/LaunchAgents/com.chenjing.llm-proxy.router.plist` and re-run
`python3 ../proxyctl.py install router`; the install preserves the environment
it finds. Without them the router forwards unauthenticated and the backend
answers 401.

## Configuration

The config file holds no secrets. A backend's token, if it needs one, is named
by `apiKeyEnv` and read from the environment at request time; an inline
`apiKey`/`token`/`secret` key makes startup fail.

```json
{
  "listen": { "host": "127.0.0.1", "port": 11400 },
  "backends": [
    { "name": "codex",  "baseUrl": "http://127.0.0.1:11435/v1", "models": ["gpt-6-luna"] },
    { "name": "claude", "baseUrl": "http://127.0.0.1:11446/v1", "discoverModels": true },
    { "name": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "discoverModels": true }
  ]
}
```

Per backend: `name`, `baseUrl` (including `/v1`), `models` (ids that always
route and are always listed), `discoverModels` (also ask `GET {baseUrl}/models`,
unioned with `models`), `aliases` (ids that route but are not advertised, e.g.
claude's `opus`), `apiKeyEnv` (environment variable holding that backend's
bearer token, used for both discovery and forwarding).

`config.example.json` gives claude both a static list and `discoverModels`
because its `/v1/models` is behind `CLAUDE_PROXY_SHARED_SECRET`: if the router's
environment lacks that key, discovery 401s and the static list keeps the models
routable.

| Key | Env override | Default | Purpose |
|---|---|---|---|
| `listen.host` | `HOST` | `127.0.0.1` | Loopback only unless a client token is set |
| `listen.port` | `PORT` | `11400` | |
| `upstreamTimeoutMs` | `ROUTER_UPSTREAM_TIMEOUT_MS` | `900000` | Upstream inactivity guard; these backends spawn CLIs and can take minutes |
| `probeTimeoutMs` | `ROUTER_PROBE_TIMEOUT_MS` | `750` | `/health` probe deadline (proxyctl polls with a 1s timeout) |
| `discoverTimeoutMs` | `ROUTER_DISCOVER_TIMEOUT_MS` | `3000` | `/v1/models` discovery deadline |
| `modelsTtlMs` | `ROUTER_MODELS_TTL_MS` | `30000` | Model list cache |
| `maxBodyBytes` | `ROUTER_MAX_BODY_BYTES` | `8388608` | Request size limit |
| `clientAuthEnv` | — | `ROUTER_PROXY_SHARED_SECRET` | Name of the env var holding the client token |
| — | `ROUTER_CONFIG` | `./config.json` | Config file path |
| — | `ROUTER_REQUEST_LOG` | `1` | `0` silences the request log |

Client authentication is optional: with `ROUTER_PROXY_SHARED_SECRET` set, every
`/v1/*` request needs that bearer token (`/health` stays public); with it unset,
every request is accepted, which is why the default bind is loopback only. A
non-loopback `listen.host` without the token refuses to start.

The client's own `Authorization` header is never relayed upstream — a backend
only ever receives the key named by its `apiKeyEnv`. Every other request header
(`x-session-id`, anything unknown) is passed through.

## What it deliberately does not do

- **No body inspection or normalization.** `model` is read for routing; the
  bytes forwarded are the bytes received, so unknown fields, `reasoning_effort`
  values such as `xhigh`/`max`, legacy model-name suffixes and key order all
  survive. No whitelist, no validation, no re-serialization.
- **No SSE re-assembly.** `stream: true` responses are piped through as bytes
  with `Content-Type` and framing preserved. Events are never parsed and
  re-emitted (one backend buffers and then flushes; re-emitting corrupts it).
- **No retries, fallbacks, load balancing, budgets, quotas or rate limiting.**
  One model maps to one backend. A failure is reported, not retried.
- **No instruction rewriting.** `rewriteEmbeddingsBody()` in `server.mjs` is the
  single marked hook point where a future retrieval-instruction prefix would be
  applied. It returns the request bytes unchanged.
- **No request or response logging to disk.** One structured line per request on
  stdout (`method`, `path`, `backend`, `model`, `status`, `duration_ms`) and
  nothing else: no headers, no bodies, no tokens. Free-form strings are redacted
  before they are logged or returned.
- **No login, credential management or key issuing.** Each backend keeps its own
  authentication exactly as it is today.
- **No web UI, no dashboard, no usage accounting, no caching of completions.**
- **No default model.** A request without `model` is an error, not a guess.
