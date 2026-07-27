import { env } from '../env.js';
import { createMockProvider } from './mock/index.js';
import { createNobleBridgeProvider } from './noble-bridge/index.js';
import { createNodeBleProvider } from './node-ble/index.js';
import type { DeviceProvider } from './types.js';

export function createDeviceProvider(): DeviceProvider {
  switch (env.bleProvider) {
    case 'mock':
      return createMockProvider();
    case 'noble-bridge':
      return createNobleBridgeProvider();
    case 'node-ble':
      return createNodeBleProvider();
  }
}
