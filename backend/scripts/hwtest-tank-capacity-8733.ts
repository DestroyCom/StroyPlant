// One-off, disposable hardware verification script — NOT part of the app, not committed to run in
// CI. Reads the never-before-read 39e1FE05 (UUID_TANK_CAPACITY, "Certain" confidence in
// docs/PARROT_BLE_REVERSE_ENGINEERING.md) characteristic on a real Parrot Pot, to empirically
// confirm what unit/encoding it uses before trusting it for a liters display (spec section 9 —
// "no guessing" rule). Target: pot 8733 (A0:14:3D:CD:87:33), the dedicated no-species-assigned test
// pot, by default — any other Parrot Pot MAC can be passed as the first CLI argument (safe on a
// planted pot too: this script is read-only, it never writes anything). Run only with the production
// `stroyplant` container stopped (shared Bluetooth adapter).
import { createBluetooth } from 'node-ble';
import { CALIBRATION_SERVICE_UUID } from '../src/ble/parrot/uuids.js';

const DEVICE_ID = process.argv[2] ?? 'A0:14:3D:CD:87:33';
const TANK_CAPACITY_CHARACTERISTIC_UUID = '39e1fe05-84a8-11e2-afba-0002a5d5c51b';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    console.log('Waiting for device advertisement...');
    const device = await adapter.waitDevice(DEVICE_ID);
    await adapter.stopDiscovery();

    console.log('Connecting...');
    await device.connect();
    try {
      const gatt = await device.gatt();
      const service = await gatt.getPrimaryService(CALIBRATION_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(TANK_CAPACITY_CHARACTERISTIC_UUID);

      const buffer = await characteristic.readValue();
      console.log(`Raw bytes (${buffer.length}): ${buffer.toString('hex')}`);
      if (buffer.length >= 1) console.log(`As uint8: ${buffer.readUInt8(0)}`);
      if (buffer.length >= 2) console.log(`As uint16 LE: ${buffer.readUInt16LE(0)}`);
      if (buffer.length >= 4) console.log(`As uint32 LE: ${buffer.readUInt32LE(0)} / float32 LE: ${buffer.readFloatLE(0)}`);
    } finally {
      await device.disconnect();
    }
  } finally {
    destroy();
  }
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
