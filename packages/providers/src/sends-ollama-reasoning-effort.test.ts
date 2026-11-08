// The Ollama preset end to end through `buildLlmProvider`: a loopback HTTP
// server stands in for Ollama, so the assertions are about the bytes the real
// SDK model and the pinned transport put on the wire.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildLlmProvider } from './registries';

const SNAPSHOT_JSON = JSON.stringify({
  stylePrompt: 'mellow lofi beats',
  genreTags: ['lofi'],
  vocalMode: 'instrumental',
});

let server: Server;
let baseUrl: string;
let bodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: SNAPSHOT_JSON },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies = [];
});

describe('Ollama reasoning effort', () => {
  it('sends a configured reasoning effort, so a thinking model can be switched off', async () => {
    const provider = buildLlmProvider({
      providerKey: 'ollama',
      model: 'qwen3',
      baseUrl,
      reasoningEffort: 'none',
    });
    await provider!.expandSessionIntent('chill study music');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.reasoning_effort).toBe('none');
  });

  it('sends no reasoning effort unless one is configured', async () => {
    // A model without thinking support may not accept the field.
    const provider = buildLlmProvider({ providerKey: 'ollama', model: 'llama3', baseUrl });
    await provider!.expandSessionIntent('chill study music');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toHaveProperty('reasoning_effort');
  });
});
