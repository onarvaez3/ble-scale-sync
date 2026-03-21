import { describe, it, expect } from 'vitest';
import { matchUserByWeight, detectWeightDrift } from '../src/config/user-matching.js';
import { resolveUserProfile, resolveExportersForUser } from '../src/config/resolve.js';
import type { AppConfig, UserConfig } from '../src/config/schema.js';
import type { ExportContext } from '../src/interfaces/exporter.js';

// ─── Test data ──────────────────────────────────────────────────────────────

const dad: UserConfig = {
  name: 'Dad',
  slug: 'dad',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male',
  is_athlete: false,
  weight_range: { min: 75, max: 95 },
  last_known_weight: 82,
};

const mom: UserConfig = {
  name: 'Mom',
  slug: 'mom',
  height: 165,
  birth_date: '1992-03-20',
  gender: 'female',
  is_athlete: false,
  weight_range: { min: 55, max: 75 },
  last_known_weight: 63,
};

const appConfig: AppConfig = {
  version: 1,
  scale: { weight_unit: 'kg', height_unit: 'cm' },
  unknown_user: 'nearest',
  users: [dad, mom],
  global_exporters: [
    { type: 'mqtt', broker_url: 'mqtt://localhost:1883' },
  ],
};

// ─── Multi-user matching → profile resolution flow ──────────────────────────

describe('Multi-user flow: matching → profile resolution', () => {
  it('matches Dad at 82 kg and resolves his profile', () => {
    const match = matchUserByWeight([dad, mom], 82, 'nearest');
    expect(match.user).toBe(dad);
    expect(match.tier).toBe('exact');

    const profile = resolveUserProfile(match.user!, appConfig.scale);
    expect(profile.height).toBe(183);
    expect(profile.gender).toBe('male');
    expect(profile.isAthlete).toBe(false);
    expect(profile.age).toBeGreaterThan(0);
  });

  it('matches Mom at 63 kg and resolves her profile', () => {
    const match = matchUserByWeight([dad, mom], 63, 'nearest');
    expect(match.user).toBe(mom);
    expect(match.tier).toBe('exact');

    const profile = resolveUserProfile(match.user!, appConfig.scale);
    expect(profile.height).toBe(165);
    expect(profile.gender).toBe('female');
  });

  it('converts height from inches when height_unit is in', () => {
    const inchConfig: AppConfig = {
      ...appConfig,
      scale: { weight_unit: 'kg', height_unit: 'in' },
    };
    const user: UserConfig = {
      ...dad,
      height: 72, // 72 inches = 182.88 cm
    };
    const profile = resolveUserProfile(user, inchConfig.scale);
    expect(profile.height).toBeCloseTo(182.88, 1);
  });
});

// ─── ExportContext construction ──────────────────────────────────────────────

describe('Multi-user flow: ExportContext construction', () => {
  it('builds correct ExportContext from matched user', () => {
    const match = matchUserByWeight([dad, mom], 82, 'nearest');
    const user = match.user!;

    const context: ExportContext = {
      userName: user.name,
      userSlug: user.slug,
      userConfig: user,
    };

    expect(context.userName).toBe('Dad');
    expect(context.userSlug).toBe('dad');
    expect(context.userConfig).toBe(dad);
  });

  it('includes drift warning when weight is near boundary', () => {
    // Dad's range is 75-95, outer 10% = 2 kg from each boundary
    // 76 kg is within the lower 10% threshold (75 + 2 = 77)
    const drift = detectWeightDrift(dad, 76);
    expect(drift).not.toBeNull();
    expect(drift).toContain('near the lower boundary');

    const context: ExportContext = {
      userName: dad.name,
      userSlug: dad.slug,
      userConfig: dad,
      ...(drift ? { driftWarning: drift } : {}),
    };
    expect(context.driftWarning).toContain('near the lower boundary');
  });

  it('does not include drift warning when weight is in safe zone', () => {
    const drift = detectWeightDrift(dad, 85);
    expect(drift).toBeNull();

    const context: ExportContext = {
      userName: dad.name,
      userSlug: dad.slug,
      userConfig: dad,
      ...(drift ? { driftWarning: drift } : {}),
    };
    expect(context.driftWarning).toBeUndefined();
  });
});

// ─── Per-user exporter resolution ───────────────────────────────────────────

describe('Multi-user flow: per-user exporter resolution', () => {
  it('resolves global exporters for a user without per-user exporters', () => {
    const entries = resolveExportersForUser(appConfig, dad);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('mqtt');
  });

  it('dedupes by type — user exporter overrides global of same type', () => {
    const userWithMqtt: UserConfig = {
      ...dad,
      exporters: [
        { type: 'mqtt', broker_url: 'mqtt://custom:1883' },
      ],
    };
    const config: AppConfig = { ...appConfig, users: [userWithMqtt, mom] };
    const entries = resolveExportersForUser(config, userWithMqtt);

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('mqtt');
    expect((entries[0] as Record<string, unknown>).broker_url).toBe('mqtt://custom:1883');
  });
});

// ─── Strategy fallback ──────────────────────────────────────────────────────

describe('Multi-user flow: strategy fallback', () => {
  // Users without last_known_weight — forces the algorithm past tier 4 to strategy
  const dadNoLkw: UserConfig = { ...dad, last_known_weight: null };
  const momNoLkw: UserConfig = { ...mom, last_known_weight: null };

  it('strategy "ignore" returns null user for unmatched weight', () => {
    const match = matchUserByWeight([dadNoLkw, momNoLkw], 50, 'ignore');
    expect(match.user).toBeNull();
    expect(match.tier).toBe('strategy');
  });

  it('strategy "log" returns null user with warning for unmatched weight', () => {
    const match = matchUserByWeight([dadNoLkw, momNoLkw], 50, 'log');
    expect(match.user).toBeNull();
    expect(match.tier).toBe('strategy');
    expect(match.warning).toContain('logging and skipping');
  });

  it('strategy "nearest" returns closest user by range midpoint', () => {
    // Dad midpoint = 85, Mom midpoint = 65
    // 50 kg is closer to Mom's midpoint (|50-65|=15) than Dad's (|50-85|=35)
    const match = matchUserByWeight([dadNoLkw, momNoLkw], 50, 'nearest');
    expect(match.user).toBe(momNoLkw);
    expect(match.tier).toBe('strategy');
    expect(match.warning).toContain('nearest user Mom');
  });
});

// ─── Tiebreak with last_known_weight ────────────────────────────────────────

describe('Multi-user flow: overlapping range tiebreak', () => {
  it('uses last_known_weight proximity when ranges overlap', () => {
    const user1: UserConfig = {
      ...dad,
      weight_range: { min: 70, max: 90 },
      last_known_weight: 72,
    };
    const user2: UserConfig = {
      ...mom,
      weight_range: { min: 65, max: 80 },
      last_known_weight: 78,
    };

    // 77 kg is in both ranges. user2's LKW (78) is closer to 77 than user1's (72)
    const match = matchUserByWeight([user1, user2], 77, 'nearest');
    expect(match.user).toBe(user2);
    expect(match.tier).toBe('tiebreak');
  });
});
