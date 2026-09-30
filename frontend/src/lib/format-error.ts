import { describeError } from './describe-error';

// Every mutation/query error display in this app funnels through this instead of a bare
// `error.message`. A known technical error (BLE failure, proxy HTML page) becomes the same clear
// French text the history uses; anything else is shown unchanged, because in a toast an
// unrecognized message is almost always one of our own backend messages, already readable (e.g.
// "Un appareil avec cette adresse existe déjà") — replacing it with "Erreur inattendue" would be a
// regression. A toast can't hold a collapsible, so the raw text of a translated error goes to the
// console instead.
export function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const described = describeError(raw, 'action');
  if (!described.known) return raw;
  console.error('[error]', raw);
  return described.hint ? `${described.message} ${described.hint}` : described.message;
}
