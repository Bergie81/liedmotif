import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installProcessErrorHandlers } from './process-lifecycle';

// Defense-in-depth wiring: a stray rejection must reach the structured logger
// and leave the process serving, while an exception must still take it down.

describe('installProcessErrorHandlers', () => {
  it('logs an unhandled rejection and keeps the process running', () => {
    const emitter = new EventEmitter();
    const logError = vi.fn();
    const exit = vi.fn();
    installProcessErrorHandlers({ emitter, logError, exit });

    emitter.emit('unhandledRejection', new Error('a void that never caught'));

    expect(logError).toHaveBeenCalledWith(expect.stringContaining('rejection'), {
      err: expect.any(Error),
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs an uncaught exception and exits non-zero for the restart policy', () => {
    const emitter = new EventEmitter();
    const logError = vi.fn();
    const exit = vi.fn();
    installProcessErrorHandlers({ emitter, logError, exit });

    emitter.emit('uncaughtException', new Error('broken invariant'));

    expect(logError).toHaveBeenCalledWith(expect.stringContaining('exception'), {
      err: expect.any(Error),
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
