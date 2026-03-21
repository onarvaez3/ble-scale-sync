import { describe, it, expect } from 'vitest';
import { bleStep, validateMac } from '../../src/wizard/steps/ble.js';
import type { WizardContext } from '../../src/wizard/types.js';
import { createMockPromptProvider } from '../../src/wizard/prompt-provider.js';

function makeCtx(answers: (string | number | boolean | string[])[]): WizardContext {
  return {
    config: {},
    configPath: 'config.yaml',
    isEditMode: false,
    nonInteractive: false,
    platform: {
      os: 'linux',
      arch: 'x64',
      hasDocker: false,
      hasPython: true,
      pythonCommand: 'python3',
    },
    stepHistory: [],
    prompts: createMockPromptProvider(answers),
  };
}

// ─── validateMac() ──────────────────────────────────────────────────────

describe('validateMac()', () => {
  it('accepts valid MAC address', () => {
    expect(validateMac('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('accepts CoreBluetooth UUID', () => {
    expect(validateMac('12345678-1234-1234-1234-123456789ABC')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(validateMac('not-a-mac')).toContain('Must be');
  });
});

// ─── bleStep scale discovery ─────────────────────────────────────────

describe('bleStep scale discovery', () => {
  it('sets scale_mac to undefined when skip is selected', async () => {
    const ctx = makeCtx(['skip']);
    await bleStep.run(ctx);
    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });

  it('sets scale_mac when manual entry is used', async () => {
    const ctx = makeCtx(['manual', 'AA:BB:CC:DD:EE:FF']);
    await bleStep.run(ctx);
    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('goes back to discovery menu when manual entry is empty', async () => {
    const ctx = makeCtx(['manual', '', 'skip']);
    await bleStep.run(ctx);
    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });

  it('initializes ble config if not present', async () => {
    const ctx = makeCtx(['skip']);
    ctx.config.ble = undefined;
    await bleStep.run(ctx);
    expect(ctx.config.ble).toBeDefined();
  });
});
