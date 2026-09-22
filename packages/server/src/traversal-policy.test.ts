import { expect, it } from 'vitest';
import { scanDecision, sizeExclusion } from './traversal-policy.js';

const mib = 1048576n;
const sizes = { min_file_size_mb: 1, max_file_size_mb: 2 };
it.each([
  [mib - 1n, 'below minimum'],
  [mib, null],
  [mib + 1n, null],
  [2n * mib, null],
  [2n * mib + 1n, 'above maximum'],
] as const)('uses exact inclusive byte boundaries for %s bytes', (size, reason) => {
  const result = sizeExclusion(size, sizes);
  if (reason) expect(result).toContain(reason);
  else expect(result).toBeNull();
});
it('supports disabled and one-sided limits, with the same binary units as the web', () => {
  expect(sizeExclusion(0n, { min_file_size_mb: 0, max_file_size_mb: 0 })).toBeNull();
  expect(sizeExclusion(2n ** 60n, { min_file_size_mb: 0, max_file_size_mb: 0 })).toBeNull();
  expect(sizeExclusion(0n, { min_file_size_mb: 0, max_file_size_mb: 1 })).toBeNull();
  expect(sizeExclusion(3n * mib, { min_file_size_mb: 1, max_file_size_mb: 0 })).toBeNull();
  expect(sizeExclusion(512n * 1024n, sizes)).toBe('excluded_by_size: 512 KiB below minimum 1 MiB');
});
it('applies size eligibility only after traversal protections and supported-file checks', () => {
  const info = {
    dev: 1n,
    size: 0n,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const policy = { follow_symlinks: false, cross_filesystems: false };
  for (const kind of ['image', 'video'] as const)
    expect(scanDecision(info, kind, policy, 1n, sizes)).toBe('excluded_by_size');
  expect(scanDecision(info, null, policy, 1n, sizes)).toBe('unsupported_type');
  expect(scanDecision({ ...info, isDirectory: () => true }, null, policy, 1n, sizes)).toBe(
    'folder'
  );
  expect(scanDecision({ ...info, isSymbolicLink: () => true }, 'image', policy, 1n, sizes)).toBe(
    'symlink_not_followed'
  );
  expect(scanDecision(info, 'video', policy, 2n, sizes)).toBe('filesystem_boundary');
});
