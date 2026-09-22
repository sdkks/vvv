import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DirectoryEntries, EntryFilter, ScanDir } from '@vvv/shared';
import { api } from './api';
import { formatBytes } from './group-review';
import { breadcrumbs, decisionLabel, pageCursors } from './directory-preview';

export function DirectoryPreview({ dir }: { dir: ScanDir }) {
  const [open, setOpen] = useState(false);
  const keyboard = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <>
      <button
        ref={toggle}
        aria-expanded={open}
        aria-controls={`preview-${dir.id}`}
        onClick={(event) => {
          keyboard.current = event.detail === 0;
          setOpen(!open);
        }}
      >
        Preview contents
      </button>
      {open && (
        <PreviewContents
          key={`${dir.follow_symlinks}-${dir.cross_filesystems}`}
          dir={dir}
          focusHeading={keyboard.current}
          close={close}
        />
      )}
    </>
  );
}

export function PreviewContents({
  dir,
  focusHeading,
  close,
}: {
  dir: ScanDir;
  focusHeading: boolean;
  close: () => void;
}) {
  const [path, setPath] = useState('');
  const [filter, setFilter] = useState<EntryFilter>('media');
  const [history, setHistory] = useState(['']);
  const cursor = history.at(-1) ?? '';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  const query = useQuery({
    queryKey: ['directory-entries', dir, path, filter, cursor],
    queryFn: ({ signal }) =>
      api<DirectoryEntries>(
        `/scan-dirs/${dir.id}/entries?${new URLSearchParams({ path, filter, cursor, limit: '50' })}`,
        { signal }
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const navigate = (next: string) => {
    setPath(next);
    setHistory(['']);
    heading.current?.focus();
  };
  return (
    <section
      id={`preview-${dir.id}`}
      className="directory-preview"
      aria-labelledby={`preview-heading-${dir.id}`}
    >
      <h2 id={`preview-heading-${dir.id}`} ref={heading} tabIndex={-1}>
        Preview of {dir.path}
        {path && `/${path}`}
      </h2>
      <p>
        Read-only preview: reads directory metadata only. Does not hash, decode, move, or delete
        files.
      </p>
      <p className="metadata">
        Symlinks {dir.follow_symlinks ? 'followed within this root' : 'not followed'} · Filesystem
        boundaries {dir.cross_filesystems ? 'crossed' : 'not crossed'} · Images, videos, and audio ·
        Saved size policy applies · {filter === 'media' ? 'Media candidates' : 'All entries'}. Trash
        is excluded.
      </p>
      <nav aria-label="Preview breadcrumb" className="toolbar">
        {breadcrumbs(path).map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && ' / '}
            <button
              aria-current={crumb.path === path ? 'location' : undefined}
              onClick={() => navigate(crumb.path)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>
      <label>
        Preview filter{' '}
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value === 'all' ? 'all' : 'media');
            setHistory(['']);
          }}
        >
          <option value="media">Media candidates</option>
          <option value="all">Show all</option>
        </select>
      </label>
      <div aria-busy={query.isFetching}>
        <div aria-live="polite">
          {query.isFetching && <p>Loading contents…</p>}
          {query.isError && (
            <p role="alert">
              {cursor && 'The directory may have changed. '}
              {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>{' '}
              {cursor && <button onClick={() => setHistory([''])}>Restart preview</button>}
            </p>
          )}
          {!query.isError && !query.isFetching && query.data && (
            <p>
              {query.data.items.length
                ? `Showing ${query.data.items.length} entries. The directory may change before the next scan.`
                : filter === 'media'
                  ? 'No media candidates or folders. Use Show all to see other entries.'
                  : 'This directory is empty.'}
            </p>
          )}
        </div>
        {!query.isError && !!query.data?.items.length && (
          <table>
            <caption>Current directory entries — decisions if a scan started now</caption>
            <thead>
              <tr>
                {['Name', 'Kind', 'Size', 'Scan decision'].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((entry) => (
                <tr key={entry.name}>
                  <td data-label="Name">
                    {entry.decision === 'folder' ? (
                      <button onClick={() => navigate(path ? `${path}/${entry.name}` : entry.name)}>
                        {entry.name}
                      </button>
                    ) : (
                      entry.name
                    )}
                  </td>
                  <td data-label="Kind" className="group-kind">
                    {entry.kind}
                    {entry.type === 'symlink' && ' (symlink)'}
                  </td>
                  <td data-label="Size">{entry.size === null ? '—' : formatBytes(entry.size)}</td>
                  <td data-label="Scan decision">
                    {decisionLabel[entry.decision]}
                    {entry.decision_detail && `: ${entry.decision_detail}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="toolbar">
        <button
          disabled={history.length < 2 || query.isFetching}
          onClick={() => setHistory(pageCursors(history))}
        >
          Previous
        </button>
        <button
          disabled={!query.data?.next_cursor || query.isFetching || query.isError}
          onClick={() => setHistory(pageCursors(history, query.data?.next_cursor))}
        >
          Next
        </button>
        <button onClick={close}>Close preview</button>
      </div>
    </section>
  );
}
