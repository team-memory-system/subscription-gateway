import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInvocation,
  buildRequestLogEntry,
  classifyUpstreamError,
  createHandler,
  createSpawnRunner,
  logRequest,
  stageSystemPrompt,
} from './server.mjs';

// Every image of a request lands in a private directory under the workdir, so
// pointing the workdir at a scratch directory lets the tests assert that nothing
// survives a request.
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-print-proxy-test-'));
process.env.CLAUDE_PROXY_WORKDIR = WORKDIR;
process.on('exit', () => fs.rmSync(WORKDIR, { recursive: true, force: true }));

// Keep the default stdout logger quiet so it does not interleave with the test
// reporter; the request-log tests inject their own logger (which ignores this
// switch) and the one test that exercises the default flips it back on itself.
process.env.CLAUDE_PROXY_REQUEST_LOG = '0';

// 2x2 red squares, one per supported format.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
const GIF_B64 = 'R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7';
const JPG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';

function dataUrl(mediaType, b64) {
  return `data:${mediaType};base64,${b64}`;
}

function imagePart(url, extra = {}) {
  return { type: 'image_url', image_url: { url, ...extra } };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function imagePathsFromPrompt(prompt) {
  return [...prompt.matchAll(/^Image \d+: (.+)$/gm)].map((match) => match[1]);
}

async function workdirEntries() {
  return (await fsp.readdir(WORKDIR)).sort();
}

// Fake `claude` runner: records every invocation and replays queued payloads.
function makeRunner(payloads) {
  const queue = Array.isArray(payloads) ? [...payloads] : [payloads];
  const calls = [];
  const runClaude = async (call) => {
    calls.push(call);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(call);
    return next;
  };
  runClaude.calls = calls;
  return runClaude;
}

async function withHttpServer(requestHandler, fn) {
  const server = http.createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function okPayload(result, extra = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 30,
      output_tokens: 11,
    },
    ...extra,
  };
}

async function withServer(options, fn) {
  const server = http.createServer(createHandler(options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postChat(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? tryJson(text) : null };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

test('health reports the pinned model and effort', async () => {
  await withServer({ runClaude: makeRunner(okPayload('hi')), maxConcurrency: 3 }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'ok',
      model: 'claude-opus-5-5',
      effort: 'low',
      max_concurrency: 3,
    });
  });
});

test('single user message passes the system prompt, prompt and pinned args', async () => {
  const runClaude = makeRunner(okPayload('pong'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      model: 'claude-opus-5',
      temperature: 0.7,
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Reply with exactly: pong' },
      ],
    });

    assert.equal(status, 200);
    assert.equal(runClaude.calls.length, 1);
    const { args, prompt } = runClaude.calls[0];

    assert.equal(prompt, 'Reply with exactly: pong');
    assert.equal(argValue(args, '--system-prompt'), 'You are terse.');
    assert.equal(argValue(args, '--model'), 'claude-opus-5');
    assert.equal(argValue(args, '--effort'), 'low'); // server default

    assert.equal(argValue(args, '--tools'), '');
    assert.equal(argValue(args, '--setting-sources'), '');
    assert.equal(argValue(args, '--max-turns'), '1');
    assert.equal(argValue(args, '--output-format'), 'json');
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--json-schema'));
    assert.ok(!args.includes('--bare'));
    // Body sampling knobs are ignored, but the model label is echoed back.
    assert.equal(json.model, 'claude-opus-5');
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.content, 'pong');
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.deepEqual(json.usage, {
      prompt_tokens: 1032,
      completion_tokens: 11,
      total_tokens: 1043,
    });
  });
});

test('request reasoning_effort overrides the server default for that call only', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const high = await postChat(baseUrl, {
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(high.status, 200);
    assert.equal(argValue(runClaude.calls[0].args, '--effort'), 'high');
    assert.equal(high.json.model, 'claude-opus-5-5-high');

    // A following request with no reasoning_effort falls back to the default.
    const plain = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(argValue(runClaude.calls[1].args, '--effort'), 'low');
    assert.equal(plain.json.model, 'claude-opus-5-5-low');

    // null is treated as absent.
    await postChat(baseUrl, { reasoning_effort: null, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(argValue(runClaude.calls[2].args, '--effort'), 'low');
  });
});

test('every allowed effort level is forwarded verbatim', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const level of levels) {
      const res = await postChat(baseUrl, {
        reasoning_effort: level,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(runClaude.calls.map((call) => argValue(call.args, '--effort')), levels);
  });
});

test('an unknown reasoning_effort is rejected with 400', async () => {
  const runClaude = makeRunner(okPayload('never'));
  await withServer({ runClaude }, async (baseUrl) => {
    for (const bad of ['ultra', '', 'LOW', 3]) {
      const res = await postChat(baseUrl, {
        reasoning_effort: bad,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.match(res.json.error.message, /reasoning_effort/);
      assert.equal(res.json.error.type, 'claude_print_proxy_error');
    }
    assert.equal(runClaude.calls.length, 0);
  });
});

test('createHandler({ effort }) sets the server default and /health reports it', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude, effort: 'medium' }, async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.effort, 'medium');

    const res = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(argValue(runClaude.calls[0].args, '--effort'), 'medium');
    assert.equal(res.json.model, 'claude-opus-5-5-medium');

    // The per-request override still wins over the injected default.
    await postChat(baseUrl, { reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(argValue(runClaude.calls[1].args, '--effort'), 'xhigh');
  });
});

test('createHandler rejects an unknown default effort', () => {
  assert.throws(() => createHandler({ runClaude: makeRunner(okPayload('x')), effort: 'turbo' }), /effort must be one of/);
});

test('default system prompt is used when no system message is present', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'input_audio', input_audio: {} }] }],
    });
    assert.equal(status, 200);
    assert.equal(argValue(runClaude.calls[0].args, '--system-prompt'), 'You are a helpful assistant.');
    // Text parts are kept; a part type this proxy cannot carry is called out.
    assert.equal(runClaude.calls[0].prompt, 'hi\n[unsupported content part omitted]');
    assert.equal(json.model, 'claude-opus-5-5-low');
  });
});

