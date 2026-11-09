// `POST /api/assistant` → the Assistant's answer to a conversation, streamed as
// it is written.
//
// A request refused before an answer starts gets the ordinary error response.
// That includes a text LLM that fails before it writes anything: the first
// chunk is awaited before the response begins, so the usual failures — a
// provider that is down, a rejected key, a model that says nothing — still
// carry a status. Past that point the response is an event stream, and a
// failure arrives as its last event.

import { NextResponse } from 'next/server';
import { ProviderError } from '@liedmotif/providers';
import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantRequestSchema,
  createLogger,
  encodeAssistantStreamEvent,
  makeApiError,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import { apiError, apiRateLimited, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { streamAssistantAnswer } from '@/lib/assistant/reply';
import { getLlmProvider } from '@/lib/providers';
import { assistantLimiter } from '@/lib/request-limits';

export const dynamic = 'force-dynamic';

const logger = createLogger({ name: 'assistant' });

/**
 * What the user is told when the answer failed. Only a `ProviderError` is
 * written for users; anything else gets a fixed line. The log gets the cause
 * and never the conversation.
 */
function failureMessage(err: unknown): string {
  if (err instanceof ProviderError) {
    logger.warn('Assistant reply failed', { providerErrorName: err.name, ...err.safeDetail });
    return err.message;
  }
  logger.error('Assistant reply failed', {
    errorName: err instanceof Error ? err.name : typeof err,
  });
  return 'The Assistant could not answer. Try again.';
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(request, assistantRequestSchema, 'Invalid Assistant request.');
  if (body instanceof NextResponse) return body;

  const llm = await getLlmProvider();
  if (!llm) {
    return apiError(
      'assistant_unavailable',
      'The Assistant is not available: no Writing AI is set up.',
    );
  }

  // The last gate, so a request that reaches no model spends none of the budget.
  const burst = assistantLimiter.check(ownerUserId);
  if (!burst.allowed) return apiRateLimited(burst.retryAfterMs);

  // Two ways the reader leaves: the request is dropped before the answer
  // starts, or the response stream is cancelled once it has. Either stops the
  // model call, so an answer nobody reads costs nothing more.
  const reading = new AbortController();
  const stopped = AbortSignal.any([request.signal, reading.signal]);
  const chunks = streamAssistantAnswer(llm, body.messages, stopped)[Symbol.asyncIterator]();
  let first: IteratorResult<string>;
  try {
    first = await chunks.next();
  } catch (err) {
    // The reader left before the answer started. Nothing failed, so nothing is
    // logged, and nobody reads this response: 499 is "client closed request".
    if (stopped.aborted) return new Response(null, { status: 499 });
    return apiError('provider_error', failureMessage(err), { retryable: true });
  }
  if (first.done) {
    return apiError('provider_error', 'The Writing AI gave no answer. Try again.', {
      retryable: true,
    });
  }

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: AssistantStreamEvent,
  ) => controller.enqueue(encoder.encode(encodeAssistantStreamEvent(event)));
  let next: IteratorResult<string> = first;
  const events = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next.done) {
        send(controller, { type: 'done' });
        controller.close();
        return;
      }
      send(controller, { type: 'text', text: next.value });
      try {
        next = await chunks.next();
      } catch (err) {
        // Nobody is reading. Erroring a cancelled stream does nothing; one that
        // is somehow still open must not close as if the answer were whole.
        if (stopped.aborted) return controller.error(err);
        const { error } = makeApiError('provider_error', failureMessage(err), true);
        send(controller, { type: 'error', error });
        controller.close();
      }
    },
    cancel() {
      reading.abort();
    },
  });
  return new Response(events, {
    headers: {
      'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE,
      // `no-transform` keeps a proxy from compressing the stream, which would
      // hold the answer back until its buffer fills.
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
