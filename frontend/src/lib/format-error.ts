// A slow BLE mutation can exceed an intermediate reverse-proxy's own timeout, which returns its
// own HTML error page instead of the real backend response — the tRPC client then fails to
// JSON.parse it, surfacing as a raw `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// SyntaxError. Detected by the literal `<!DOCTYPE` the browser always quotes back in that
// SyntaxError, regardless of exact wording. Deliberately generic — no infrastructure detail here,
// see the private ops notes for the real timeout chain this was found against.
const PROXY_TIMEOUT_PATTERN = /<!doctype/i;

const PROXY_TIMEOUT_MESSAGE =
  "Le serveur met trop de temps à répondre (délai dépassé au niveau du proxy). L'opération est peut-être quand même en cours ou déjà terminée côté appareil — vérifie avant de réessayer.";

// Every mutation error display in this app funnels through this instead of a bare `error.message`,
// so the proxy-timeout case above never shows raw HTML/JSON-parse noise to the user.
export function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return PROXY_TIMEOUT_PATTERN.test(raw) ? PROXY_TIMEOUT_MESSAGE : raw;
}
