// @vitest-environment jsdom

// Settings › Providers: Cover images on the Text AI's vendor use the Text AI's
// key instead of asking for it again. The card says so inline in place of the
// key field, offers an own key, and offers to go back to the shared key.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_PROVIDERS } from '@/lib/configurable-providers';
import { COVER_KEY_NOTICE } from '@/lib/provider-settings-model';
import { shownToasts, toast } from '@/lib/toast';
import { CredentialEditor } from './credential-editor';
import { CredentialMutationGroup } from './credential-mutation-group';
import { StoredLlmCredentialAction } from './stored-llm-credential-action';
import { ProviderCard } from './provider-card';

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answers every request with a refused save, and records the bodies sent. */
function stubFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: false, error: 'Refused.' }, { status: 400 });
    }),
  );
  return bodies;
}

/** Renders the card's editor the way the Providers page does: a shared key is not its own. */
function renderCoverEditor({
  currentMasked,
  sharesKey,
  ...props
}: {
  initialProviderKey: string;
  currentMasked: string | null;
  sharesKey: boolean;
  sharedKeyVendor: string | null;
}) {
  render(
    h(
      CredentialMutationGroup,
      null,
      h(CredentialEditor, {
        providerType: 'image',
        options: IMAGE_PROVIDERS,
        currentMasked: sharesKey ? null : currentMasked,
        configured: currentMasked !== null,
        databaseWritesEnabled: true,
        ...props,
      }),
    ),
  );
}

const keyField = () => screen.queryByPlaceholderText('sk-…');

async function saveAndReadBody(bodies: Array<Record<string, unknown>>) {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  return bodies[0]!;
}

describe('Cover images card — shared key', () => {
  it('shows "Uses your OpenAI key" instead of a key field while it shares the key', async () => {
    const bodies = stubFetch();
    renderCoverEditor({
      initialProviderKey: 'openai',
      currentMasked: '••••9876',
      sharesKey: true,
      sharedKeyVendor: 'openai',
    });

    expect(screen.getByText('Uses your OpenAI key')).toBeTruthy();
    expect(keyField()).toBeNull();

    const body = await saveAndReadBody(bodies);
    expect(body).toMatchObject({ providerType: 'image', providerKey: 'openai' });
    expect(body.shareTextLlmKey).toBe(true);
    expect(body.secret).toBeUndefined();
  });

  it('tests the shared key by reference when switched to it over an own key', async () => {
    const bodies = stubFetch();
    renderCoverEditor({
      initialProviderKey: 'openai',
      currentMasked: '••••9876',
      sharesKey: false,
      sharedKeyVendor: 'openai',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use the same OpenAI key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies[0]).toMatchObject({ providerType: 'image', shareTextLlmKey: true });
    expect(bodies[0]!.secret).toBeUndefined();
  });

  it('offers an own key in place of the shared one', async () => {
    const bodies = stubFetch();
    renderCoverEditor({
      initialProviderKey: 'openai',
      currentMasked: '••••9876',
      sharesKey: true,
      sharedKeyVendor: 'openai',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use a separate key' }));
    fireEvent.change(keyField()!, { target: { value: 'sk-proj-image' } });

    const body = await saveAndReadBody(bodies);
    expect(body.secret).toBe('sk-proj-image');
    expect(body.shareTextLlmKey).toBeUndefined();
  });

  it('offers "Use the same Gemini key" beside an own key, and saves the switch', async () => {
    const bodies = stubFetch();
    renderCoverEditor({
      initialProviderKey: 'gemini',
      currentMasked: '••••4321',
      sharesKey: false,
      sharedKeyVendor: 'gemini',
    });

    expect(keyField()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use the same Gemini key' }));
    expect(screen.getByText('Uses your Gemini key')).toBeTruthy();
    expect(keyField()).toBeNull();

    expect(await saveAndReadBody(bodies)).toMatchObject({ shareTextLlmKey: true });
  });

  it('asks for a key on another vendor than the Text AI', () => {
    stubFetch();
    renderCoverEditor({
      initialProviderKey: 'openai',
      currentMasked: '••••9876',
      sharesKey: true,
      sharedKeyVendor: 'openai',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Gemini' }));

    expect(keyField()).toBeTruthy();
    expect(screen.queryByText(/Uses your/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Use the same/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(screen.getByText('Uses your OpenAI key')).toBeTruthy();
  });

  it('asks for a key when no Text AI key can be shared', () => {
    stubFetch();
    renderCoverEditor({
      initialProviderKey: 'openai',
      currentMasked: null,
      sharesKey: false,
      sharedKeyVendor: null,
    });

    expect(keyField()).toBeTruthy();
    expect(screen.queryByText(/Uses your/)).toBeNull();
  });
});

describe('Text AI card — while Cover images share its key', () => {
  it('shows the Cover key hint inline, not as a toast', () => {
    render(
      h(ProviderCard, {
        icon: null,
        name: 'OpenAI',
        requirement: 'optional',
        source: 'Database',
        description: 'Used once for each Session request.',
        notice: COVER_KEY_NOTICE,
      }),
    );

    expect(screen.getByText(COVER_KEY_NOTICE)).toBeTruthy();
    expect(shownToasts()).toEqual([]);
  });

  it('carries the same sentence in the disable confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      h(
        CredentialMutationGroup,
        null,
        h(StoredLlmCredentialAction, {
          providerKey: 'openai',
          environmentActive: false,
          coverKeyNotice: COVER_KEY_NOTICE,
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable Text AI' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(COVER_KEY_NOTICE));
  });
});
