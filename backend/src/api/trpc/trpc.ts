import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create({
  // tRPC's own default shape includes error.stack — never useful to a client, and reveals file
  // paths/internal structure to anyone hitting a procedure that throws.
  errorFormatter: ({ shape }) => ({ ...shape, data: { ...shape.data, stack: undefined } }),
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Direct port of requireAuth (backend/src/auth/session.ts) — every route/subscription outside
// /api/auth/* must never be exposed without protection (docs/STROYPLANT_SPEC.md section 7.6, same
// requirement for the future MCP server in Batch 8).
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});
