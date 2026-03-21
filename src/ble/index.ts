import type { ScaleAdapter, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult, BleSession } from './types.js';
import type { RawReading } from './shared.js';
import { bleLog } from './types.js';

export type { ScanOptions, ScanResult, BleSession } from './types.js';
export type { RawReading } from './shared.js';

export async function createBleSession(): Promise<BleSession> {
  const { createBleSession: impl } = await import('./handler-node-ble.js');
  return impl();
}

export async function destroyBleSession(session: BleSession): Promise<void> {
  const { destroyBleSession: impl } = await import('./handler-node-ble.js');
  impl(session);
}

export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  bleLog.debug('BLE handler: node-ble (BlueZ D-Bus)');
  const { scanAndReadRaw: impl } = await import('./handler-node-ble.js');
  return impl(opts);
}

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  bleLog.debug('BLE handler: node-ble (BlueZ D-Bus)');
  const { scanAndRead: impl } = await import('./handler-node-ble.js');
  return impl(opts);
}

export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
): Promise<ScanResult[]> {
  bleLog.debug('BLE handler: node-ble (BlueZ D-Bus)');
  const { scanDevices: impl } = await import('./handler-node-ble.js');
  return impl(adapters, durationMs);
}
