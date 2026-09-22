import { extname, isAbsolute, relative, sep } from 'node:path';
import type { ScanDir, ScanDecision } from '@vvv/shared';

type Policy = Pick<ScanDir, 'follow_symlinks' | 'cross_filesystems'>;
const images = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'avif']);
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
  return images.has(extension) ? 'image' : videos.has(extension) ? 'video' : null;
}
export const outsideRoot = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
export const insideTrash = (path: string) => path.split(sep).includes('.vvv-trash');
export const skipsSymlink = (linked: boolean, follow: boolean | number) => linked && !follow;
export const crossesBoundary = (root: bigint, device: bigint, cross: boolean | number) =>
  !cross && root !== device;
export function scanDecision(
  info: { dev: bigint; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
  kind: ReturnType<typeof mediaKind>,
  policy: Policy,
  root: bigint
): ScanDecision {
  if (skipsSymlink(info.isSymbolicLink(), policy.follow_symlinks)) return 'symlink_not_followed';
  if (crossesBoundary(root, info.dev, policy.cross_filesystems)) return 'filesystem_boundary';
  if (info.isDirectory()) return 'folder';
  return info.isFile() && kind ? 'would_process' : 'unsupported_type';
}
