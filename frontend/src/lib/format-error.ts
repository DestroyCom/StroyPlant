import { describeError, type ErrorContext } from './describe-error';

// Every mutation/query error display in this app funnels through this instead of a bare
// `error.message`. A known technical error (BLE failure, proxy HTML page) becomes the same clear
// French text the history uses; anything else is shown unchanged, because in a toast an
// unrecognized message is almost always one of our own backend messages, already readable (e.g.
// "Un appareil avec cette adresse existe déjà") — replacing it with "Erreur inattendue" would be a
// regression. Pure on purpose (no logging): it runs during render, and the raw text stays
// available in the thrown error / network tab. `context` picks the advice (default `action`;
// `watering` for the water mutation, whose failure is not retried automatically).
export function getErrorMessage(error: unknown, context: ErrorContext = 'action'): string {
  const raw = error instanceof Error ? error.message : String(error);
  const described = describeError(raw, context);
  if (!described.known) return raw;
  return described.hint ? `${described.message} ${described.hint}` : described.message;
}
