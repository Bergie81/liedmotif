import { describe, expect, it } from 'vitest';
import {
  beginCredentialTest,
  isCredentialTestResultCurrent,
  listedModels,
  resolveCredentialTest,
} from './credential-test-state';

describe('credential test state', () => {
  it('reports busy and successful provider tests', () => {
    expect(beginCredentialTest()).toEqual({ status: 'busy' });
    expect(
      resolveCredentialTest({ status: 200, body: { ok: true, message: 'Connection verified.' } }),
    ).toEqual({ status: 'success', message: 'Connection verified.' });
  });

  it('lists the models a test discovered', () => {
    expect(
      listedModels({ ok: true, detail: { models: ['qwen3:8b', 'llama3.1:latest', 42] } }),
    ).toEqual(['qwen3:8b', 'llama3.1:latest']);
    // A test that found the host but not the chosen model still offers what is there.
    expect(listedModels({ ok: false, detail: { models: ['qwen3:8b'] } })).toEqual(['qwen3:8b']);
    // A provider that lists nothing offers no picker.
    expect(listedModels({ ok: false })).toEqual([]);
    expect(listedModels({ ok: true, detail: { credits: 42 } })).toEqual([]);
    expect(listedModels({ ok: true })).toEqual([]);
  });

  it('preserves sanitized validation failures', () => {
    expect(
      resolveCredentialTest({
        status: 200,
        body: { ok: false, message: 'The provider rejected these credentials.' },
      }),
    ).toEqual({ status: 'error', message: 'The provider rejected these credentials.' });
  });

  it('distinguishes authentication, rate-limit, and connection failures', () => {
    // The admin guard refuses in the API error envelope: its nested object must
    // be unwrapped to a string, never handed to the renderer as-is.
    expect(
      resolveCredentialTest({
        status: 401,
        body: { ok: false, error: { message: 'Admin sign-in required.' } },
      }),
    ).toEqual({ status: 'error', message: 'Admin sign-in required.' });
    expect(
      resolveCredentialTest({ status: 400, body: { error: 'Unsupported provider.' } }),
    ).toEqual({ status: 'error', message: 'Unsupported provider.' });
    expect(resolveCredentialTest({ status: 429, body: {} })).toEqual({
      status: 'error',
      message: 'Too many attempts — wait a moment.',
    });
    expect(resolveCredentialTest(null)).toEqual({
      status: 'error',
      message: 'Could not reach the server.',
    });
  });

  it('rejects results from a superseded request or provider selection', () => {
    expect(
      isCredentialTestResultCurrent({
        requestId: 2,
        currentRequestId: 2,
        testedProviderKey: 'openai',
        currentProviderKey: 'openai',
      }),
    ).toBe(true);
    expect(
      isCredentialTestResultCurrent({
        requestId: 1,
        currentRequestId: 2,
        testedProviderKey: 'openai',
        currentProviderKey: 'openai',
      }),
    ).toBe(false);
    expect(
      isCredentialTestResultCurrent({
        requestId: 2,
        currentRequestId: 2,
        testedProviderKey: 'openai',
        currentProviderKey: 'ollama',
      }),
    ).toBe(false);
  });
});
