// One-off restore script — puts pot 8733's watering config back to the exact values it had
// before hwtest-watering-config-checksum.ts's test write (confirmed original read:
// plantId=1071 vwcIrrRaw=260 vwcCmdRaw=320 nIrr=384 mode=0, configId=75).
import { buildWateringConfigWriteValues } from '../src/ble/parrot/wateringConfig.js';
import { createNodeBleProvider } from '../src/providers/node-ble/index.js';

const DEVICE_ID = 'A0:14:3D:CD:87:33';

async function main() {
  const provider = createNodeBleProvider();
  const original = {
    plantId: 1071,
    vwcIrrRaw: 260,
    vwcCmdRaw: 320,
    nIrr: 384,
    vwcIrrEcoRaw: 0,
    vwcCmdEcoRaw: 0,
    nIrrEco: 0,
    timeSlotStart: 0,
    timeSlotDuration: 1440,
    vacationStart: 0,
    vacationEnd: 0,
    mode: 0,
  };
  const values = buildWateringConfigWriteValues(original);
  console.log('restoring:', JSON.stringify(values));
  await provider.writeWateringConfig(DEVICE_ID, values);
  console.log('write done, waiting 5s before verifying...');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const readBack = await provider.readWateringConfig(DEVICE_ID);
  console.log('read back:', JSON.stringify(readBack));
  const ok = readBack.vwcIrrRaw === 260 && readBack.vwcCmdRaw === 320 && readBack.configId === 75;
  console.log(`>>> RESTORED: ${ok} <<<`);
  if (!ok) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('FATAL:', error);
    process.exit(1);
  });
