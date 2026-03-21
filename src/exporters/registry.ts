import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterEntry } from '../config/schema.js';
import type { MqttConfig } from './config.js';
import { mqttSchema, MqttExporter } from './mqtt.js';

// --- Registry entry type ---

interface ExporterRegistryEntry {
  schema: ExporterSchema;
  factory: (config: Record<string, unknown>) => Exporter;
}

// --- Registry ---

export const EXPORTER_REGISTRY: ExporterRegistryEntry[] = [
  {
    schema: mqttSchema,
    factory: (config) => {
      const mqttConfig: MqttConfig = {
        brokerUrl: config.broker_url as string,
        topic: (config.topic as string) ?? 'scale/body-composition',
        qos: (config.qos as 0 | 1 | 2) ?? 1,
        retain: (config.retain as boolean) ?? true,
        username: config.username as string | undefined,
        password: config.password as string | undefined,
        clientId: (config.client_id as string) ?? 'ble-scale-sync',
        haDiscovery: (config.ha_discovery as boolean) ?? true,
        haDeviceName: (config.ha_device_name as string) ?? 'BLE Scale',
      };
      return new MqttExporter(mqttConfig);
    },
  },
];

// --- Derived exports ---

export const EXPORTER_SCHEMAS: ExporterSchema[] = EXPORTER_REGISTRY.map((e) => e.schema);

export const KNOWN_EXPORTER_NAMES = new Set(EXPORTER_REGISTRY.map((e) => e.schema.name));

// --- Factory ---

/**
 * Create an exporter instance from a config.yaml exporter entry.
 * The entry must have a `type` field matching a registered exporter name.
 */
export function createExporterFromEntry(entry: ExporterEntry): Exporter {
  const registryEntry = EXPORTER_REGISTRY.find((e) => e.schema.name === entry.type);
  if (!registryEntry) {
    throw new Error(
      `Unknown exporter type '${entry.type}'. Known exporters: ${[...KNOWN_EXPORTER_NAMES].join(', ')}`,
    );
  }
  const { type: _, ...config } = entry;
  return registryEntry.factory(config);
}
