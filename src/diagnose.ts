import { loadBleConfig } from './config/load.js';
import { createLogger } from './logger.js';
import {
  sleep,
  withTimeout,
  errMsg,
  formatMac,
  normalizeUuid,
  POST_DISCOVERY_QUIESCE_MS,
  CONNECT_TIMEOUT_MS,
} from './ble/types.js';

const log = createLogger('Diagnose');

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    log.error('The diagnose tool requires Linux with BlueZ (node-ble).');
    process.exit(1);
  }

  const bleConfig = loadBleConfig();
  const scaleMac = (process.argv[2] ?? bleConfig.scaleMac)?.toUpperCase();

  log.info('BLE Diagnostic Tool (node-ble)\n');
  log.info(`Platform:  ${process.platform} (${process.arch})`);
  log.info(`Handler:   node-ble (BlueZ D-Bus)`);
  if (scaleMac) {
    log.info(`Target MAC: ${scaleMac}`);
  } else {
    log.info('Target MAC: (none)');
    log.info('');
    log.info('Tip: npm run diagnose -- MAC_ADDRESS');
    log.info('  or set scale_mac in config.yaml');
  }
  log.info('');

  const NodeBle = await import('node-ble');
  const { createBluetooth } = NodeBle;
  const { bluetooth, destroy } = createBluetooth();

  try {
    const adapter = await bluetooth.defaultAdapter();
    log.info(`Bluetooth adapter: ${await adapter.getAddress()}\n`);

    // ─── Phase 1: Scan ────────────────────────────────────────────────────────
    log.info('Phase 1: Scanning (15 seconds)');
    log.info('Step on the scale to wake it up.\n');

    await adapter.startDiscovery();
    await sleep(15_000);
    await adapter.stopDiscovery();
    await sleep(POST_DISCOVERY_QUIESCE_MS);

    const devices = await adapter.devices();
    log.info(`Scan complete. Found ${devices.length} device(s).\n`);

    let targetFound = false;
    for (const mac of devices) {
      try {
        const device = await adapter.getDevice(mac);
        const name = await device.getName().catch(() => '(unknown)');
        log.info(`  ${mac}  ${name}`);

        if (scaleMac && formatMac(scaleMac) === mac) {
          targetFound = true;
          log.info(`    ^^^ TARGET DEVICE`);
        }
      } catch {
        log.info(`  ${mac}  (error reading device info)`);
      }
    }

    // ─── Phase 2: Connect ─────────────────────────────────────────────────────
    if (!scaleMac) {
      log.info('\nSet scale_mac or pass MAC as argument to test GATT connection.');
      return;
    }

    if (!targetFound) {
      log.error(`\nTarget device ${scaleMac} was NOT found during scan.`);
      log.info('Make sure the scale is awake (step on it right before scanning).');
      process.exit(1);
    }

    log.info('\nPhase 2: GATT Connection\n');
    log.info(`Connecting to ${scaleMac}...`);

    const device = await adapter.getDevice(formatMac(scaleMac));
    await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, `Connection timed out (${CONNECT_TIMEOUT_MS / 1000}s)`);
    log.info('Connected!\n');

    // ─── Phase 3: GATT Enumeration ────────────────────────────────────────────
    log.info('Phase 3: GATT Services\n');
    log.info('Discovering services...');

    try {
      const gatt = await device.gatt();
      const serviceUuids = await withTimeout(
        gatt.services(),
        30_000,
        'Service discovery timed out (30s)',
      );

      log.info(`Found ${serviceUuids.length} service(s):\n`);

      for (const svcUuid of serviceUuids) {
        log.info(`  Service: ${svcUuid}`);
        try {
          const service = await gatt.getPrimaryService(svcUuid);
          const charUuids = await service.characteristics();
          for (const charUuid of charUuids) {
            const normalized = normalizeUuid(charUuid);
            log.info(`    Char: ${charUuid} (${normalized})`);
            try {
              const char = await service.getCharacteristic(charUuid);
              const flags = await char.getFlags();
              log.info(`      Flags: ${flags.join(', ')}`);
            } catch {
              log.info(`      (could not read flags)`);
            }
          }
        } catch (err: unknown) {
          log.warn(`    (characteristic discovery failed: ${errMsg(err)})`);
        }
      }
    } catch (err: unknown) {
      log.error(`Service discovery failed: ${errMsg(err)}`);
    }

    log.info('');
    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }

    log.info('Diagnostic complete. Share this output when reporting issues.');
  } finally {
    destroy();
  }
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