test('a text-only request keeps the no-tools, single-turn invocation', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 200);
    const call = runClaude.calls[0];
    assert.equal(argValue(call.args, '--tools'), '');
    assert.equal(argValue(call.args, '--max-turns'), '1');
    assert.ok(!call.args.includes('--allowedTools'));
    // No image directory: the child keeps running in the shared workdir.
    assert.equal(call.cwd, undefined);
    assert.equal(call.prompt, 'hi');
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('multi-turn history with tool results renders a transcript prompt', async () => {
  const runClaude = makeRunner(okPayload('done'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      messages: [
        { role: 'system', content: 'sys one' },
        { role: 'developer', content: 'sys two' },
        { role: 'user', content: 'what do you know about me?' },
        {
          role: 'assistant',
          content: 'Let me look.',
          tool_calls: [
            { id: 'call_x', type: 'function', function: { name: 'search_memory', arguments: '{"query":"user"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_x', content: 'likes coffee' },
        { role: 'user', content: 'and now?' },
      ],
    });

    assert.equal(status, 200);
    const { args, prompt } = runClaude.calls[0];
    assert.equal(argValue(args, '--system-prompt'), 'sys one\n\nsys two');
    assert.equal(prompt, [
      '<conversation>',
      '[user]',
      'what do you know about me?',
      '[assistant]',
      'Let me look.',
      '[assistant tool_call id=call_x name=search_memory]',
      '{"query":"user"}',
      '[tool id=call_x]',
      'likes coffee',
      '[user]',
      'and now?',
      '</conversation>',
      "Continue the conversation: produce the assistant's next reply to the latest turn above.",
    ].join('\n'));
  });
});

test('tools request builds a tool-call json schema and maps structured_output', async () => {
  const runClaude = makeRunner(okPayload(
    '{"content":"","tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}',
    {
      structured_output: {
        content: '',
        tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
      },
    },
  ));

  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: "What's the weather in Paris right now?" }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up current weather.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
        {
          type: 'function',
          function: { name: 'get_time', description: 'Current time.', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    assert.equal(status, 200);
    const { args } = runClaude.calls[0];
    const schema = JSON.parse(argValue(args, '--json-schema'));
    assert.deepEqual(schema.required, ['content', 'tool_calls']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ['get_weather', 'get_time']);
    assert.deepEqual(schema.properties.tool_calls.items.properties.arguments, { type: 'object' });
    assert.equal(schema.properties.tool_calls.items.additionalProperties, false);
    assert.equal(schema.properties.tool_calls.minItems, undefined);

    const systemPrompt = argValue(args, '--system-prompt');
    assert.match(systemPrompt, /## get_weather/);
    assert.match(systemPrompt, /Look up current weather\./);
    assert.match(systemPrompt, /"city"/);
    assert.match(systemPrompt, /## get_time/);

    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(json.choices[0].message.content, null);
    const toolCalls = json.choices[0].message.tool_calls;
    assert.equal(toolCalls.length, 1);
    assert.match(toolCalls[0].id, /^call_[0-9a-f]{24}$/);
    assert.equal(toolCalls[0].type, 'function');
    assert.equal(toolCalls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: 'Paris' });
  });
});

test('empty tool_calls in tools mode falls back to a text answer', async () => {
  const runClaude = makeRunner(okPayload('{"content":"It is sunny.","tool_calls":[]}', {
    structured_output: { content: 'It is sunny.', tool_calls: [] },
  }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.equal(json.choices[0].message.content, 'It is sunny.');
    assert.equal(json.choices[0].message.tool_calls, undefined);
  });
});

test('tool_choice naming a function narrows the enum and forces a call', async () => {
  const runClaude = makeRunner(okPayload('{"content":"","tool_calls":[{"name":"get_weather","arguments":{}}]}', {
    structured_output: { content: '', tool_calls: [{ name: 'get_weather', arguments: {} }] },
  }));
  await withServer({ runClaude }, async (baseUrl) => {
    await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'weather?' }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } },
      ],
    });
    const schema = JSON.parse(argValue(runClaude.calls[0].args, '--json-schema'));
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ['get_weather']);
    assert.equal(schema.properties.tool_calls.minItems, 1);
    assert.match(argValue(runClaude.calls[0].args, '--system-prompt'), /must call the tool "get_weather"/);
  });
});

test('tool_choice "required" keeps every tool but requires one call', async () => {
  const runClaude = makeRunner(okPayload('{"content":"","tool_calls":[{"name":"a","arguments":{}}]}', {
    structured_output: { content: '', tool_calls: [{ name: 'a', arguments: {} }] },
  }));
  await withServer({ runClaude }, async (baseUrl) => {
    await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'go' }],
      tool_choice: 'required',
      tools: [
        { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
      ],
    });
    const schema = JSON.parse(argValue(runClaude.calls[0].args, '--json-schema'));
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ['a', 'b']);
    assert.equal(schema.properties.tool_calls.minItems, 1);
  });
});

test('tool_choice "none" skips tool emulation and honours response_format', async () => {
  const runClaude = makeRunner(okPayload('{"answer":"hi"}', { structured_output: { answer: 'hi' } }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'Say hi' }],
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
      },
    });
    const schema = JSON.parse(argValue(runClaude.calls[0].args, '--json-schema'));
    assert.deepEqual(schema.required, ['answer']);
    assert.equal(JSON.parse(json.choices[0].message.content).answer, 'hi');
  });
});

test('response_format json_schema returns the structured output as a JSON string', async () => {
  const runClaude = makeRunner(okPayload('{"answer": "hi there"}', { structured_output: { answer: 'hi there' } }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'Say hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
      },
    });
    assert.equal(status, 200);
    assert.equal(argValue(runClaude.calls[0].args, '--json-schema'), JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    }));
    assert.equal(typeof json.choices[0].message.content, 'string');
    assert.deepEqual(JSON.parse(json.choices[0].message.content), { answer: 'hi there' });
    assert.equal(json.choices[0].finish_reason, 'stop');
  });
});

test('response_format json_object augments the system prompt without a schema', async () => {
  const runClaude = makeRunner(okPayload('{"a":1}'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'json please' }],
      response_format: { type: 'json_object' },
    });
    const { args } = runClaude.calls[0];
    assert.ok(!args.includes('--json-schema'));
    assert.match(argValue(args, '--system-prompt'), /single valid JSON object only/);
    assert.equal(json.choices[0].message.content, '{"a":1}');
  });
});

