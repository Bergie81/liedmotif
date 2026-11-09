// The Assistant: the in-app chat that answers questions about Liedmotif. The
// conversation lives in the browser and travels whole with each request; the
// reply comes back as a stream of events. A request that is refused before a
// reply starts gets the ordinary error response instead.

import { z } from 'zod';
import { errorResponseSchema } from './common';

/** How much of a conversation one request carries; the client drops older messages. */
export const ASSISTANT_MAX_MESSAGES = 12;

/**
 * Characters per message. It bounds what the user can type, and a client clips
 * an earlier answer to it before sending the conversation back.
 */
export const ASSISTANT_MAX_MESSAGE_LENGTH = 4000;

export const assistantMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  /** Plain text or Markdown. */
  content: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_LENGTH),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantRequestSchema = z.strictObject({
  /** Oldest first, ending with the message to answer. */
  messages: z
    .array(assistantMessageSchema)
    .min(1)
    .max(ASSISTANT_MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === 'user', {
      message: 'The last message must be from the user.',
    }),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

/**
 * A reply is a server-sent event stream: proxies pass that content type through
 * unbuffered, so the answer appears as it is written.
 */
export const ASSISTANT_STREAM_CONTENT_TYPE = 'text/event-stream';

/**
 * One event of a reply stream. `text` events carry the answer's Markdown in
 * order; appending them gives the whole answer. The stream then ends with
 * exactly one of `done` (the answer is complete) or `error` (it broke off, in
 * the shape every API error has). A stream that ends with neither lost its
 * connection.
 */
export const assistantStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('done') }),
  z.strictObject({ type: z.literal('error'), error: errorResponseSchema.shape.error }),
]);
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;

/** An event as it travels: one `data:` line of JSON, closed by a blank line. */
export function encodeAssistantStreamEvent(event: AssistantStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const EVENT_END = '\n\n';
const DATA_PREFIX = 'data: ';

/**
 * Reads a reply stream back into its events. The network cuts the stream
 * wherever it likes, so `push` takes each piece of text as it arrives and
 * returns the events that piece completed; the start of an unfinished event
 * waits for the next one. A block that is not a `data:` line is passed over. A
 * `data:` line that is not one of the three events throws: the stream is not a
 * reply.
 */
export function createAssistantStreamDecoder(): {
  push(chunk: string): AssistantStreamEvent[];
} {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const events: AssistantStreamEvent[] = [];
      let end = pending.indexOf(EVENT_END);
      while (end !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + EVENT_END.length);
        if (block.startsWith(DATA_PREFIX)) {
          events.push(
            assistantStreamEventSchema.parse(JSON.parse(block.slice(DATA_PREFIX.length))),
          );
        }
        end = pending.indexOf(EVENT_END);
      }
      return events;
    },
  };
}

/**
 * What the model passes to `readDocs`, the one tool it has: which section of
 * the user docs to load. Lenient about extra keys — a small model adds them.
 */
export const readDocsInputSchema = z.object({
  page: z.string().describe('The page slug from the docs index, for example "members".'),
  section: z
    .string()
    .describe(
      'A section heading listed under that page, or "intro" for the text before its first heading.',
    ),
});
export type ReadDocsInput = z.infer<typeof readDocsInputSchema>;
