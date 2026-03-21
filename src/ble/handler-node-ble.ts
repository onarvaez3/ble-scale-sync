import NodeBle from 'node-ble';
import type { ScaleAdapter, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult, BleSession } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading } from './shared.js';
import {
  bleLog,
  normalizeUuid,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  resetAdapterBtmgmt,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
} from './types.js';

type Device = NodeBle.Device;
type Adapter = NodeBle.Adapter;
type GattCharacteristic = NodeBle.GattCharacteristic;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isDbusConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('ENOENT') && msg.includes('bus_socket');
}

function dbusError(): Error {
  return new Error(
    'Cannot connect to D-Bus — Bluetooth is not accessible.\n' +
      'If running in Docker, mount the D-Bus socket:\n' +
      '  -v /var/run/dbus:/var/run/dbus:ro\n' +
      'On the host, ensure bluetoothd is running:\n' +
      '  sudo systemctl start bluetooth',
  );
}

/** Stop discovery and wait for the post-discovery quiesce period. */
async function stopDiscoveryAndQuiesce(btAdapter: Adapter): Promise<void> {
  try {
    bleLog.debug('Stopping discovery before connect...');
    await btAdapter.stopDiscovery();
    bleLog.debug('Discovery stopped');
  } catch {
    bleLog.debug('stopDiscovery failed (may already be stopped)');
  }
  await sleep(POST_DISCOVERY_QUIESCE_MS);
}

// ─── Discovery helpers ────────────────────────────────────────────────────────

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns the (possibly refreshed) adapter on success, or false if all attempts failed.
 * When `bluetooth` is provided, Tier 4 (btmgmt) can re-acquire a fresh D-Bus proxy
 * after the kernel-level reset invalidates the current one.
 */
async function startDiscoverySafe(
  btAdapter: Adapter,
  bluetooth?: NodeBle.Bluetooth,
): Promise<Adapter | false> {
  // 1. Normal start
  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (another D-Bus client owns the session)
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active (owned by another client), continuing');
    return btAdapter;
  }

  // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
  bleLog.debug('Attempting D-Bus StopDiscovery to reset stale state...');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (btAdapter as any).helper.callMethod('StopDiscovery');
    bleLog.debug('D-Bus StopDiscovery succeeded');
  } catch (e) {
    bleLog.debug(`D-Bus StopDiscovery failed: ${errMsg(e)}`);
  }
  await sleep(1000);

  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after D-Bus reset');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery after D-Bus reset failed: ${errMsg(e)}`);
  }

  // 3. Power-cycle the adapter + retry
  bleLog.debug('Attempting adapter power cycle...');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helper = (btAdapter as any).helper;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Variant } = (await import('dbus-next')) as any;
    await helper.set('Powered', new Variant('b', false));
    bleLog.debug('Adapter powered off');
    await sleep(1000);
    await helper.set('Powered', new Variant('b', true));
    bleLog.debug('Adapter powered on');
    await sleep(1000);

    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after power cycle');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`Power cycle / startDiscovery failed: ${errMsg(e)}`);
  }

  // 4. Kernel-level adapter reset via btmgmt (bypasses D-Bus session ownership)
  bleLog.debug('Attempting kernel-level adapter reset via btmgmt...');
  if (await resetAdapterBtmgmt()) {
    // btmgmt power-cycles the adapter at kernel level, which causes BlueZ to
    // remove and re-create the D-Bus object at /org/bluez/hci0. The existing
    // proxy is now stale — re-acquire a fresh one if possible.
    if (bluetooth) {
      try {
        const freshAdapter = await bluetooth.defaultAdapter();
        await freshAdapter.startDiscovery();
        bleLog.debug('Discovery started after btmgmt reset (fresh adapter)');
        return freshAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
      }
    } else {
      try {
        await btAdapter.startDiscovery();
        bleLog.debug('Discovery started after btmgmt reset');
        return btAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
      }
    }
  }

  // All strategies failed — warn but don't throw
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

/** Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery. */
async function removeDevice(btAdapter: Adapter, mac: string): Promise<void> {
  try {
    const devSerialized = `dev_${formatMac(mac).replace(/:/g, '_')}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterHelper = (btAdapter as any).helper;
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache — expected on first call
  }
}

interface ConnectRecoveryContext {
  btAdapter: Adapter;
  mac: string;
  initialDevice: Device;
  maxRetries: number;
}

/**
 * Connect to a BLE device with recovery for BlueZ-specific failures.
 * On each failed attempt: disconnect → RemoveDevice → re-discover → quiesce → retry.
 * Returns the (possibly refreshed) Device reference.
 */
async function connectWithRecovery(ctx: ConnectRecoveryContext): Promise<Device> {
  let { btAdapter } = ctx;
  const { mac, maxRetries } = ctx;
  const formattedMac = formatMac(mac);
  let device = ctx.initialDevice;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connection timed out');
      bleLog.debug(`Connected (took ${Date.now() - t0}ms)`);
      return device;
    } catch (err: unknown) {
      const msg = errMsg(err);
      if (attempt >= maxRetries) {
        throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
      }

      const delay = 1000 + attempt * 500;
      bleLog.warn(
        `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
      );

      // 1. Disconnect (best-effort)
      try {
        bleLog.debug('Disconnecting before retry...');
        await device.disconnect();
        bleLog.debug('Disconnect OK');
      } catch {
        bleLog.debug('Disconnect failed (ignored)');
      }

      // 2. Purge stale D-Bus proxy
      await removeDevice(btAdapter, mac);

      // 3. Progressive delay
      await sleep(delay);

      // 4. Re-discover and acquire fresh device reference
      try {
        const result = await startDiscoverySafe(btAdapter);
        if (result) btAdapter = result;
        device = await withTimeout(
          btAdapter.waitDevice(formattedMac),
          DISCOVERY_TIMEOUT_MS,
          `Device ${formattedMac} not found during retry`,
        );

        try {
          await btAdapter.stopDiscovery();
        } catch {
          bleLog.debug('stopDiscovery failed during retry (ignored)');
        }
        await sleep(POST_DISCOVERY_QUIESCE_MS);
      } catch (retryErr: unknown) {
        bleLog.debug(`Re-discovery during retry failed: ${errMsg(retryErr)}`);
        // Fallback: try to get device directly without re-discovery
        try {
          device = await btAdapter.getDevice(formattedMac);
        } catch {
          throw new Error(
            `Connection failed and device re-acquisition failed: ${errMsg(retryErr)}`,
          );
        }
      }
    }
  }

  throw new Error('Connection failed');
}

async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
  abortSignal?: AbortSignal,
): Promise<{ device: Device; adapter: ScaleAdapter; mac: string }> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  const checked = new Set<string>();
  let heartbeat = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const addresses: string[] = await btAdapter.devices();

    for (const addr of addresses) {
      if (checked.has(addr)) continue;
      checked.add(addr);

      try {
        const dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        bleLog.debug(`Discovered: ${name} [${addr}]`);

        // Try matching with name only (serviceUuids not available pre-connect on D-Bus).
        // Adapters that require serviceUuids will fail to match here and need SCALE_MAC.
        const info: BleDeviceInfo = { localName: name, serviceUuids: [] };
        const matched = adapters.find((a) => a.matches(info));
        if (matched) {
          bleLog.info(`Auto-discovered: ${matched.name} (${name} [${addr}])`);
          return { device: dev, adapter: matched, mac: addr };
        }
      } catch {
        /* device may have gone away */
      }
    }

    heartbeat++;
    if (heartbeat % 5 === 0) {
      bleLog.info('Still scanning...');
    }
    await sleep(DISCOVERY_POLL_MS);
  }

  throw new Error(`No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`);
}

// ─── BLE abstraction wrappers ─────────────────────────────────────────────────

function wrapChar(char: GattCharacteristic): BleChar {
  return {
    subscribe: async (onData) => {
      char.on('valuechanged', onData);
      await char.startNotifications();
      return () => {
        char.removeListener('valuechanged', onData);
      };
    },
    write: async (data, withResponse) => {
      if (withResponse) {
        await char.writeValue(data);
      } else {
        await char.writeValueWithoutResponse(data);
      }
    },
    read: () => char.readValue(),
  };
}

function wrapDevice(device: Device): BleDevice {
  return {
    onDisconnect: (callback) => {
      device.on('disconnect', callback);
    },
  };
}

// ─── Build charMap from GATT server ───────────────────────────────────────────