test('a schema request is told to answer through StructuredOutput and gets a second turn', () => {
  // A caller asking for "exactly one JSON object" made Sonnet 5.5 write the JSON
  // as text, and with one turn the CLI ended the run as error_max_turns.
  const messages = [{ role: 'system', content: 'Return exactly one JSON object.' }, { role: 'user', content: 'hi' }];
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const instruction = /\n\nGive your answer by calling the StructuredOutput tool with the JSON object as its input\. Do not write the JSON as text\.$/;

  const structured = buildInvocation({ messages, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } });
  assert.match(argValue(structured.args, '--system-prompt'), /^Return exactly one JSON object\./);
  assert.match(argValue(structured.args, '--system-prompt'), instruction);
  assert.equal(argValue(structured.args, '--max-turns'), '2');

  const tools = buildInvocation({ messages, tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } }] });
  assert.match(argValue(tools.args, '--system-prompt'), instruction);
  assert.equal(argValue(tools.args, '--max-turns'), '2');

  // Without a schema the CLI offers no StructuredOutput tool to point at.
  for (const body of [{ messages }, { messages, response_format: { type: 'json_object' } }]) {
    const { args } = buildInvocation(body);
    assert.doesNotMatch(argValue(args, '--system-prompt'), /StructuredOutput/);
    assert.equal(argValue(args, '--max-turns'), '1');
  }
});

test('stream:true emits two chunks plus [DONE], with usage when requested', async () => {
  const runClaude = makeRunner(okPayload('streamed answer'));
  await withServer({ runClaude }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'stream it' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    const lines = text.split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(lines.length, 3);
    assert.equal(lines[2], 'data: [DONE]');

    const first = JSON.parse(lines[0].slice(6));
    assert.equal(first.object, 'chat.completion.chunk');
    assert.equal(first.model, 'claude-opus-5');
    assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: 'streamed answer' });
    assert.equal(first.choices[0].finish_reason, null);

    const second = JSON.parse(lines[1].slice(6));
    assert.deepEqual(second.choices[0].delta, {});
    assert.equal(second.choices[0].finish_reason, 'stop');
    assert.deepEqual(second.usage, { prompt_tokens: 1032, completion_tokens: 11, total_tokens: 1043 });
    assert.equal(first.id, second.id);
  });
});

test('stream:true emits tool_calls deltas and omits usage without include_usage', async () => {
  const runClaude = makeRunner(okPayload('{"content":"","tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}', {
    structured_output: { content: '', tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
  }));
  await withServer({ runClaude }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    });
    const lines = (await res.text()).split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(lines.length, 3);
    assert.equal(lines[2], 'data: [DONE]');
    const first = JSON.parse(lines[0].slice(6));
    assert.equal(first.choices[0].delta.role, 'assistant');
    assert.equal(first.choices[0].delta.content, undefined);
    assert.equal(first.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(first.choices[0].delta.tool_calls[0].type, 'function');
    assert.equal(first.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(first.choices[0].delta.tool_calls[0].function.arguments), { city: 'Paris' });
    const second = JSON.parse(lines[1].slice(6));
    assert.equal(second.choices[0].finish_reason, 'tool_calls');
    assert.equal(second.usage, undefined);
  });
});

test('shared secret rejects missing and wrong bearer tokens', async () => {
  const runClaude = makeRunner(okPayload('secret'));
  await withServer({ runClaude, sharedSecret: 's3cret' }, async (baseUrl) => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };

    const missing = await postChat(baseUrl, body);
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error.message, 'Unauthorized');

    const wrong = await postChat(baseUrl, body, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);

    const ok = await postChat(baseUrl, body, { authorization: 'Bearer s3cret' });
    assert.equal(ok.status, 200);
    assert.equal(runClaude.calls.length, 1);
  });
});

test('is_error from claude becomes a 502', async () => {
  const runClaude = makeRunner({
    type: 'result',
    is_error: true,
    result: 'Not logged in · Please run /login',
    usage: {},
  });
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(status, 502);
    assert.equal(json.error.message, 'Not logged in · Please run /login');
  });
});

test('runner failures keep their status code', async () => {
  const runClaude = async () => {
    const error = new Error('claude timed out after 1000ms');
    error.statusCode = 504;
    throw error;
  };
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 504);
    assert.match(json.error.message, /timed out/);
  });
});

test('invalid bodies are rejected with 400', async () => {
  const runClaude = makeRunner(okPayload('never'));
  await withServer({ runClaude }, async (baseUrl) => {
    const empty = await postChat(baseUrl, { messages: [] });
    assert.equal(empty.status, 400);

    const missing = await postChat(baseUrl, {});
    assert.equal(missing.status, 400);

    const systemOnly = await postChat(baseUrl, { messages: [{ role: 'system', content: 'only' }] });
    assert.equal(systemOnly.status, 400);

    const malformed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(runClaude.calls.length, 0);
  });
});

test('concurrency is capped by the semaphore', async () => {
  let active = 0;
  let peak = 0;
  const release = [];
  const runClaude = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => release.push(resolve));
    active -= 1;
    return okPayload('ok');
  };

  await withServer({ runClaude, maxConcurrency: 2 }, async (baseUrl) => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const requests = [1, 2, 3, 4].map(() => postChat(baseUrl, body));
    while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 2);
    const drain = setInterval(() => {
      const next = release.shift();
      if (next) next();
    }, 1);
    const results = await Promise.all(requests);
    clearInterval(drain);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(peak, 2);
  });
});

// ---------------------------------------------------------------------------
// Image input
// ---------------------------------------------------------------------------

