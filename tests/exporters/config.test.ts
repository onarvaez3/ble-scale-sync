import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadExporterConfig } from '../../src/exporters/config.js';

describe('loadExporterConfig()', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('EXPORTERS parsing', () => {
    it('defaults to mqtt when EXPORTERS is not set', () => {
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });

    it('parses single exporter', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });

    it('trims whitespace around names', () => {
      vi.stubEnv('EXPORTERS', ' mqtt ');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });

    it('is case-insensitive', () => {
      vi.stubEnv('EXPORTERS', 'MQTT');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });

    it('deduplicates exporters', () => {
      vi.stubEnv('EXPORTERS', 'mqtt,mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });

    it('rejects unknown exporter names', () => {
      vi.stubEnv('EXPORTERS', 'mqtt,foobar');
      expect(() => loadExporterConfig()).toThrow(/Unknown exporter 'foobar'/);
    });
  });

  describe('MQTT config', () => {
    it('requires MQTT_BROKER_URL when mqtt is enabled', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      expect(() => loadExporterConfig()).toThrow(/MQTT_BROKER_URL is required/);
    });

    it('uses defaults for optional MQTT vars', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt).toEqual({
        brokerUrl: 'mqtt://broker.local:1883',
        topic: 'scale/body-composition',
        qos: 1,
        retain: true,
        username: undefined,
        password: undefined,
        clientId: 'ble-scale-sync',
        haDiscovery: true,
        haDeviceName: 'BLE Scale',
      });
    });

    it('parses all MQTT env vars', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      vi.stubEnv('MQTT_TOPIC', 'home/scale');
      vi.stubEnv('MQTT_QOS', '2');
      vi.stubEnv('MQTT_RETAIN', 'false');
      vi.stubEnv('MQTT_USERNAME', 'user');
      vi.stubEnv('MQTT_PASSWORD', 'pass');
      vi.stubEnv('MQTT_CLIENT_ID', 'my-scale');
      vi.stubEnv('MQTT_HA_DISCOVERY', 'false');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt).toEqual({
        brokerUrl: 'mqtt://broker.local:1883',
        topic: 'home/scale',
        qos: 2,
        retain: false,
        username: 'user',
        password: 'pass',
        clientId: 'my-scale',
        haDiscovery: false,
        haDeviceName: 'BLE Scale',
      });
    });

    it('rejects invalid MQTT_QOS', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      vi.stubEnv('MQTT_QOS', '5');
      expect(() => loadExporterConfig()).toThrow(/MQTT_QOS must be 0, 1, or 2/);
    });

    it('rejects invalid MQTT_RETAIN', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      vi.stubEnv('MQTT_RETAIN', 'maybe');
      expect(() => loadExporterConfig()).toThrow(/MQTT_RETAIN must be true\/false/);
    });

    it('parses custom MQTT_HA_DEVICE_NAME', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      vi.stubEnv('MQTT_HA_DEVICE_NAME', 'My Custom Scale');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt!.haDeviceName).toBe('My Custom Scale');
    });
  });
});
