# Claude print proxy

OpenAI-compatible chat completions backed by a fresh `claude -p` process per
request. Requires an authenticated Claude Code CLI (2.1.272 or later).

## Operation

Use `python3 ../proxyctl.py install|status|restart|logs claude` from this folder.
The installed service defaults to port 11446 with the label `subscription-gateway.claude`, and logs
are in `~/.local/share/subscription-gateway/logs/`. Direct `node server.mjs` defaults to 11436;
set PORT=11446 for the managed configuration.

## Model and request behavior

- Model IDs: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`,
  `claude-sonnet-5`, `claude-fable-5-1`, `claude-fable-5`, `claude-haiku-4-5`.
  Default: Opus 5.5. Alias `opus` resolves to the configured default. Unknown IDs
  fail with 400. The CLI has no command that lists models, so the list in
  `server.mjs` is kept by hand; each id answered on a Max and a Team login on
  2026-09-30.
- Legacy WeKnora display suffixes (` [low]`, optionally ` vision`) are accepted;
  the validated canonical ID is passed to `claude --model`.
- `reasoning_effort`: low, medium, high, xhigh, max. Default low. Model labels
  do not change effort; pass reasoning_effort explicitly for other settings.
- `temperature` and `max_tokens` are not supported by this CLI transport.
- System/developer messages form the system prompt. Multiple messages and tool
  results are rendered as a transcript. OpenAI tools/tool_choice and JSON schema
  are emulated with structured CLI output.
- Streaming is buffered: complete result, then SSE chunks and DONE.
- CLI settings discovery, MCP, conversation persistence and built-in tools are
  disabled. Image requests enable only Read in a private request directory.
- PNG/JPEG/GIF/WebP data URLs and HTTP image URLs are supported. Images are
  cleaned up after success, errors, timeouts and cancellation. HTTP images
  assume trusted local clients; there is no remote URL allowlist.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| HOST | 127.0.0.1 | Bind address; non-loopback requires a shared key |
| PORT | 11436 | Managed installation uses 11446 |
| CLAUDE_BIN | claude | CLI executable; on Windows an npm `.cmd` shim is run as the program it starts |
| CLAUDE_PROXY_MODEL | claude-opus-5-5 | Default model |
| CLAUDE_PROXY_SHARED_SECRET | empty | Client Bearer key |
| CLAUDE_PROXY_EFFORT | low | Default reasoning effort |
| CLAUDE_PROXY_MAX_CONCURRENCY | 4 | Concurrent CLI processes |
| CLAUDE_PROXY_REQUEST_TIMEOUT_MS | 600000 | Child process deadline |
| CLAUDE_PROXY_MAX_BODY_BYTES | 8388608 | Request size limit |
| CLAUDE_PROXY_MAX_IMAGE_BYTES | 20971520 | Per-image limit |
| CLAUDE_PROXY_MAX_IMAGES | 10 | Images per request |
| CLAUDE_PROXY_WORKDIR | temporary directory | Request directory parent |
| CLAUDE_PROXY_REQUEST_LOG | 1 | Set 0 to disable metadata logs |

`GET /health` is public. `GET /v1/models` and `POST /v1/chat/completions` use
the configured Bearer key. Error codes: 400 malformed input, 401 unauthorized,
413 oversized body, 429 usage limit, 502 other CLI failure, 504 timeout.

An exhausted subscription answers `429` with
`{"error":{"message":"<the CLI's text>","type":"usage_limit_reached","code":"usage_limit_reached"}}`,
plus `retry-after` in seconds when the text says when it resets (`|<epoch>`,
`Try again in ~N min`, `resets in N minutes`). A router uses that to move to
another account. CLI 2.1.284 words it as `You've hit your <session|weekly|Opus|Sonnet|usage credit> limit · resets <time>`,
which has no parseable reset, so no `retry-after`. The JSON result of
`claude -p` also carries `api_error_status`; `429` there counts too. "Context
limit reached" is a prompt that is too big and stays a `502`. This mapping is
built from the CLI's code, not yet seen on a real exhausted account.

On Windows no text from a request goes on the command line. The prompt is stdin
on every platform; the system prompt is written to a private file under
`CLAUDE_PROXY_WORKDIR` and passed as `--system-prompt-file`, and the file is
removed when the run ends. `--json-schema` has no file form and stays on the
command line. `claude` is found on PATH with PATHEXT and started as the `.exe` its
npm shim runs; a `CLAUDE_BIN` that only `cmd.exe` could start is refused with 502.

Request logs contain model, effort, duration, usage, cost, status and counts;
prompts, response bodies, images and credentials are excluded. Logs are not
rotated automatically. Run tests with `node --test server.test.mjs`.
