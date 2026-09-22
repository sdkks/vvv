export function pickerStartPath(input: string) {
  const path = input.trim();
  return path.startsWith('/') && !path.includes('\0') ? path : undefined;
}

export function folderBreadcrumbs(path: string) {
  const parts = path.split('/').filter(Boolean);
  return [
    { name: '/', path: '/' },
    ...parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` })),
  ];
}

export function finishPicking(
  close: () => void,
  input: Pick<HTMLInputElement, 'value' | 'focus'> | null,
  browse: Pick<HTMLButtonElement, 'focus'> | null,
  path?: string
) {
  if (path !== undefined && input) input.value = path;
  close();
  (path === undefined ? browse : input)?.focus();
}