test('a data URL image is written to disk and handed to claude as a Read target', async () => {
  const seen = {};
  const runClaude = makeRunner(async ({ prompt, cwd }) => {
    const paths = imagePathsFromPrompt(prompt);
    seen.paths = paths;
    seen.cwd = cwd;
    seen.bytes = await fsp.readFile(paths[0]);
    seen.dirEntries = (await fsp.readdir(cwd)).sort();
    return okPayload('A red square.');
  });

  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this?' },
          imagePart(dataUrl('image/png', PNG_B64), { detail: 'auto' }),
        ],
      }],
    });

    assert.equal(status, 200);
    assert.equal(json.choices[0].message.content, 'A red square.');

    const { args, prompt } = runClaude.calls[0];
    // Read is the only tool enabled, and each Read costs a turn.
    assert.equal(argValue(args, '--tools'), 'Read');
    assert.equal(argValue(args, '--allowedTools'), 'Read');
    assert.equal(argValue(args, '--max-turns'), '3');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(argValue(args, '--setting-sources'), '');
    assert.equal(argValue(args, '--model'), 'claude-opus-5-5');

    // The text keeps its place; the paths live in a trailing section.
    assert.match(prompt, /^What colour is this\?\n\[Image 1\]\n\n# Images\n/);
    assert.match(prompt, /Read every one of them with the Read tool/);

    assert.equal(seen.paths.length, 1);
    assert.ok(path.isAbsolute(seen.paths[0]));
    assert.equal(path.dirname(seen.paths[0]), seen.cwd);
    assert.equal(path.basename(seen.paths[0]), 'image-1.png');
    assert.equal(path.dirname(seen.cwd), WORKDIR);
    assert.deepEqual(seen.dirEntries, ['image-1.png']);
    assert.equal(seen.bytes.toString('base64'), PNG_B64);

    // Nothing is left behind once the response is out.
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('two images are numbered, get real extensions and raise --max-turns', async () => {
  const seen = {};
  const runClaude = makeRunner(async ({ prompt, cwd }) => {
    seen.paths = imagePathsFromPrompt(prompt);
    seen.dirEntries = (await fsp.readdir(cwd)).sort();
    seen.first = (await fsp.readFile(seen.paths[0])).toString('base64');
    seen.second = (await fsp.readFile(seen.paths[1])).toString('base64');
    return okPayload('two squares');
  });

  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      messages: [{
        role: 'user',
        content: [
          imagePart(dataUrl('image/png', PNG_B64)),
          { type: 'text', text: 'Compare these.' },
          // Deliberately mislabelled: the extension comes from the bytes.
          imagePart(dataUrl('image/png', JPG_B64)),
        ],
      }],
    });

    assert.equal(status, 200);
    const { args, prompt } = runClaude.calls[0];
    assert.equal(argValue(args, '--max-turns'), '4');
    assert.match(prompt, /^\[Image 1\]\nCompare these\.\n\[Image 2\]\n\n# Images\n/);
    assert.deepEqual(seen.dirEntries, ['image-1.png', 'image-2.jpg']);
    assert.equal(seen.first, PNG_B64);
    assert.equal(seen.second, JPG_B64);
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('gif and webp data URLs are accepted', async () => {
  const seen = {};
  const runClaude = makeRunner(async ({ cwd }) => {
    seen.dirEntries = (await fsp.readdir(cwd)).sort();
    return okPayload('ok');
  });
  await withServer({ runClaude }, async (baseUrl) => {
    const webpB64 = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
    const { status } = await postChat(baseUrl, {
      messages: [{
        role: 'user',
        content: [
          imagePart(dataUrl('image/gif', GIF_B64)),
          imagePart(dataUrl('image/webp', webpB64)),
        ],
      }],
    });
    assert.equal(status, 200);
    assert.deepEqual(seen.dirEntries, ['image-1.gif', 'image-2.webp']);
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('images are collected across a multi-turn transcript in order', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }, imagePart(dataUrl('image/png', PNG_B64))] },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: [imagePart(dataUrl('image/jpeg', JPG_B64)), { type: 'text', text: 'and this?' }] },
      ],
    });
    assert.equal(status, 200);
    const { prompt, args } = runClaude.calls[0];
    assert.equal(argValue(args, '--max-turns'), '4');
    const paths = imagePathsFromPrompt(prompt);
    assert.deepEqual(paths.map((p) => path.basename(p)), ['image-1.png', 'image-2.jpg']);
    assert.match(prompt, /\[user\]\nfirst\n\[Image 1\]\n\[assistant\]\nnoted\n\[user\]\n\[Image 2\]\nand this\?\n<\/conversation>/);
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('images in a system message are dropped instead of becoming Read targets', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be terse' }, imagePart(dataUrl('image/png', PNG_B64))] },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(status, 200);
    const { args, prompt, cwd } = runClaude.calls[0];
    assert.equal(argValue(args, '--tools'), '');
    assert.equal(argValue(args, '--max-turns'), '1');
    assert.equal(cwd, undefined);
    assert.equal(prompt, 'hi');
    assert.match(argValue(args, '--system-prompt'), /be terse/);
  });
});

test('the image directory is removed when the runner fails', async () => {
  let capturedCwd;
  const runClaude = async ({ cwd }) => {
    capturedCwd = cwd;
    assert.ok(fs.existsSync(cwd));
    const error = new Error('claude exited with code 1');
    error.statusCode = 502;
    throw error;
  };
  await withServer({ runClaude }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: [imagePart(dataUrl('image/png', PNG_B64))] }],
    });
    assert.equal(status, 502);
    assert.ok(capturedCwd);
    assert.equal(fs.existsSync(capturedCwd), false);
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('malformed image URLs are rejected with 400 and never reach claude', async () => {
  const runClaude = makeRunner(okPayload('never'));
  await withServer({ runClaude }, async (baseUrl) => {
    const bad = [
      'data:image/png;base64,!!!!',
      'data:image/png;base64,',
      'data:image/png;base64,aGVsbG8=', // valid base64, not an image
      'data:image/png,plain',           // not base64-encoded
      'data:text/plain;base64,aGk=',    // unsupported media type
      'data:image/bmp;base64,Qk0=',     // unsupported media type
      'not-a-url',
      'file:///etc/passwd',
      'ftp://example.com/a.png',
    ];
    for (const url of bad) {
      const res = await postChat(baseUrl, {
        messages: [{ role: 'user', content: [imagePart(url)] }],
      });
      assert.equal(res.status, 400, `expected 400 for ${url}`);
      assert.equal(res.json.error.type, 'claude_print_proxy_error');
    }

    const missing = await postChat(baseUrl, {
      messages: [{ role: 'user', content: [{ type: 'image_url' }] }],
    });
    assert.equal(missing.status, 400);

    assert.equal(runClaude.calls.length, 0);
    assert.deepEqual(await workdirEntries(), []);
  });
});