async function buildCharMap(gatt: NodeBle.GattServer): Promise<Map<string, BleChar>> {
  const charMap = new Map<string, BleChar>();
  const serviceUuids = await gatt.services();

  for (const svcUuid of serviceUuids) {
    try {
      const service = await gatt.getPrimaryService(svcUuid);
      const charUuids = await service.characteristics();
      bleLog.debug(`  Service ${svcUuid}: chars=[${charUuids.join(', ')}]`);

      for (const charUuid of charUuids) {
        const char = await service.getCharacteristic(charUuid);
        charMap.set(normalizeUuid(charUuid), wrapChar(char));
      }
    } catch (e: unknown) {
      bleLog.debug(`  Service ${svcUuid}: error=${errMsg(e)}`);
    }
  }

  return charMap;
}

/**
 * Fast-path charMap builder: directly accesses the adapter's known service and
 * characteristic UUIDs without enumerating all GATT services. This reduces setup
 * time from ~3s to ~300ms, critical for scales that only advertise while being
 * actively weighed and may send their data immediately after connection.
 */
async function buildCharMapFast(
  gatt: NodeBle.GattServer,
  adapter: ScaleAdapter,
): Promise<Map<string, BleChar>> {
  const charMap = new Map<string, BleChar>();
  const service = await gatt.getPrimaryService(adapter.serviceUuid!);

  // node-ble requires characteristics() to be called before getCharacteristic()
  // can resolve individual D-Bus objects. We enumerate only this one service
  // instead of all services, which is the bulk of the time saving.
  const charUuids = await service.characteristics();
  bleLog.debug(`Fast charMap: service=${adapter.serviceUuid} chars=[${charUuids.join(', ')}]`);

  const wanted = new Set<string>([
    normalizeUuid(adapter.charNotifyUuid),
    normalizeUuid(adapter.charWriteUuid),
    ...(adapter.altCharNotifyUuid ? [normalizeUuid(adapter.altCharNotifyUuid)] : []),
    ...(adapter.altCharWriteUuid ? [normalizeUuid(adapter.altCharWriteUuid)] : []),
    ...(adapter.characteristics?.map((b) => normalizeUuid(b.uuid)) ?? []),
  ]);

  for (const charUuid of charUuids) {
    if (!wanted.has(normalizeUuid(charUuid))) continue;
    try {
      const char = await service.getCharacteristic(charUuid);
      charMap.set(normalizeUuid(charUuid), wrapChar(char));
    } catch (e: unknown) {
      bleLog.debug(`  Char ${charUuid}: error=${errMsg(e)}`);
    }
  }

  return charMap;
}

/**
 * Probe-based adapter matching: directly accesses each adapter's known service
 * UUID without calling gatt.services() first. This skips the ~2s GATT service
 * enumeration round-trip, allowing the notification subscription to be active
 * significantly sooner after connection.
 *
 * Returns the matched adapter and its pre-built charMap, or null if no adapter
 * with a serviceUuid matched (falls back to full gatt.services() enumeration).
 */
async function probeMatchAndBuildCharMap(
  gatt: NodeBle.GattServer,
  adapters: ScaleAdapter[],
): Promise<{ adapter: ScaleAdapter; charMap: Map<string, BleChar> } | null> {
  for (const adapter of adapters.filter((a) => a.serviceUuid)) {
    try {
      const service = await gatt.getPrimaryService(adapter.serviceUuid!);
      const charUuids = await service.characteristics();
      if (charUuids.length === 0) continue;

      bleLog.debug(
        `Probe: ${adapter.name} service=${adapter.serviceUuid} chars=[${charUuids.join(', ')}]`,
      );

      const wanted = new Set<string>([
        normalizeUuid(adapter.charNotifyUuid),
        normalizeUuid(adapter.charWriteUuid),
        ...(adapter.altCharNotifyUuid ? [normalizeUuid(adapter.altCharNotifyUuid)] : []),
        ...(adapter.altCharWriteUuid ? [normalizeUuid(adapter.altCharWriteUuid)] : []),
        ...(adapter.characteristics?.map((b) => normalizeUuid(b.uuid)) ?? []),
      ]);

      const charMap = new Map<string, BleChar>();
      for (const charUuid of charUuids) {
        if (!wanted.has(normalizeUuid(charUuid))) continue;
        try {
          const char = await service.getCharacteristic(charUuid);
          charMap.set(normalizeUuid(charUuid), wrapChar(char));
        } catch (e: unknown) {
          bleLog.debug(`  Char ${charUuid}: error=${errMsg(e)}`);
        }
      }

      if (charMap.size > 0) return { adapter, charMap };
    } catch {
      // Service not present on this device — try next adapter
    }
  }
  return null;
}

