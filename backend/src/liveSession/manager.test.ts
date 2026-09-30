import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ConnectionQueue } from '../ble/connectionQueue.js';
import type { DeviceProvider, LiveConnectionHandle } from '../providers/types.js';
import { claimLiveConnectionForWatering, getActiveLiveSession, startLiveSession, stopLiveSession } from './manager.js';

const CONNECT_DELAY_MS = 300;
const SESSION_CUTOFF_MS = 10_000;

const readyHandle: LiveConnectionHandle = { async triggerWatering() {} };

// Stands in for a real BLE provider: the live connection only becomes usable after a connect delay
// (seconds on real hardware), then streams until aborted — and, like node-ble's subscribeLive,
// re-checks the abort signal once connected instead of streaming for nothing.
const slowConnectProvider = {
  async subscribeLive(
    _deviceId: string,
    _kind: string,
    _onSample: unknown,
    signal: AbortSignal,
    onConnectionReady?: (handle: LiveConnectionHandle) => void,
  ) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS));
    if (signal.aborted) return;
    onConnectionReady?.(readyHandle);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
} as unknown as DeviceProvider;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let queue: ConnectionQueue;

afterEach(async () => {
  const active = getActiveLiveSession();
  if (active) stopLiveSession(active.deviceId);
  await queue.run(async () => {});
});

describe('claimLiveConnectionForWatering', () => {
  it('returns the open live connection when it is ready for this device, without stopping the session', async () => {
    queue = new ConnectionQueue();
    startLiveSession('POT-A', 'PARROT_POT', slowConnectProvider, queue, SESSION_CUTOFF_MS);
    await delay(CONNECT_DELAY_MS + 100);

    assert.equal(claimLiveConnectionForWatering('POT-A'), readyHandle);
    assert.equal(getActiveLiveSession()?.deviceId, 'POT-A');
  });

  it('frees the queue quickly when the live session is still connecting (no wait until the session cutoff)', async () => {
    queue = new ConnectionQueue();
    startLiveSession('POT-A', 'PARROT_POT', slowConnectProvider, queue, SESSION_CUTOFF_MS);
    await delay(50);

    assert.equal(claimLiveConnectionForWatering('POT-A'), null);
    const start = Date.now();
    await queue.run(async () => {});
    assert.ok(Date.now() - start < 2000, `watering waited ${Date.now() - start}ms behind the live session`);
  });

  it("stops another device's live session so the watering never queues behind it", async () => {
    queue = new ConnectionQueue();
    startLiveSession('POT-A', 'PARROT_POT', slowConnectProvider, queue, SESSION_CUTOFF_MS);
    await delay(CONNECT_DELAY_MS + 100);

    assert.equal(claimLiveConnectionForWatering('POT-B'), null);
    const start = Date.now();
    await queue.run(async () => {});
    assert.ok(Date.now() - start < 2000, `watering waited ${Date.now() - start}ms behind POT-A's live session`);
  });

  it('returns null and does nothing when no live session is running', () => {
    queue = new ConnectionQueue();
    assert.equal(claimLiveConnectionForWatering('POT-A'), null);
    assert.equal(getActiveLiveSession(), null);
  });
});