test('CLAUDE_PROXY_MAX_IMAGES caps how many images one request may carry', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  process.env.CLAUDE_PROXY_MAX_IMAGES = '2';
  try {
    await withServer({ runClaude }, async (baseUrl) => {
      const image = imagePart(dataUrl('image/png', PNG_B64));
      const ok = await postChat(baseUrl, { messages: [{ role: 'user', content: [image, image] }] });
      assert.equal(ok.status, 200);

      const tooMany = await postChat(baseUrl, { messages: [{ role: 'user', content: [image, image, image] }] });
      assert.equal(tooMany.status, 400);
      assert.match(tooMany.json.error.message, /more than 2 images/);
      assert.equal(runClaude.calls.length, 1);
      assert.deepEqual(await workdirEntries(), []);
    });
  } finally {
    delete process.env.CLAUDE_PROXY_MAX_IMAGES;
  }
});

test('CLAUDE_PROXY_MAX_IMAGE_BYTES rejects oversized images', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  process.env.CLAUDE_PROXY_MAX_IMAGE_BYTES = '32';
  try {
    await withServer({ runClaude }, async (baseUrl) => {
      const res = await postChat(baseUrl, {
        messages: [{ role: 'user', content: [imagePart(dataUrl('image/png', PNG_B64))] }],
      });
      assert.equal(res.status, 400);
      assert.match(res.json.error.message, /CLAUDE_PROXY_MAX_IMAGE_BYTES/);
      assert.equal(runClaude.calls.length, 0);
      assert.deepEqual(await workdirEntries(), []);
    });
  } finally {
    delete process.env.CLAUDE_PROXY_MAX_IMAGE_BYTES;
  }
});

test('an http image is fetched and stored under its sniffed extension', async () => {
  const png = Buffer.from(PNG_B64, 'base64');
  const seen = {};
  const runClaude = makeRunner(async ({ prompt, cwd }) => {
    seen.paths = imagePathsFromPrompt(prompt);
    seen.dirEntries = (await fsp.readdir(cwd)).sort();
    seen.bytes = (await fsp.readFile(seen.paths[0])).toString('base64');
    return okPayload('fetched');
  });

  await withHttpServer((req, res) => {
    // The URL claims .gif and the header claims jpeg; the bytes are a PNG.
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(png);
  }, async (imageBase) => {
    await withServer({ runClaude }, async (baseUrl) => {
      const { status } = await postChat(baseUrl, {
        messages: [{ role: 'user', content: [imagePart(`${imageBase}/pic.gif`)] }],
      });
      assert.equal(status, 200);
      assert.deepEqual(seen.dirEntries, ['image-1.png']);
      assert.equal(seen.bytes, PNG_B64);
      assert.deepEqual(await workdirEntries(), []);
    });
  });
});

test('an http image that 404s, is not an image, or is too big becomes a 400', async () => {
  const png = Buffer.from(PNG_B64, 'base64');
  const runClaude = makeRunner(okPayload('never'));

  await withHttpServer((req, res) => {
    if (req.url === '/missing.png') {
      res.writeHead(404).end('nope');
      return;
    }
    if (req.url === '/text.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end('this is not an image at all');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  }, async (imageBase) => {
    await withServer({ runClaude }, async (baseUrl) => {
      const missing = await postChat(baseUrl, {
        messages: [{ role: 'user', content: [imagePart(`${imageBase}/missing.png`)] }],
      });
      assert.equal(missing.status, 400);
      assert.match(missing.json.error.message, /HTTP 404/);

      const notAnImage = await postChat(baseUrl, {
        messages: [{ role: 'user', content: [imagePart(`${imageBase}/text.png`)] }],
      });
      assert.equal(notAnImage.status, 400);
      assert.match(notAnImage.json.error.message, /not a supported image/);

      process.env.CLAUDE_PROXY_MAX_IMAGE_BYTES = '8';
      try {
        const tooBig = await postChat(baseUrl, {
          messages: [{ role: 'user', content: [imagePart(`${imageBase}/ok.png`)] }],
        });
        assert.equal(tooBig.status, 400);
        assert.match(tooBig.json.error.message, /CLAUDE_PROXY_MAX_IMAGE_BYTES/);
      } finally {
        delete process.env.CLAUDE_PROXY_MAX_IMAGE_BYTES;
      }

      assert.equal(runClaude.calls.length, 0);
      assert.deepEqual(await workdirEntries(), []);
    });
  });
});

test('an image request can still use tool emulation and a json schema', async () => {
  const runClaude = makeRunner(okPayload('{"content":"red","tool_calls":[]}', {
    structured_output: { content: 'red', tool_calls: [] },
  }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'colour?' }, imagePart(dataUrl('image/png', PNG_B64))] }],
      tools: [{ type: 'function', function: { name: 'log_colour', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(status, 200);
    const { args } = runClaude.calls[0];
    assert.equal(argValue(args, '--tools'), 'Read');
    assert.equal(argValue(args, '--max-turns'), '3');
    assert.ok(args.includes('--json-schema'));
    assert.equal(json.choices[0].message.content, 'red');
    assert.deepEqual(await workdirEntries(), []);
  });
});


// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

// The handler hands the (still mutable) record to its logger, so the capture
// freezes each one into the entry that would have gone to stdout.
function captureLogs() {
  const entries = [];
  const capture = (record) => { entries.push(buildRequestLogEntry(record)); };
  capture.entries = entries;
  return capture;
}

const LOG_FIELDS = [
  'event', 'at', 'status', 'model', 'effort', 'images', 'tools', 'json_schema',
  'num_turns', 'duration_ms', 'claude_duration_ms', 'usage', 'cost_usd', 'error',
];

test('a successful request logs one line with usage, turns, duration and cost', async () => {
  const runClaude = makeRunner(okPayload('pong', {
    num_turns: 1,
    duration_ms: 4321,
    total_cost_usd: 0.0123,
  }));
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    });
    assert.equal(status, 200);
  });

  assert.equal(logs.entries.length, 1);
  const [entry] = logs.entries;
  assert.deepEqual(Object.keys(entry), LOG_FIELDS);
  assert.equal(entry.event, 'request');
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
  assert.equal(entry.status, 200);
  assert.equal(entry.model, 'claude-opus-5');
  assert.equal(entry.effort, 'low');
  assert.equal(entry.images, 0);
  assert.equal(entry.tools, false);
  assert.equal(entry.json_schema, false);
  assert.equal(entry.num_turns, 1);
  assert.equal(entry.claude_duration_ms, 4321);
  assert.equal(entry.cost_usd, 0.0123);
  assert.equal(entry.error, null);
  assert.ok(Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0);
  assert.deepEqual(entry.usage, {
    prompt_tokens: 1032,
    completion_tokens: 11,
    total_tokens: 1043,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 1000,
  });
  // No prompt, response text or header ever reaches the log line.
  const line = JSON.stringify(entry);
  assert.ok(!line.includes('pong'));
  assert.ok(!line.includes('Reply with exactly'));
});

