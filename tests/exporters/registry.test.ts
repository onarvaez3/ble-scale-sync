import { describe, it, expect } from 'vitest';
import {
  EXPORTER_REGISTRY,
  EXPORTER_SCHEMAS,
  KNOWN_EXPORTER_NAMES,
  createExporterFromEntry,
} from '../../src/exporters/registry.js';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { ExporterEntry } from '../../src/config/schema.js';

// ─── EXPORTER_REGISTRY ─────────────────────────────────────────────────────

describe('EXPORTER_REGISTRY', () => {
  it('contains 1 exporter entry', () => {
    expect(EXPORTER_REGISTRY).toHaveLength(1);
  });

  it('has entry for mqtt', () => {
    const names = EXPORTER_REGISTRY.map((e) => e.schema.name);
    expect(names).toContain('mqtt');
  });

  it('each entry has a schema and factory', () => {
    for (const entry of EXPORTER_REGISTRY) {
      expect(entry.schema).toBeDefined();
      expect(entry.schema.name).toBeDefined();
      expect(entry.schema.displayName).toBeDefined();
      expect(entry.schema.description).toBeDefined();
      expect(entry.schema.fields).toBeInstanceOf(Array);
      expect(typeof entry.factory).toBe('function');
    }
  });
});

// ─── EXPORTER_SCHEMAS ──────────────────────────────────────────────────────

describe('EXPORTER_SCHEMAS', () => {
  it('derives 1 schema from registry', () => {
    expect(EXPORTER_SCHEMAS).toHaveLength(1);
  });

  it('each schema has required fields', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      expect(schema.name).toBeDefined();
      expect(schema.displayName).toBeDefined();
      expect(schema.description).toBeDefined();
      expect(schema.fields).toBeInstanceOf(Array);
      expect(typeof schema.supportsGlobal).toBe('boolean');
      expect(typeof schema.supportsPerUser).toBe('boolean');
    }
  });

  it('mqtt schema supports global only', () => {
    const mqtt = EXPORTER_SCHEMAS.find((s) => s.name === 'mqtt');
    expect(mqtt).toBeDefined();
    expect(mqtt!.supportsGlobal).toBe(true);
    expect(mqtt!.supportsPerUser).toBe(false);
  });

  it('mqtt schema has required broker_url field', () => {
    const mqtt = EXPORTER_SCHEMAS.find((s) => s.name === 'mqtt');
    const brokerField = mqtt!.fields.find((f) => f.key === 'broker_url');
    expect(brokerField).toBeDefined();
    expect(brokerField!.required).toBe(true);
  });
});

// ─── KNOWN_EXPORTER_NAMES ──────────────────────────────────────────────────

describe('KNOWN_EXPORTER_NAMES', () => {
  it('is a Set with 1 entry', () => {
    expect(KNOWN_EXPORTER_NAMES).toBeInstanceOf(Set);
    expect(KNOWN_EXPORTER_NAMES.size).toBe(1);
  });

  it('contains mqtt', () => {
    expect(KNOWN_EXPORTER_NAMES.has('mqtt')).toBe(true);
  });
});

// ─── createExporterFromEntry() ─────────────────────────────────────────────

describe('createExporterFromEntry()', () => {
  it('creates MqttExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'mqtt',
      broker_url: 'mqtt://localhost:1883',
      topic: 'test/topic',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(MqttExporter);
    expect(exporter.name).toBe('mqtt');
  });

  it('throws on unknown exporter type', () => {
    const entry: ExporterEntry = { type: 'unknown' };
    expect(() => createExporterFromEntry(entry)).toThrow("Unknown exporter type 'unknown'");
  });

  it('error message includes known exporter names', () => {
    const entry: ExporterEntry = { type: 'bad' };
    expect(() => createExporterFromEntry(entry)).toThrow('mqtt');
  });

  it('applies defaults for optional MQTT fields', () => {
    const entry: ExporterEntry = {
      type: 'mqtt',
      broker_url: 'mqtt://localhost:1883',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(MqttExporter);
  });
});
