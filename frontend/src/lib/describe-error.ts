// Turns a raw technical error (BLE provider message stored in SyncEvent/WateringEvent.errorDetail,
// or a caught tRPC error) into a clear French cause + context-dependent advice — see
// docs/superpowers/specs/2026-09-29-readable-errors-design.md. The database keeps the raw text;
// translation only happens at display time, so existing history is covered with no migration.

export type ErrorContext = 'sync' | 'watering' | 'action';

export interface DescribedError {
  message: string;
  hint: string | null;
  raw: string;
  known: boolean;
}

// A slow BLE mutation can exceed an intermediate reverse-proxy's own timeout, which returns its
// own HTML error page instead of the real backend response — the tRPC client then fails to
// JSON.parse it, surfacing as a raw `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// SyntaxError. Deliberately generic — no infrastructure detail here.
export const PROXY_TIMEOUT_MESSAGE =
  "Le serveur met trop de temps à répondre (délai dépassé au niveau du proxy). L'opération est peut-être quand même en cours ou déjà terminée côté appareil — vérifie avant de réessayer.";

// 'connection' rules get the extra server-Bluetooth hint in a sync context: when every device
// fails that way at once, the server's Bluetooth stack is the likely culprit (2026-09-28 BlueZ
// incident). 'proxy' carries its own advice inside its message.
type RuleKind = 'connection' | 'device' | 'proxy';

interface Rule {
  pattern: RegExp;
  message: string;
  kind: RuleKind;
}

// Ordered — the first match wins, so variable MACs/durations in the raw text never matter.
const RULES: Rule[] = [
  { pattern: /<!doctype/i, message: PROXY_TIMEOUT_MESSAGE, kind: 'proxy' },
  {
    pattern: /le-connection-abort-by-local/i,
    message: "La connexion Bluetooth avec l'appareil a été coupée en cours de route (souvent un signal faible ou des interférences).",
    kind: 'connection',
  },
  {
    pattern: /TIMEOUT: connect|operation timed out|br-connection-canceled/i,
    message: "L'appareil n'a pas répondu à la demande de connexion (trop loin, piles faibles ou en veille).",
    kind: 'connection',
  },
  {
    pattern: /TIMEOUT: gatt/i,
    message: "L'appareil s'est connecté mais n'a pas transmis la liste de ses capteurs à temps.",
    kind: 'device',
  },
  { pattern: /Operation already in progress/i, message: 'Une connexion précédente à cet appareil était encore en cours.', kind: 'device' },
  { pattern: /Malformed .* buffer|outside buffer bounds/i, message: 'Un capteur a renvoyé une réponse incomplète.', kind: 'device' },
  { pattern: /ATT error/i, message: "L'appareil a refusé la lecture d'un capteur.", kind: 'device' },
  { pattern: /TIMEOUT: notification/i, message: "Le capteur n'a pas envoyé sa mesure à temps.", kind: 'device' },
  { pattern: /D-Bus is shutting down/i, message: 'Le service Bluetooth du serveur était en train de redémarrer.', kind: 'device' },
];

const CONTEXT_HINT: Record<ErrorContext, string> = {
  sync: 'Nouvelle tentative automatique au prochain cycle.',
  watering: "L'arrosage n'a peut-être pas eu lieu — vérifie le pot avant de réessayer.",
  action: 'Réessaie dans un instant.',
};

const SERVER_BLUETOOTH_HINT = 'Si ça dure sur tous les appareils, le Bluetooth du serveur est probablement en cause.';

function hintFor(kind: RuleKind, context: ErrorContext): string | null {
  if (kind === 'proxy') return null;
  const base = CONTEXT_HINT[context];
  return kind === 'connection' && context === 'sync' ? `${base} ${SERVER_BLUETOOTH_HINT}` : base;
}

export function describeError(raw: string, context: ErrorContext): DescribedError {
  const rule = RULES.find((candidate) => candidate.pattern.test(raw));
  if (!rule) return { message: 'Erreur inattendue.', hint: null, raw, known: false };
  return { message: rule.message, hint: hintFor(rule.kind, context), raw, known: true };
}