test('the log echoes the effort and the synthesised model label when the body has none', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    const { status } = await postChat(baseUrl, {
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(status, 200);
  });

  assert.equal(logs.entries[0].model, 'claude-opus-5-5-high');
  assert.equal(logs.entries[0].effort, 'high');
  // A payload without num_turns/cost still logs the fields, as null.
  assert.equal(logs.entries[0].num_turns, null);
  assert.equal(logs.entries[0].claude_duration_ms, null);
  assert.equal(logs.entries[0].cost_usd, null);
});

test('the log flags tools, json_schema and image counts', async () => {
  const runClaude = makeRunner(okPayload('{"content":"hi","tool_calls":[]}', {
    structured_output: { content: 'hi', tool_calls: [] },
  }));
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    const tools = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(tools.status, 200);

    const schema = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
    });
    assert.equal(schema.status, 200);

    const images = await postChat(baseUrl, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          imagePart(dataUrl('image/png', PNG_B64)),
          imagePart(dataUrl('image/gif', GIF_B64)),
        ],
      }],
    });
    assert.equal(images.status, 200);
  });

  assert.equal(logs.entries.length, 3);
  assert.deepEqual(
    logs.entries.map((entry) => [entry.tools, entry.json_schema, entry.images]),
    [[true, false, 0], [false, true, 0], [false, false, 2]],
  );
  assert.deepEqual(await workdirEntries(), []);
});

test('a 400 is logged with bad_request, a null usage and no model', async () => {
  const runClaude = makeRunner(okPayload('never'));
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    assert.equal((await postChat(baseUrl, { messages: [] })).status, 400);

    const malformed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
  });

  assert.equal(runClaude.calls.length, 0);
  assert.equal(logs.entries.length, 2);
  for (const entry of logs.entries) {
    assert.deepEqual(Object.keys(entry), LOG_FIELDS);
    assert.equal(entry.status, 400);
    assert.equal(entry.error, 'bad_request');
    assert.equal(entry.usage, null);
    assert.equal(entry.model, null);
    assert.equal(entry.effort, null);
    assert.equal(entry.images, null);
    assert.equal(entry.tools, null);
    assert.equal(entry.json_schema, null);
    assert.ok(Number.isFinite(entry.duration_ms));
  }
});

test('runner failures and timeouts keep their status and error type in the log', async () => {
  const logs = captureLogs();
  const failWith = (statusCode, message) => async () => {
    const error = new Error(message);
    error.statusCode = statusCode;
    throw error;
  };

  await withServer({ runClaude: failWith(504, 'claude timed out after 1000ms'), logRequest: logs }, async (baseUrl) => {
    assert.equal((await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] })).status, 504);
  });
  await withServer({ runClaude: failWith(502, 'claude exited with code 1'), logRequest: logs }, async (baseUrl) => {
    assert.equal((await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] })).status, 502);
  });

  assert.deepEqual(
    logs.entries.map((entry) => [entry.status, entry.error, entry.usage, entry.model]),
    [[504, 'timeout', null, 'claude-opus-5-5-low'], [502, 'upstream_error', null, 'claude-opus-5-5-low']],
  );
});

test('an is_error 502 still logs the tokens the run spent', async () => {
  const runClaude = makeRunner({
    type: 'result',
    is_error: true,
    result: 'Not logged in · Please run /login',
    num_turns: 2,
    duration_ms: 77,
    total_cost_usd: 0.004,
    usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 },
  });
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    assert.equal((await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] })).status, 502);
  });

  const [entry] = logs.entries;
  assert.equal(entry.status, 502);
  assert.equal(entry.error, 'upstream_error');
  assert.equal(entry.num_turns, 2);
  assert.equal(entry.claude_duration_ms, 77);
  assert.equal(entry.cost_usd, 0.004);
  assert.deepEqual(entry.usage, {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 0,
  });
  assert.ok(!JSON.stringify(entry).includes('Not logged in'));
});

test('a streamed request logs one line after the stream ends', async () => {
  const runClaude = makeRunner(okPayload('streamed', { num_turns: 1 }));
  const logs = captureLogs();
  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('data: [DONE]'));
  });

  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].status, 200);
  assert.equal(logs.entries[0].usage.total_tokens, 1043);
});

test('a client hang-up is logged as 499 client_closed_request', async () => {
  const started = [];
  const runClaude = ({ signal }) => new Promise((resolve, reject) => {
    started.push(true);
    const abort = () => {
      const error = new Error('Client closed the request');
      error.statusCode = 499;
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  const logs = captureLogs();

  await withServer({ runClaude, logRequest: logs }, async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    }).catch(() => 'aborted');

    while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    assert.equal(await request, 'aborted');
    while (logs.entries.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  });

  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].status, 499);
  assert.equal(logs.entries[0].error, 'client_closed_request');
  assert.equal(logs.entries[0].usage, null);
});

test('health, unknown routes are not logged and a rejected bearer token is', async () => {
  const runClaude = makeRunner(okPayload('ok'));
  const logs = captureLogs();
  await withServer({ runClaude, sharedSecret: 'sekret', logRequest: logs }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
    assert.equal(logs.entries.length, 0);

    assert.equal((await postChat(baseUrl, { messages: [{ role: 'user', content: 'hi' }] })).status, 401);
  });

  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].status, 401);
  assert.equal(logs.entries[0].error, 'unauthorized');
  assert.equal(logs.entries[0].model, null);
});

