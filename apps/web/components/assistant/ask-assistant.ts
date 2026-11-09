// One question to the Assistant: the request, and the reply stream read back
// into text. Never throws; an answer that did not arrive whole comes back as
// the line to show the user.

import {
  createAssistantStreamDecoder,
  errorResponseSchema,
  type ApiErrorResponse,
  type AssistantMessage,
  type AssistantRequest,
} from '@liedmotif/shared';
import { OFFLINE_MESSAGE } from '@/lib/api-fetch';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { isOnline, reportServerAnswered, reportServerUnreachable } from '@/lib/online-state';

export type AskOutcome = { ok: true } | { ok: false; notice: string };

const COULD_NOT_ANSWER = `${ASSISTANT_NAME} could not answer. Try again.`;
const BROKE_OFF = 'The connection was lost before the answer was finished. Try again.';

const failed = (notice: string): AskOutcome => ({ ok: false, notice });

/** "40 seconds", "3 minutes": how long a `Retry-After` header asks the user to wait. */
function waitFrom(retryAfter: string | null): string | null {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return seconds === 1 ? '1 second' : `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The line for a request the server refused before any answer. */
function refusalNotice(error: ApiErrorResponse['error'], retryAfter: string | null): string {
  switch (error.code) {
    case 'rate_limited': {
      const wait = waitFrom(retryAfter);
      return `That was a lot of questions at once. Try again in ${wait ?? 'a moment'}.`;
    }
    case 'assistant_unavailable':
      return `${ASSISTANT_NAME} is not available: no Writing AI is set up.`;
    case 'unauthorized':
      return 'You are signed out. Sign in again to keep asking.';
    default:
      return error.message || COULD_NOT_ANSWER;
  }
}

export async function askAssistant(
  messages: AssistantMessage[],
  { signal, onText }: { signal: AbortSignal; onText: (text: string) => void },
): Promise<AskOutcome> {
  if (!isOnline()) return failed(OFFLINE_MESSAGE);
  let response: Response;
  try {
    response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages } satisfies AssistantRequest),
      signal,
    });
    reportServerAnswered();
  } catch {
    if (!signal.aborted) reportServerUnreachable();
    return failed('Could not reach the server. Try again.');
  }

  if (!response.ok || !response.body) {
    const refusal = errorResponseSchema.safeParse(await response.json().catch(() => null));
    return failed(
      refusal.success
        ? refusalNotice(refusal.data.error, response.headers.get('Retry-After'))
        : COULD_NOT_ANSWER,
    );
  }

  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  const decoder = createAssistantStreamDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // The stream closed without saying the answer was complete.
      if (done) return failed(BROKE_OFF);
      for (const event of decoder.push(utf8.decode(value, { stream: true }))) {
        if (event.type === 'text') onText(event.text);
        else if (event.type === 'done') return { ok: true };
        else return failed(event.error.message || COULD_NOT_ANSWER);
      }
    }
  } catch {
    return failed(BROKE_OFF);
  }
}
