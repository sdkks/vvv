import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index';

describe('smoke', () => {
  it('exposes a version string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
