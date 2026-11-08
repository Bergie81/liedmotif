import { describe, expect, it } from 'vitest';
import { createCoverArtworkFinalizer } from './cover-artwork-finalizer';

const okEvaluate = async () => ({ ok: true as const, width: 1024, height: 1024 });
const squareMeasure = async () => ({ width: 1024, height: 1024 });

describe('createCoverArtworkFinalizer', () => {
  it('stores exactly the normalized rendition — no badge composite touches it', async () => {
    const normalized: Uint8Array[] = [];
    const finalizer = createCoverArtworkFinalizer({
      evaluate: okEvaluate,
      normalize: async (bytes) => {
        normalized.push(bytes);
        return new Uint8Array([2]);
      },
      measure: squareMeasure,
    });

    const finished = await finalizer.finish({ bytes: new Uint8Array([0]) });
    expect(finished).toEqual({ ok: true, bytes: new Uint8Array([2]), mediaType: 'image/webp' });
    expect(normalized).toEqual([new Uint8Array([0])]);
  });

  it('fails finalization when the pipeline throws', async () => {
    const finalizer = createCoverArtworkFinalizer({
      evaluate: okEvaluate,
      normalize: async () => {
        throw new Error('pipeline unavailable');
      },
      measure: squareMeasure,
    });

    const finished = await finalizer.finish({ bytes: new Uint8Array([0]) });
    expect(finished).toEqual({ ok: false, reason: 'normalization_rejected' });
  });

  it('rejects a pipeline output that is not square', async () => {
    const finalizer = createCoverArtworkFinalizer({
      evaluate: okEvaluate,
      normalize: async (bytes) => bytes,
      measure: async () => ({ width: 1024, height: 768 }),
    });

    const finished = await finalizer.finish({ bytes: new Uint8Array([0]) });
    expect(finished).toEqual({ ok: false, reason: 'normalization_rejected' });
  });

  it('never normalizes artwork the quality gate rejected', async () => {
    let normalized = false;
    const finalizer = createCoverArtworkFinalizer({
      evaluate: async () => ({ ok: false as const, reason: 'blank' as const }),
      normalize: async (bytes) => {
        normalized = true;
        return bytes;
      },
      measure: squareMeasure,
    });

    const finished = await finalizer.finish({ bytes: new Uint8Array([0]) });
    expect(finished).toEqual({ ok: false, reason: 'blank' });
    expect(normalized).toBe(false);
  });
});
