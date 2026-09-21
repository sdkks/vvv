import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from './config.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vvv-config-'));
});
afterEach(() => {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

it('requires a password without revealing it and validates the port', () => {
  expect(() => loadConfig({})).toThrow('VVV_PASSWORD is required');
  for (const PORT of ['0', '65536', '1.5', 'bad', '']) {
    expect(() => loadConfig({ VVV_PASSWORD: 'fixture', PORT })).toThrow('PORT');
  }
});
it('creates the data directory, uses defaults and generates a per-boot secret', () => {
  const oldCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = loadConfig({ VVV_PASSWORD: 'fixture' });
    const second = loadConfig({ VVV_PASSWORD: 'fixture' });
    expect(first.dataDir).toBe(join(process.cwd(), 'data'));
    expect(existsSync(first.dataDir)).toBe(true);
    expect(first.port).toBe(8080);
    expect(first.sessionSecret).not.toBe(second.sessionSecret);
    expect(first.sessionSecret).toHaveLength(64);
  } finally {
    process.chdir(oldCwd);
  }
});
it('honors explicit settings and refuses files or unwritable directories', () => {
  const cfg = loadConfig({
    VVV_PASSWORD: 'fixture',
    VVV_SESSION_SECRET: 'fixture-secret',
    PORT: '9090',
    DATA_DIR: directory,
  });
  expect(cfg.port).toBe(9090);
  expect(cfg.sessionSecret).toBe('fixture-secret');
  const file = join(directory, 'file');
  writeFileSync(file, 'not a directory');
  expect(() => loadConfig({ VVV_PASSWORD: 'fixture', DATA_DIR: file })).toThrow('DATA_DIR');
  chmodSync(directory, 0o500);
  expect(() => loadConfig({ VVV_PASSWORD: 'fixture', DATA_DIR: directory })).toThrow('DATA_DIR');
});