// ─── Session management ──────────────────────────────────────────────────────

/**
 * Create a reusable D-Bus / BlueZ session.
 * Keep one session alive across multiple scan cycles in continuous mode
 * to avoid the overhead (and BlueZ state issues) of tearing down and
 * rebuilding the D-Bus connection on every cycle.
 */
export function createBleSession(): BleSession {
  const { bluetooth, destroy } = NodeBle.createBluetooth();
  bleLog.debug('Created reusable BLE session');
  return { _bluetooth: bluetooth, _destroy: destroy };
}

/** Tear down a reusable BLE session. */
export function destroyBleSession(session: BleSession): void {
  bleLog.debug('Destroying BLE session');
  session._destroy();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses node-ble (BlueZ D-Bus) — requires bluetoothd running on Linux.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters, profile, weightUnit, onLiveData, abortSignal, session } = opts;

  // Use provided session or create a temporary one
  let bluetooth: NodeBle.Bluetooth;
  let destroy: () => void;
  const ownsSession = !session;

  if (session) {
    bluetooth = session._bluetooth as NodeBle.Bluetooth;
    destroy = () => {}; // Caller owns the lifecycle
  } else {
    try {
      ({ bluetooth, destroy } = NodeBle.createBluetooth());
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      throw err;
    }
  }

  let device: Device | null = null;
  let btAdapter: Adapter | null = null;

  try {
    try {
      btAdapter = await bluetooth.defaultAdapter();
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      throw err;
    }

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    // Remove stale cached device before discovery. BlueZ retains device
    // objects across connections; a stale proxy causes le-connection-abort-by-local.
    if (targetMac) {
      await removeDevice(btAdapter, targetMac);
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bluetooth);
    if (discoveryResult) btAdapter = discoveryResult;

    let matchedAdapter: ScaleAdapter;
    // Retain the GattServer obtained during adapter matching so it can be
    // reused for characteristic setup without a second D-Bus round-trip.
    let discoveryGatt: NodeBle.GattServer | null = null;
    // charMap pre-built by probe matching (skips the separate buildCharMap step).
    let prebuiltCharMap: Map<string, BleChar> | null = null;

    if (targetMac) {
      const mac = formatMac(targetMac);
      bleLog.info('Scanning for device...');

      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const waitPromise = withTimeout(
        btAdapter.waitDevice(mac),
        DISCOVERY_TIMEOUT_MS,
        `Device ${mac} not found within ${DISCOVERY_TIMEOUT_MS / 1000}s`,
      );

      if (abortSignal) {
        // Wrap in a promise that cleans up the abort listener in all paths
        // to prevent MaxListenersExceededWarning in continuous mode
        const sig = abortSignal;
        device = await new Promise<Device>((resolve, reject) => {
          const onAbort = () => {
            reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          sig.addEventListener('abort', onAbort, { once: true });
          waitPromise.then(
            (d) => {
              sig.removeEventListener('abort', onAbort);
              resolve(d);
            },
            (err) => {
              sig.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      } else {
        device = await waitPromise;
      }

      const name = await device.getName().catch(() => '');
      bleLog.debug(`Found device: ${name} [${mac}]`);

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      device = await connectWithRecovery({
        btAdapter,
        mac: targetMac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
      });
      bleLog.info('Connected. Discovering services...');

      // Try probe-based matching first: directly accesses the adapter's known
      // service UUID without the ~2s gatt.services() round-trip. Falls back to
      // full service enumeration if no adapter with serviceUuid matches.
      discoveryGatt = await device.gatt();
      const probe = await probeMatchAndBuildCharMap(discoveryGatt, adapters);

      if (probe) {
        matchedAdapter = probe.adapter;
        prebuiltCharMap = probe.charMap;
        bleLog.info(`Matched adapter: ${matchedAdapter.name} (probe)`);
      } else {
        const serviceUuids = await discoveryGatt.services();
        bleLog.debug(`Services: [${serviceUuids.join(', ')}]`);

        const info: BleDeviceInfo = {
          localName: name,
          serviceUuids: serviceUuids.map(normalizeUuid),
        };
        const found = adapters.find((a) => a.matches(info));
        if (!found) {
          throw new Error(
            `Device found (${name}) but no adapter recognized it. ` +
              `Services: [${serviceUuids.join(', ')}]. ` +
              `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
          );
        }
        matchedAdapter = found;
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
      }
    } else {
      // Auto-discovery: poll discovered devices, match by name, connect, verify
      const result = await autoDiscover(btAdapter, adapters, abortSignal);
      device = result.device;
      matchedAdapter = result.adapter;

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      device = await connectWithRecovery({
        btAdapter,
        mac: result.mac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
      });
      bleLog.info('Connected. Discovering services...');
    }

    // Use the charMap from probe matching if available; otherwise build it now.
    const gatt = discoveryGatt ?? (await device.gatt());
    const charMap =
      prebuiltCharMap ??
      (await withTimeout(
        matchedAdapter.serviceUuid
          ? buildCharMapFast(gatt, matchedAdapter)
          : buildCharMap(gatt),
        GATT_DISCOVERY_TIMEOUT_MS,
        'GATT service discovery timed out',
      ));
    const raw = await waitForRawReading(
      charMap,
      wrapDevice(device),
      matchedAdapter,
      profile,
      weightUnit,
      onLiveData,
    );

    // Read battery level from the standard BLE Battery Service (0x180F / 0x2A19).
    // Done after measurement to avoid adding latency to the critical subscription path.
    try {
      const batteryService = await gatt.getPrimaryService(
        '0000180f-0000-1000-8000-00805f9b34fb',
      );
      await batteryService.characteristics();
      const batteryChar = await batteryService.getCharacteristic(
        '00002a19-0000-1000-8000-00805f9b34fb',
      );
      const batteryData = await batteryChar.readValue();
      raw.batteryLevel = batteryData[0];
      bleLog.debug(`Battery: ${raw.batteryLevel}%`);
    } catch {
      // Battery service not present on this device — skip silently
    }

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return raw;
  } finally {
    // Clean up BlueZ state BEFORE destroying the D-Bus connection.
    // Order matters: removeDevice must happen while the D-Bus handle is still valid,
    // otherwise the next cycle starts with a stale cached device that causes
    // le-connection-abort-by-local errors on reconnect.
    if (btAdapter) {
      if (targetMac) {
        await removeDevice(btAdapter, targetMac);
      }
      try {
        await btAdapter.stopDiscovery();
      } catch {
        /* may already be stopped */
      }
    }
    if (ownsSession) destroy();
  }
}

/** Scan, read, and compute body composition. Wrapper around scanAndReadRaw(). */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses node-ble (BlueZ D-Bus) — Linux only.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs = 15_000,
): Promise<ScanResult[]> {
  let bluetooth: NodeBle.Bluetooth;
  let destroy: () => void;
  try {
    ({ bluetooth, destroy } = NodeBle.createBluetooth());
  } catch (err) {
    if (isDbusConnectionError(err)) throw dbusError();
    throw err;
  }

  let btAdapter: Adapter | null = null;

  try {
    try {
      btAdapter = await bluetooth.defaultAdapter();
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      throw err;
    }

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bluetooth);
    if (discoveryResult) btAdapter = discoveryResult;

    const seen = new Set<string>();
    const results: ScanResult[] = [];
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      const addresses = await btAdapter.devices();

      for (const addr of addresses) {
        if (seen.has(addr)) continue;
        seen.add(addr);

        try {
          const dev = await btAdapter.getDevice(addr);
          const name = await dev.getName().catch(() => '(unknown)');
          const info: BleDeviceInfo = { localName: name, serviceUuids: [] };
          const matched = adapters.find((a) => a.matches(info));

          results.push({
            address: addr,
            name,
            matchedAdapter: matched?.name,
          });
        } catch {
          /* device may have gone away */
        }
      }

      await sleep(DISCOVERY_POLL_MS);
    }

    return results;
  } finally {
    if (btAdapter) {
      try {
        await btAdapter.stopDiscovery();
      } catch {
        /* ignore */
      }
    }
    destroy();
  }
}
