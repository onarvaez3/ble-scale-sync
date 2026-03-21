import { describe, it, expect } from 'vitest';
import { createExporters } from '../../src/exporters/index.js';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { ExporterConfig } from '../../src/exporters/config.js';

describe('createExporters()', () => {
  it('creates MqttExporter for mqtt', () => {
    const config: ExporterConfig = {
      exporters: ['mqtt'],
      mqtt: {
        brokerUrl: 'mqtt://localhost:1883',
        topic: 'test',
        qos: 1,
        retain: true,
        clientId: 'test',
        haDiscovery: true,
        haDeviceName: 'BLE Scale',
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(MqttExporter);
    expect(exporters[0].name).toBe('mqtt');
  });

  it('returns empty array for empty exporters list', () => {
    const config: ExporterConfig = { exporters: [] };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(0);
  });
});
