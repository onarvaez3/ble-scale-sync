import { createLogger } from '../logger.js';

const log = createLogger('ExporterConfig');

export type ExporterName = 'mqtt';

const KNOWN_EXPORTERS = new Set<ExporterName>(['mqtt']);

export interface MqttConfig {
  brokerUrl: string;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  username?: string;
  password?: string;
  clientId: string;
  haDiscovery: boolean;
  haDeviceName: string;
}

export interface ExporterConfig {
  exporters: ExporterName[];
  mqtt?: MqttConfig;
}

function fail(msg: string): never {
  throw new Error(msg);
}

function parseQos(raw: string | undefined): 0 | 1 | 2 {
  if (!raw) return 1;
  const num = Number(raw);
  if (num === 0 || num === 1 || num === 2) return num;
  fail(`MQTT_QOS must be 0, 1, or 2, got '${raw}'`);
}

function parseBoolean(key: string, raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const lower = raw.toLowerCase();
  if (['true', 'yes', '1'].includes(lower)) return true;
  if (['false', 'no', '0'].includes(lower)) return false;
  fail(`${key} must be true/false/yes/no/1/0, got '${raw}'`);
}

export function loadExporterConfig(): ExporterConfig {
  const raw = process.env.EXPORTERS?.trim();
  const names = raw ? raw.split(',').map((s) => s.trim().toLowerCase()) : ['mqtt'];

  const exporters: ExporterName[] = [];
  for (const name of names) {
    if (!KNOWN_EXPORTERS.has(name as ExporterName)) {
      fail(`Unknown exporter '${name}'. Valid exporters: ${[...KNOWN_EXPORTERS].join(', ')}`);
    }
    if (!exporters.includes(name as ExporterName)) {
      exporters.push(name as ExporterName);
    }
  }

  if (exporters.length === 0) {
    fail('EXPORTERS must contain at least one exporter.');
  }

  let mqtt: MqttConfig | undefined;
  if (exporters.includes('mqtt')) {
    const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
    if (!brokerUrl) {
      fail('MQTT_BROKER_URL is required when mqtt exporter is enabled.');
    }
    mqtt = {
      brokerUrl,
      topic: process.env.MQTT_TOPIC?.trim() || 'scale/body-composition',
      qos: parseQos(process.env.MQTT_QOS?.trim()),
      retain: parseBoolean('MQTT_RETAIN', process.env.MQTT_RETAIN?.trim(), true),
      username: process.env.MQTT_USERNAME?.trim() || undefined,
      password: process.env.MQTT_PASSWORD?.trim() || undefined,
      clientId: process.env.MQTT_CLIENT_ID?.trim() || 'ble-scale-sync',
      haDiscovery: parseBoolean('MQTT_HA_DISCOVERY', process.env.MQTT_HA_DISCOVERY?.trim(), true),
      haDeviceName: process.env.MQTT_HA_DEVICE_NAME?.trim() || 'BLE Scale',
    };
  }

  void log;
  return { exporters, mqtt };
}
