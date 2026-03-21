import { describe, it, expect, vi } from 'vitest';
import { EXPORTER_SCHEMAS } from '../../src/exporters/registry.js';
import type { ConfigFieldDef } from '../../src/interfaces/exporter-schema.js';
import { promptField, exportersStep } from '../../src/wizard/steps/exporters.js';
import { createMockPromptProvider } from '../../src/wizard/prompt-provider.js';
import type { WizardContext } from '../../src/wizard/types.js';

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

// ─── Schema-driven field types ───────────────────────────────────────────

describe('promptField()', () => {
  it('handles string field', async () => {
    const field: ConfigFieldDef = { key: 'url', label: 'URL', type: 'string', required: true };
    const ctx = makeCtx(['https://example.com']);
    const result = await promptField(ctx, field);
    expect(result).toBe('https://example.com');
  });

  it('handles string field with default', async () => {
    const field: ConfigFieldDef = {
      key: 'topic',
      label: 'Topic',
      type: 'string',
      required: false,
      default: 'my-topic',
    };
    const ctx = makeCtx(['my-topic']);
    const result = await promptField(ctx, field);
    expect(result).toBe('my-topic');
  });

  it('handles password field', async () => {
    const field: ConfigFieldDef = {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: true,
    };
    const ctx = makeCtx(['secret123']);
    const result = await promptField(ctx, field);
    expect(result).toBe('secret123');
  });

  it('password field calls prompts.password() not prompts.input()', async () => {
    const field: ConfigFieldDef = {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: true,
    };
    const mockProvider = createMockPromptProvider(['secret123']);
    const passwordSpy = vi.spyOn(mockProvider, 'password');
    const inputSpy = vi.spyOn(mockProvider, 'input');

    const ctx: WizardContext = {
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
      prompts: mockProvider,
    };

    await promptField(ctx, field);
    expect(passwordSpy).toHaveBeenCalledOnce();
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it('handles number field', async () => {
    const field: ConfigFieldDef = {
      key: 'timeout',
      label: 'Timeout',
      type: 'number',
      required: false,
      default: 10000,
    };
    const ctx = makeCtx(['5000']);
    const result = await promptField(ctx, field);
    expect(result).toBe(5000);
  });

  it('handles boolean field', async () => {
    const field: ConfigFieldDef = {
      key: 'retain',
      label: 'Retain',
      type: 'boolean',
      required: false,
      default: true,
    };
    const ctx = makeCtx([true]);
    const result = await promptField(ctx, field);
    expect(result).toBe(true);
  });

  it('handles select field', async () => {
    const field: ConfigFieldDef = {
      key: 'method',
      label: 'Method',
      type: 'select',
      required: false,
      default: 'POST',
      choices: [
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
      ],
    };
    const ctx = makeCtx(['PUT']);
    const result = await promptField(ctx, field);
    expect(result).toBe('PUT');
  });

  it('returns undefined for empty optional string', async () => {
    const field: ConfigFieldDef = {
      key: 'headers',
      label: 'Headers',
      type: 'string',
      required: false,
    };
    const ctx = makeCtx(['']);
    const result = await promptField(ctx, field);
    expect(result).toBeUndefined();
  });

  it('returns default for empty optional number', async () => {
    const field: ConfigFieldDef = {
      key: 'qos',
      label: 'QoS',
      type: 'number',
      required: false,
      default: 1,
    };
    const ctx = makeCtx(['']);
    const result = await promptField(ctx, field);
    expect(result).toBe(1);
  });
});

// ─── Confirm-before-configure skip (unified checkbox flow) ──────────────

describe('exportersStep — confirm skip', () => {
  it('skips exporter config when user declines confirm', async () => {
    // Unified flow: checkbox → confirm(no)
    const ctx = makeCtx([
      ['mqtt'], // unified checkbox: select mqtt (supportsGlobal)
      false, // confirm: "Configure MQTT?" → No
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    // MQTT was skipped, so global_exporters should be undefined (empty after skip)
    expect(ctx.config.global_exporters).toBeUndefined();
  });

  it('configures exporter when user accepts confirm', async () => {
    const mqttSchema = EXPORTER_SCHEMAS.find((s) => s.name === 'mqtt')!;

    // Build answers: unified checkbox → confirm → field values
    const answers: (string | number | boolean | string[])[] = [
      ['mqtt'], // unified checkbox: select mqtt
      true, // confirm: "Configure MQTT?" → Yes
    ];
    // Provide a default-ish answer for each field
    for (const field of mqttSchema.fields) {
      if (field.type === 'string' || field.type === 'password') {
        answers.push(field.default !== undefined ? String(field.default) : 'mqtt://localhost:1883');
      } else if (field.type === 'number') {
        answers.push(field.default !== undefined ? String(field.default) : '1');
      } else if (field.type === 'boolean') {
        answers.push((field.default as boolean) ?? false);
      } else if (field.type === 'select') {
        answers.push(field.choices?.[0]?.value ?? 'POST');
      }
    }

    const ctx = makeCtx(answers);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toBeDefined();
    expect(ctx.config.global_exporters!.length).toBe(1);
    expect(ctx.config.global_exporters![0].type).toBe('mqtt');
  });

  it('returns early when no exporters selected', async () => {
    const ctx = makeCtx([
      [], // unified checkbox: select nothing
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toBeUndefined();
  });
});

// ─── EXPORTER_SCHEMAS filtering ──────────────────────────────────────────

describe('EXPORTER_SCHEMAS filtering', () => {
  it('has schemas for all known exporters', () => {
    const names = EXPORTER_SCHEMAS.map((s) => s.name);
    expect(names).toContain('mqtt');
    expect(names).toHaveLength(1);
  });

  it('filters global-supported schemas', () => {
    const global = EXPORTER_SCHEMAS.filter((s) => s.supportsGlobal);
    const names = global.map((s) => s.name);
    expect(names).toContain('mqtt');
  });

  it('each schema has a displayName and description', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      expect(schema.displayName).toBeTruthy();
      expect(schema.description).toBeTruthy();
    }
  });

  it('each schema field has a key, label, and type', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      for (const field of schema.fields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        expect(['string', 'password', 'number', 'boolean', 'select']).toContain(field.type);
      }
    }
  });

  it('select fields have choices', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      for (const field of schema.fields) {
        if (field.type === 'select') {
          expect(field.choices).toBeDefined();
          expect(field.choices!.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
