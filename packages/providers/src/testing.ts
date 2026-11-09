// Test-only surface of `@liedmotif/providers` (the `@liedmotif/providers/testing`
// subpath, mirroring `@liedmotif/db/testing`). Never imported by runtime code.

import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type { EmailMessage, EmailSender } from './email/index';

/**
 * The sanitized Suno API fixtures, so OTHER packages' integration suites (the
 * worker poll/pipeline tests) can drive the real adapter through an injected
 * `fetch` with the captured shapes — no test ever touches the network.
 */
export * as sunoFixtures from './music/suno.fixtures';

/** An `EmailSender` that keeps every mail instead of sending it. */
export function recordingEmailSender(): EmailSender & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ ...message });
    },
  };
}

/** What a scripted model streams back for one model call. */
export type ScriptedModelStep =
  /** `say` is text the model writes before it calls. */
  | { toolCalls: Array<{ name: string; input: unknown }>; say?: string }
  /**
   * `thenFail` breaks the stream after the text, as a provider that drops
   * mid-answer does; `thenHang` leaves it open until the call is aborted.
   */
  | { text: string[]; thenFail?: Error; thenHang?: true }
  /** The call itself is refused, before anything streams. */
  | { fail: Error }
  /** The model never answers: the call ends only when it is aborted. */
  | { hang: true };

const SCRIPTED_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A language model for the text-LLM adapter's `languageModel` option that
 * replays one scripted step per model call (the last one repeats), so a
 * tool-calling exchange runs without a network. Its `doStreamCalls` hold what
 * each call was sent.
 */
export function scriptedLanguageModel(steps: ScriptedModelStep[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[Math.min(call, steps.length - 1)]!;
      call += 1;
      if ('fail' in step) throw step.fail;
      if ('hang' in step) {
        return new Promise((_, reject) => {
          if (abortSignal?.aborted) reject(abortSignal.reason);
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
        });
      }
      const finish = (unified: 'stop' | 'tool-calls') =>
        ({
          type: 'finish',
          finishReason: { unified, raw: undefined },
          usage: SCRIPTED_USAGE,
        }) as const;
      if ('toolCalls' in step) {
        return {
          stream: convertArrayToReadableStream([
            ...(step.say
              ? ([
                  { type: 'text-start', id: 'text' },
                  { type: 'text-delta', id: 'text', delta: step.say },
                  { type: 'text-end', id: 'text' },
                ] as const)
              : []),
            ...step.toolCalls.map(
              (toolCall, index) =>
                ({
                  type: 'tool-call',
                  toolCallId: `call-${call}-${index}`,
                  toolName: toolCall.name,
                  input: JSON.stringify(toolCall.input),
                }) as const,
            ),
            finish('tool-calls'),
          ]),
        };
      }
      const written = [
        { type: 'text-start', id: 'text' } as const,
        ...step.text.map((delta) => ({ type: 'text-delta', id: 'text', delta }) as const),
      ];
      if (step.thenHang) {
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of written) controller.enqueue(part);
              abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason));
            },
          }),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          ...written,
          ...(step.thenFail
            ? [{ type: 'error', error: step.thenFail } as const]
            : [{ type: 'text-end', id: 'text' } as const, finish('stop')]),
        ]),
      };
    },
  });
}
