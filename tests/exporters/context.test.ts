import { describe, it, expect, vi } from 'vitest';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const userContext: ExportContext = {
  userName: 'Dad',
  userSlug: 'dad',
};

// ─── Orchestrator context propagation ───────────────────────────────────

describe('dispatchExports() with ExportContext', () => {
  it('propagates context to exporters', async () => {
    const { dispatchExports } = await import('../../src/orchestrator.js');

    const mockExport = vi.fn().mockResolvedValue({ success: true });
    const exporter = { name: 'test', export: mockExport };

    await dispatchExports([exporter], samplePayload, userContext);

    expect(mockExport).toHaveBeenCalledWith(samplePayload, userContext);
  });

  it('does not pass context when not provided', async () => {
    const { dispatchExports } = await import('../../src/orchestrator.js');

    const mockExport = vi.fn().mockResolvedValue({ success: true });
    const exporter = { name: 'test', export: mockExport };

    await dispatchExports([exporter], samplePayload);

    expect(mockExport).toHaveBeenCalledWith(samplePayload);
  });
});
