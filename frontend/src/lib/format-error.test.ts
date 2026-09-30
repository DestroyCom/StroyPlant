import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROXY_TIMEOUT_MESSAGE } from './describe-error.ts';
import { getErrorMessage } from './format-error.ts';

describe('getErrorMessage', () => {
  it('keeps our own backend messages unchanged (not a known technical pattern)', () => {
    assert.equal(getErrorMessage(new Error('Un appareil avec cette adresse existe déjà')), 'Un appareil avec cette adresse existe déjà');
  });

  it('translates a known technical error, with the generic action hint', () => {
    assert.equal(
      getErrorMessage(new Error('le-connection-abort-by-local')),
      "La connexion Bluetooth avec l'appareil a été coupée en cours de route (souvent un signal faible ou des interférences). Réessaie dans un instant.",
    );
  });

  it('keeps the proxy HTML error page case working', () => {
    assert.equal(getErrorMessage(new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)), PROXY_TIMEOUT_MESSAGE);
  });

  it('accepts a non-Error value', () => {
    assert.equal(getErrorMessage('plain string'), 'plain string');
  });
});
