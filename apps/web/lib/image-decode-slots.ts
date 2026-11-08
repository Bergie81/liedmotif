// One bound on how many uploaded images the web process decodes at once.
// `sharp.concurrency(1)` (instrumentation.ts) limits the THREADS one operation
// spends, not the number of operations in flight, so without this every
// simultaneous upload holds a full-size decode buffer at the same moment. The
// counter is per process rather than per route: the resource being protected is
// the heap, which no single upload surface owns.
//
// It queues without a waiter cap, and can: nothing reaches it without first
// holding an upload admission slot (`request-admission.ts`), so the queue is
// bounded by that ceiling rather than by the internet.

import { Semaphore } from '@liedmotif/shared';

/** Matches the cover-rendition route's bound — the same decoder, same process. */
const uploadDecodeSlots = new Semaphore(3);

/** Run an upload's sharp pipeline in one of the process's decode slots. */
export function withUploadDecodeSlot<T>(decode: () => Promise<T>): Promise<T> {
  return uploadDecodeSlots.run(decode);
}
