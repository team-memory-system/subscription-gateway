# Claude print proxy

OpenAI-compatible chat completions backed by a fresh `claude -p` process per
request. Requires an authenticated Claude Code CLI (2.1.272 or later).

## Operation

Use `python3 ../proxyctl.py install|status|restart|logs claude` from this folder.
The installed service defaults to port 11446 with the label `subscription-gateway.claude`, and logs
are in `~/.local/share/subscription-gateway/logs/`. Direct `node server.mjs` defaults to 11436;
set PORT=11446 for the managed configuration.

## Model and request behavior

- Model IDs: `claude-opus-5`, `claude-opus-5-5`. Default: Opus 5.5. Alias `opus`
  resolves to the configured default. Unknown IDs fail with 400.
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
| CLAUDE_BIN | claude | CLI executable |
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
413 oversized body, 502 CLI failure, 504 timeout.

Request logs contain model, effort, duration, usage, cost, status and counts;
prompts, response bodies, images and credentials are excluded. Logs are not
rotated automatically. Run tests with `node --test server.test.mjs`.