test('logRequest prints one JSON line to stdout, and CLAUDE_PROXY_REQUEST_LOG=0 silences it', () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  const previous = process.env.CLAUDE_PROXY_REQUEST_LOG;
  let printed;
  let silenced;
  try {
    delete process.env.CLAUDE_PROXY_REQUEST_LOG;
    printed = logRequest({
      status: 200,
      model: 'claude-opus-5',
      effort: 'low',
      images: 0,
      tools: false,
      jsonSchema: false,
      durationMs: 12,
      payload: okPayload('hi', { num_turns: 1, duration_ms: 34, total_cost_usd: 0.5 }),
    });
    process.env.CLAUDE_PROXY_REQUEST_LOG = '0';
    silenced = logRequest({ status: 200, durationMs: 1 });
  } finally {
    process.stdout.write = original;
    process.env.CLAUDE_PROXY_REQUEST_LOG = previous;
  }

  assert.equal(written.length, 1);
  assert.ok(written[0].endsWith('\n'));
  assert.equal(written[0].trimEnd().includes('\n'), false, 'the entry must be a single line');
  assert.deepEqual(JSON.parse(written[0]), printed);
  assert.equal(printed.status, 200);
  assert.equal(printed.usage.total_tokens, 1043);
  assert.equal(printed.cost_usd, 0.5);
  assert.equal(silenced, null);
});

 test('explicit model selection pins each supported version and rejects unknown models', () => {
  for (const model of [
    'claude-opus-5-5', 'claude-opus-5',
    'claude-sonnet-5-5', 'claude-sonnet-5',
    'claude-fable-5-1', 'claude-fable-5',
    'claude-haiku-4-5',
  ]) {
    const { args } = buildInvocation({model: `${model} [low]`, messages: [{role: 'user', content: 'test'}]});
    assert.equal(argValue(args, '--model'), model);
  }
  assert.throws(() => buildInvocation({model: 'unknown-model', messages: [{role: 'user', content: 'test'}]}), /Unsupported model/);
});

// ---------------------------------------------------------------------------
// Usage-limit failures: 429 usage_limit_reached for the router, 502 otherwise
// ---------------------------------------------------------------------------

async function postChatRaw(baseUrl, body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function usageLimitBody(message) {
  return { error: { message, type: 'usage_limit_reached', code: 'usage_limit_reached' } };
}

function isErrorPayload(result, extra = {}) {
  return { type: 'result', subtype: 'success', is_error: true, result, usage: {}, ...extra };
}

// A real child process standing in for `claude`, so the spawn runner's own exit
// handling is what gets exercised.
function shellRunner(script) {
  return createSpawnRunner({
    claudeBin: 'sh',
    spawnFn: (_bin, _args, options) => spawn('sh', ['-c', script], options),
  });
}

test('classifyUpstreamError recognizes usage-limit text and parses the reset', () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const nowSeconds = Math.floor(now / 1000);
  assert.deepEqual(
    classifyUpstreamError(`Claude AI usage limit reached|${nowSeconds + 600}`, now),
    { quota: true, retryAfterSeconds: 600 },
  );
  assert.deepEqual(
    classifyUpstreamError('Claude AI usage limit reached|1759999999', now),
    { quota: true, retryAfterSeconds: 0 },
    'an epoch in the past clamps to 0',
  );
  assert.deepEqual(
    classifyUpstreamError('You have hit your usage limit. Try again in ~5 min.', now),
    { quota: true, retryAfterSeconds: 300 },
  );
  assert.deepEqual(classifyUpstreamError('Usage limit reached · resets in 30 minutes', now), { quota: true, retryAfterSeconds: 1800 });
  assert.deepEqual(classifyUpstreamError('usage limit reached, resets in 5 min', now), { quota: true, retryAfterSeconds: 300 });
  assert.deepEqual(classifyUpstreamError('rate limit hit, resets in 45 seconds', now), { quota: true, retryAfterSeconds: 45 });

  for (const message of [
    'usage limit reached',
    'Claude usage limit reached. Your limit resets at 5pm',
    'Weekly limit reached',
    '5-hour limit reached ∙ resets 5pm',
    'You hit your limit',
    "You've hit your limit · resets 5pm (Asia/Seoul)",
    "You've hit your usage limit",
    "You've hit your session limit · resets 5pm (Asia/Seoul)",
    "You've hit your weekly limit · resets Oct 3, 9am",
    "You've hit your Opus limit",
    "You've hit your usage credit limit",
    "You've reached your Fable limit.",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
    'rate_limit_error',
    'usage_limit_reached',
    'Request failed with status 429',
  ]) {
    assert.deepEqual(classifyUpstreamError(message, now), { quota: true }, message);
  }

  for (const message of [
    'Not logged in · Please run /login',
    'claude exited with code 1: boom',
    'Credit balance is too low',
    'Reached maximum number of turns (1)',
    'prompt has 4290 tokens',
    'Context limit reached · /compact or /clear to continue',
    'Output token limit reached',
    'limit reached',
    '',
    undefined,
  ]) {
    assert.deepEqual(classifyUpstreamError(message, now), { quota: false }, String(message));
  }
});

test('is_error with a usage-limit epoch becomes 429 usage_limit_reached with retry-after', async () => {
  const message = `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 900}`;
  const runClaude = makeRunner(isErrorPayload(message));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 429);
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    const retryAfter = Number(headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 895 && retryAfter <= 900, `retry-after ${retryAfter}`);
    assert.deepEqual(JSON.parse(text), usageLimitBody(message));
  });
});

test('is_error with the CLI session-limit text becomes 429 without retry-after', async () => {
  const message = "You've hit your session limit · resets 5pm (Asia/Seoul)";
  const runClaude = makeRunner(isErrorPayload(message));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 429);
    assert.equal(headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(text), usageLimitBody(message));
  });
});

test('is_error with api_error_status 429 becomes 429 even when the text is generic', async () => {
  const runClaude = makeRunner(isErrorPayload('API Error: request rejected', { api_error_status: 429 }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 429);
    assert.equal(headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(text), usageLimitBody('API Error: request rejected'));
  });
});

test('is_error with a non-quota message keeps the 502 body unchanged', async () => {
  const runClaude = makeRunner(isErrorPayload('Not logged in · Please run /login', { api_error_status: 401 }));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 502);
    assert.equal(headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(text), {
      error: { message: 'Not logged in · Please run /login', type: 'claude_print_proxy_error' },
    });
  });
});

