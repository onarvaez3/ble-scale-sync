import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { MqttConfig } from '../../src/exporters/config.js';

const { mockEndAsync, mockConnectAsync } = vi.hoisted(() => {
  const mockEndAsync = vi.fn().mockResolvedValue(undefined);
  const mockConnectAsync = vi.fn().mockResolvedValue({
    publishAsync: vi.fn(),
    endAsync: mockEndAsync,
  });
  return { mockEndAsync, mockConnectAsync };
});

vi.mock('mqtt', () => ({
  connectAsync: mockConnectAsync,
}));

describe('Exporter healthchecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectAsync.mockResolvedValue({
      publishAsync: vi.fn(),
      endAsync: mockEndAsync,
    });
    mockEndAsync.mockResolvedValue(undefined);
  });

  describe('MqttExporter.healthcheck()', () => {
    const config: MqttConfig = {
      brokerUrl: 'mqtt://localhost:1883',
      topic: 'test',
      qos: 1,
      retain: true,
      clientId: 'ble-scale-sync',
      haDiscovery: false,
      haDeviceName: 'BLE Scale',
    };

    it('returns success when connect succeeds', async () => {
      const exporter = new MqttExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockConnectAsync).toHaveBeenCalledTimes(1);
      expect(mockEndAsync).toHaveBeenCalledTimes(1);
    });

    it('returns failure when connect fails', async () => {
      mockConnectAsync.mockRejectedValue(new Error('connection refused'));
      const exporter = new MqttExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('connection refused');
    });

    it('uses -healthcheck clientId suffix', async () => {
      const exporter = new MqttExporter(config);
      await exporter.healthcheck();
      expect(mockConnectAsync).toHaveBeenCalledWith(
        'mqtt://localhost:1883',
        expect.objectContaining({ clientId: 'ble-scale-sync-healthcheck' }),
      );
    });
  });
});
