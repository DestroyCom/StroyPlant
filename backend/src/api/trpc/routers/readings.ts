import { on } from 'node:events';
import { type ReadingEvent, readingsEmitter } from '../readingsEmitter.js';
import { protectedProcedure, router } from '../trpc.js';

export const readingsRouter = router({
  // Replaces the raw WebSocket push on /ws (api/ws.ts) — same "no polling" requirement
  // (docs/STROYPLANT_SPEC.md section 6), now carried by a tRPC subscription instead.
  onReading: protectedProcedure.subscription(async function* (opts) {
    for await (const [event] of on(readingsEmitter, 'reading', { signal: opts.signal })) {
      yield event as ReadingEvent;
    }
  }),
});
