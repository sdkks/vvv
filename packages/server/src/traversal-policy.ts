import { extname, isAbsolute, relative, sep } from 'node:path';
import type { FileSizePolicy, ScanDir, ScanDecision } from '@vvv/shared';

type Policy = Pick<ScanDir, 'follow_symlinks' | 'cross_filesystems'>;
const images = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'avif']);
const audio = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg']);
const videos = new Set([
  'mp4',
  'mkv',
  'avi',
  'mov',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'wmv',
  'flv',
]);
export function mediaKind(path: string) {
  const extension = extname(path).slice(1).toLowerCase();
  return images.has(extension)
    ? 'image'
    : audio.has(extension)
      ? 'audio'
      : videos.has(extension)
        ? 'video'
        : null;
}
export const outsideRoot = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
export const insideTrash = (path: string) => path.split(sep).includes('.vvv-trash');
export const skipsSymlink = (linked: boolean, follow: boolean | number) => linked && !follow;
export const crossesBoundary = (root: bigint, device: bigint, cross: boolean | number) =>
  !cross && root !== device;
function humanSize(bytes: bigint) {
  const value = Number(bytes);
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${Number((value / 1024 ** unit).toFixed(1))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
export function sizeExclusion(size: bigint, policy: FileSizePolicy): string | null {
  const min = BigInt(policy.min_file_size_mb) * 1048576n;
  const max = BigInt(policy.max_file_size_mb) * 1048576n;
  // Exclusion reasons share the error column, but only status='error' is a scan failure.
  if (min > 0n && size < min)
    return `excluded_by_size: ${humanSize(size)} below minimum ${humanSize(min)}`;
  if (max > 0n && size > max)
    return `excluded_by_size: ${humanSize(size)} above maximum ${humanSize(max)}`;
  return null;
}
export function scanDecision(
  info: {
    dev: bigint;
    size: bigint;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
  kind: ReturnType<typeof mediaKind>,
  policy: Policy,
  root: bigint,
  sizes: FileSizePolicy
): ScanDecision {
  if (skipsSymlink(info.isSymbolicLink(), policy.follow_symlinks)) return 'symlink_not_followed';
  if (crossesBoundary(root, info.dev, policy.cross_filesystems)) return 'filesystem_boundary';
  if (info.isDirectory()) return 'folder';
  if (!info.isFile() || !kind) return 'unsupported_type';
  return sizeExclusion(info.size, sizes) ? 'excluded_by_size' : 'would_process';
}
