import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterConfig } from './config.js';
import { MqttExporter } from './mqtt.js';

export { loadExporterConfig } from './config.js';
export { createExporterFromEntry, EXPORTER_SCHEMAS, KNOWN_EXPORTER_NAMES } from './registry.js';

export function createExporters(config: ExporterConfig): Exporter[] {
  const exporters: Exporter[] = [];

  for (const name of config.exporters) {
    switch (name) {
      case 'mqtt':
        exporters.push(new MqttExporter(config.mqtt!));
        break;
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unhandled exporter: ${_exhaustive}`);
      }
    }
  }

  return exporters;
}
