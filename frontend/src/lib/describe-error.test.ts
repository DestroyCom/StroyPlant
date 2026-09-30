import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeError, PROXY_TIMEOUT_MESSAGE } from './describe-error.ts';

// Every raw shape actually stored in production on 2026-09-29 (see the spec's inventory table),
// with real-looking MACs/durations — the table must not depend on them.
const REAL_SHAPES: Array<[string, string]> = [
  ['le-connection-abort-by-local', 'coupée en cours de route'],
  ['TIMEOUT: connect (18000ms)', "n'a pas répondu à la demande de connexion"],
  ['TIMEOUT: gatt (18000ms)', "n'a pas transmis la liste de ses capteurs"],
  ['operation timed out', "n'a pas répondu à la demande de connexion"],
  ['Malformed soilMoisturePercent (fa07) buffer: 1 byte(s), expected 4 (hex=00)', 'réponse incomplète'],
  ['Attempt to access memory outside buffer bounds', 'réponse incomplète'],
  ['Operation already in progress', 'connexion précédente'],
  ['Operation failed with ATT error: 0x0e', 'refusé la lecture'],
  ['br-connection-canceled', "n'a pas répondu à la demande de connexion"],
  ['TIMEOUT: notification LYWSD03MMC (8000ms)', "n'a pas envoyé sa mesure"],
  ['Refusing activation, D-Bus is shutting down.', 'en train de redémarrer'],
];

describe('describeError', () => {
  for (const [raw, expected] of REAL_SHAPES) {
    it(`recognizes "${raw}"`, () => {
      const described = describeError(raw, 'sync');
      assert.equal(described.known, true);
      assert.ok(described.message.includes(expected), described.message);
      assert.equal(described.raw, raw);
    });
  }

  it('ignores a MAC address embedded in the raw text', () => {
    assert.equal(describeError('A0:14:3D:CD:A3:D3: le-connection-abort-by-local', 'sync').known, true);
  });

  it('falls back honestly on an unknown error, without a hint', () => {
    const described = describeError('something nobody has seen before', 'sync');
    assert.deepEqual(described, {
      message: 'Erreur inattendue.',
      hint: null,
      raw: 'something nobody has seen before',
      known: false,
    });
  });

  it('picks the hint from the context', () => {
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'sync').hint, 'Nouvelle tentative automatique au prochain cycle.');
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'watering').hint, "L'arrosage n'a pas eu lieu — tu peux réessayer.");
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'action').hint, 'Réessaie dans un instant.');
  });

  it('adds the server-Bluetooth hint only for connection failures in a sync', () => {
    const serverHint = 'Si ça dure sur tous les appareils, le Bluetooth du serveur est probablement en cause.';
    assert.ok(describeError('le-connection-abort-by-local', 'sync').hint?.endsWith(serverHint));
    assert.ok(describeError('TIMEOUT: connect (18000ms)', 'sync').hint?.endsWith(serverHint));
    assert.ok(!describeError('le-connection-abort-by-local', 'watering').hint?.includes(serverHint));
    assert.ok(!describeError('TIMEOUT: gatt (18000ms)', 'sync').hint?.includes(serverHint));
  });

  it('maps the proxy HTML error page to the existing proxy message, without a separate hint', () => {
    const described = describeError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, 'action');
    assert.equal(described.message, PROXY_TIMEOUT_MESSAGE);
    assert.equal(described.hint, null);
    assert.equal(described.known, true);
  });
});
