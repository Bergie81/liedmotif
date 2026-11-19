// @vitest-environment jsdom
import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_PROVIDERS } from '@/lib/providers/configurable-providers';
import { CredentialMutationGroup } from './credential-mutation-group';
import { useCredentialEditor, type CredentialEditorProps } from './use-credential-editor';

const saved: Record<string, unknown>[] = [];

beforeEach(() => {
  saved.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      saved.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderEditor(props: Partial<CredentialEditorProps>) {
  return renderHook(
    () =>
      useCredentialEditor({
        providerType: 'music',
        options: [{ value: 'suno', label: 'Suno', needsKey: true, needsBaseUrl: true }],
        initialProviderKey: 'suno',
        currentMasked: null,
        configured: true,
        databaseWritesEnabled: true,
        onSaved: () => {},
        ...props,
      }),
    {
      wrapper: ({ children }) => React.createElement(CredentialMutationGroup, null, children),
    },
  );
}

async function saveKey(editor: ReturnType<typeof renderEditor>) {
  act(() => editor.result.current.setSecret('new-key'));
  await act(() => editor.result.current.save());
}

describe('credential editor save', () => {
  // The field shows the effective value, which may come from `.env`; storing it
  // would let it outrank the provider default after the env line is removed.
  it('leaves an untouched base URL and cover model out of a key-only save', async () => {
    await saveKey(renderEditor({ initialBaseUrl: 'https://proxy.example' }));
    await saveKey(
      renderEditor({
        providerType: 'image',
        options: IMAGE_PROVIDERS,
        initialProviderKey: IMAGE_PROVIDERS[0]!.value,
        showModel: true,
        initialModel: IMAGE_PROVIDERS[0]!.defaultModel,
      }),
    );
    expect(saved.map(({ baseUrl, model }) => ({ baseUrl, model }))).toEqual([
      { baseUrl: undefined, model: undefined },
      { baseUrl: undefined, model: undefined },
    ]);
  });

  it('a field set in .env cannot be typed over, and locks only that field', async () => {
    const editor = renderEditor({
      initialBaseUrl: 'https://env.example',
      envLocks: {
        suno: { baseUrl: { variable: 'SUNO_BASE_URL', value: 'https://env.example' } },
      },
    });
    expect(editor.result.current.locks).toEqual({
      baseUrl: { variable: 'SUNO_BASE_URL', value: 'https://env.example' },
    });
    act(() => editor.result.current.setBaseUrl('https://typed.example'));
    await saveKey(editor);
    expect(saved[0]).toMatchObject({ secret: 'new-key' });
    expect(saved[0]).not.toHaveProperty('baseUrl');
  });

  it('sends no key while .env sets it, and still sends a base URL .env leaves unset', async () => {
    const editor = renderEditor({ envLocks: { suno: { apiKey: { variable: 'SUNO_API_KEY' } } } });
    act(() => editor.result.current.setBaseUrl('https://typed.example'));
    await saveKey(editor);
    expect(saved[0]).toMatchObject({ baseUrl: 'https://typed.example' });
    expect(saved[0]).not.toHaveProperty('secret');
  });

  it('locks a field only for the provider .env sets it for', async () => {
    const editor = renderEditor({
      providerType: 'image',
      options: IMAGE_PROVIDERS,
      initialProviderKey: IMAGE_PROVIDERS[0]!.value,
      showModel: true,
      envLocks: { [IMAGE_PROVIDERS[1]!.value]: { model: { variable: 'IMAGE_MODEL', value: 'm' } } },
    });
    expect(editor.result.current.locks).toEqual({});
    act(() => editor.result.current.selectProvider(IMAGE_PROVIDERS[1]!.value));
    expect(editor.result.current.locks.model?.variable).toBe('IMAGE_MODEL');
  });

  it('sends a base URL the owner changed or cleared', async () => {
    const changed = renderEditor({ initialBaseUrl: 'https://proxy.example' });
    act(() => changed.result.current.setBaseUrl('https://other.example'));
    await saveKey(changed);
    const cleared = renderEditor({ initialBaseUrl: 'https://proxy.example' });
    act(() => cleared.result.current.setBaseUrl(''));
    await saveKey(cleared);
    expect(saved.map(({ baseUrl }) => baseUrl)).toEqual(['https://other.example', '']);
  });
});
