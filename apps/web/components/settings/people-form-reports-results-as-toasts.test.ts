// @vitest-environment jsdom

// Settings → People (and onboarding's People step, which renders the same form)
// reports what an add, a save, a delete or a photo removal did as a toast, so
// nothing on the page moves. Field errors stay under their fields.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { PeopleForm } from './people-form';
import type { PersonEditorValue } from './people-types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OWNER: PersonEditorValue = {
  id: 'owner',
  role: 'owner',
  name: 'Thomas',
  about: '',
  photos: [{ id: 'photo-1', imageUrl: '/photo-1.jpg' }] as PersonEditorValue['photos'],
};
const FRIEND: PersonEditorValue = {
  id: 'friend',
  role: 'ordinary',
  name: 'Lisa',
  about: '',
  photos: [],
};

function renderForm(people: PersonEditorValue[] = [OWNER, FRIEND]) {
  render(
    h(PeopleForm, {
      initialPeople: people,
      initialFrequency: 'never',
      maxPeople: 6,
      maxNameLength: 120,
      maxAboutLength: 2_000,
      maxPhotosPerPerson: 3,
      maxPhotosTotal: 18,
    }),
  );
}

/** Answers each request in turn with the next of `answers`. */
function stubAnswers(...answers: Array<{ status: number; body: unknown }>) {
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const answer = queue.shift() ?? { status: 500, body: {} };
      return Response.json(answer.body, { status: answer.status });
    }),
  );
}

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

function card(name: string) {
  return screen.getByText(name, { selector: 'span' }).closest('div.mb-3') as HTMLElement;
}

async function addPerson(name: string) {
  if (!screen.queryByRole('button', { name: 'Cancel' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Add Person' }));
  }
  fireEvent.change(screen.getAllByLabelText(/^Name/).at(-1)!, { target: { value: name } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Add Person' }).at(-1)!);
}

describe('People form — results as toasts', () => {
  it('reports an added Person as a success toast', async () => {
    stubAnswers({
      status: 200,
      body: { person: { id: 'new', role: 'ordinary', name: 'Mara', about: '' } },
    });
    renderForm([OWNER]);

    await addPerson('Mara');

    await waitFor(() => expect(shown()).toEqual([{ tone: 'success', message: 'Mara added.' }]));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a failed add as one error toast that a successful retry clears', async () => {
    stubAnswers(
      { status: 400, body: { error: 'That name is taken.' } },
      { status: 200, body: { person: { id: 'new', role: 'ordinary', name: 'Mara', about: '' } } },
    );
    renderForm([OWNER]);

    await addPerson('Mara');
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'That name is taken.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
    await addPerson('Mara');

    await waitFor(() => expect(shown()).toEqual([{ tone: 'success', message: 'Mara added.' }]));
  });

  it('reports a saved Person and a failed delete as toasts', async () => {
    stubAnswers(
      {
        status: 200,
        body: { person: { id: 'friend', role: 'ordinary', name: 'Lisa', about: '' } },
      },
      { status: 500, body: { error: { message: 'Storage offline.' } } },
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderForm();

    fireEvent.click(within(card('Lisa')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(shown()).toEqual([{ tone: 'success', message: 'Lisa saved.' }]));
    fireEvent.click(within(card('Lisa')).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(shown()).toContainEqual({ tone: 'error', message: 'Storage offline.' }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a failed photo removal as an error toast', async () => {
    stubAnswers({ status: 500, body: { error: 'The photo is in use.' } });
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Thomas reference photo' }));

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'The photo is in use.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports the saved cover fallback as a success toast', async () => {
    stubAnswers({ status: 200, body: {} });
    renderForm();

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'success', message: 'Cover fallback saved.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});