test('stream:true with a usage-limit is_error answers 429 JSON before any SSE byte', async () => {
  const message = 'Claude AI usage limit reached. Try again in ~12 min.';
  const runClaude = makeRunner(isErrorPayload(message));
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, {
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(status, 429);
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(headers.get('retry-after'), '720');
    assert.ok(!text.includes('data:'));
    assert.deepEqual(JSON.parse(text), usageLimitBody(message));
  });
});

test('a non-zero exit whose stderr mentions a usage limit becomes 429', async () => {
  const epoch = Math.floor(Date.now() / 1000) + 3600;
  const runClaude = shellRunner(`echo "Claude AI usage limit reached|${epoch}" >&2; exit 1`);
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 429);
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    const retryAfter = Number(headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 3595 && retryAfter <= 3600, `retry-after ${retryAfter}`);
    assert.deepEqual(JSON.parse(text), usageLimitBody(`Claude AI usage limit reached|${epoch}`));
  });
});

test('a non-zero exit whose plain-text stdout mentions a usage limit becomes 429', async () => {
  const runClaude = shellRunner(`echo "You've hit your weekly limit · resets Oct 3, 9am"; exit 1`);
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 429);
    assert.equal(headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(text), usageLimitBody("You've hit your weekly limit · resets Oct 3, 9am"));
  });
});

test('a non-zero exit without a usage limit keeps the 502', async () => {
  const runClaude = shellRunner('echo "boom" >&2; exit 3');
  await withServer({ runClaude }, async (baseUrl) => {
    const { status, headers, text } = await postChatRaw(baseUrl, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 502);
    assert.equal(headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(text), {
      error: { message: 'claude exited with code 3: boom', type: 'claude_print_proxy_error' },
    });
  });
});

// ---------------------------------------------------------------------------
// Windows: nothing from the request on the command line
// ---------------------------------------------------------------------------

// A request whose system text would mean something to cmd.exe, and a lot of it.
const HOSTILE_SYSTEM = `Answer tersely & "exactly" %PATH% ^ | <x> ${'y'.repeat(40_000)}`;

function hostileInvocation() {
  return buildInvocation({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'system', content: HOSTILE_SYSTEM }, { role: 'user', content: 'hello over stdin' }],
  });
}

// Records what would have been spawned on Windows and stands in for claude.exe
// with a real process, which echoes stdin back as the result.
function windowsSpawn(calls) {
  return (file, args, options) => {
    const index = args.indexOf('--system-prompt-file');
    calls.push({
      file,
      args,
      options,
      systemPromptOnDisk: index === -1 ? undefined : fs.readFileSync(args[index + 1], 'utf8'),
    });
    const script = 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>process.stdout.write(JSON.stringify({type:\'result\',is_error:false,result:s})))"';
    return spawn('sh', ['-c', script], { cwd: options.cwd, env: options.env, stdio: options.stdio });
  };
}

test('on Windows the system prompt goes through a private file and the prompt through stdin', async () => {
  const invocation = hostileInvocation();
  const calls = [];
  const resolved = [];
  const runClaude = createSpawnRunner({
    claudeBin: 'claude',
    platform: 'win32',
    resolveCommand: (bin, args, options) => {
      resolved.push({ bin, allowShell: options.allowShell });
      return { file: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args };
    },
    spawnFn: windowsSpawn(calls),
  });
  const before = await workdirEntries();
  const payload = await runClaude({ args: invocation.args, prompt: invocation.prompt });
  assert.equal(payload.result, 'hello over stdin');

  assert.deepEqual(resolved, [{ bin: 'claude', allowShell: false }], 'cmd.exe is never an option for these arguments');
  const [call] = calls;
  assert.equal(call.file, 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(call.options.windowsHide, true);
  assert.ok(!call.args.includes('--system-prompt'));
  assert.ok(!call.args.some((arg) => arg.includes('%PATH%') || arg.includes('hello over stdin')), 'no request text on the command line');
  assert.equal(call.systemPromptOnDisk, invocation.systemPrompt);
  assert.equal(argValue(call.args, '--model'), 'claude-haiku-4-5');
  // Everything else keeps its place and value.
  const expected = [...invocation.args];
  expected.splice(expected.indexOf('--system-prompt'), 2, '--system-prompt-file', call.args[call.args.indexOf('--system-prompt-file') + 1]);
  assert.deepEqual(call.args, expected);
  assert.deepEqual(await workdirEntries(), before, 'the system prompt file is removed after the run');
});

test('on Windows a claude only cmd.exe could run is refused, and nothing is left behind', async () => {
  let spawned = 0;
  const runClaude = createSpawnRunner({
    claudeBin: 'claude',
    platform: 'win32',
    resolveCommand: () => { throw Object.assign(new Error('C:\\tools\\claude.bat is a batch file'), { code: 'ESHELL' }); },
    spawnFn: () => { spawned += 1; },
  });
  const before = await workdirEntries();
  const invocation = hostileInvocation();
  await assert.rejects(runClaude({ args: invocation.args, prompt: invocation.prompt }), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /Failed to start claude: .*batch file/);
    return true;
  });
  assert.equal(spawned, 0);
  assert.deepEqual(await workdirEntries(), before);
});

test('off Windows the spawn is what it always was: the same args, on the command line', async () => {
  const invocation = hostileInvocation();
  const calls = [];
  const runClaude = createSpawnRunner({
    claudeBin: 'claude',
    platform: 'darwin',
    resolveCommand: () => { throw new Error('not consulted off Windows'); },
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return spawn('sh', ['-c', 'cat >/dev/null; printf \'{"type":"result","is_error":false,"result":"ok"}\''], options);
    },
  });
  await runClaude({ args: invocation.args, prompt: invocation.prompt });
  assert.equal(calls[0].file, 'claude');
  assert.equal(calls[0].args, invocation.args, 'the very same array');
  assert.deepEqual(Object.keys(calls[0].options), ['cwd', 'env', 'stdio']);
  assert.equal(argValue(calls[0].args, '--system-prompt'), invocation.systemPrompt);
});

test('stageSystemPrompt leaves arguments without a system prompt alone', async () => {
  const args = ['-p', '--model', 'claude-opus-5-5'];
  const staged = await stageSystemPrompt(args);
  assert.equal(staged.args, args);
  assert.equal(staged.file, null);
  await staged.cleanup();
});
