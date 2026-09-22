import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BrowseResponse } from '@vvv/shared';
import { api } from './api';
import { folderBreadcrumbs } from './directory-picker';
import { pageCursors } from './directory-preview';

export function DirectoryPicker({
  initialPath,
  close,
}: {
  initialPath?: string;
  close: (path?: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [history, setHistory] = useState(['']);
  const cursor = history.at(-1) ?? '';
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => modal?.close();
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [path]);
  const dismiss = (selected?: string) => {
    dialog.current?.close();
    close(selected);
  };
  const query = useQuery({
    queryKey: ['browse', path, cursor],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ cursor, limit: '100' });
      if (path !== undefined) params.set('path', path);
      return api<BrowseResponse>(`/browse?${params}`, { signal });
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const current = query.data?.path ?? path;
  const navigate = (next: string) => {
    setPath(next);
    setHistory(['']);
    heading.current?.focus();
  };
  return (
    <dialog
      ref={dialog}
      id="directory-picker"
      className="directory-preview directory-picker"
      aria-labelledby="picker-heading"
      aria-describedby="picker-description"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="directory-picker-surface">
        <div className="directory-picker-content">
          <h2 id="picker-heading" ref={heading} tabIndex={-1}>
            Choose directory{current ? `: ${current}` : ''}
          </h2>
          <p id="picker-description">
            Container folders only. Select fills the path; Add directory registers it.
          </p>
          <nav aria-label="Directory breadcrumb" className="toolbar">
            {folderBreadcrumbs(current ?? '/').map((crumb) => (
              <button
                key={crumb.path}
                type="button"
                aria-current={crumb.path === current ? 'location' : undefined}
                onClick={() => navigate(crumb.path)}
              >
                {crumb.name}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              navigate(String(new FormData(event.currentTarget).get('browse-path') ?? '').trim());
            }}
          >
            <label htmlFor="browse-path">Go to path</label>
            <div className="directory-path-row">
              <input
                key={current ?? ''}
                id="browse-path"
                name="browse-path"
                required
                defaultValue={current ?? ''}
                placeholder="/media"
              />
              <button>Go</button>
            </div>
          </form>
          <div aria-live="polite">
            {query.isFetching && <p>Loading folders…</p>}
            {query.isError && (
              <p role="alert">
                {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
              </p>
            )}
            {!query.isFetching && !query.isError && query.data?.items.length === 0 && (
              <p>{cursor ? 'No more subfolders.' : 'No subfolders — Select to use this path'}</p>
            )}
          </div>
          {!query.isError && (
            <ul className="folder-list" aria-busy={query.isFetching}>
              {query.data?.items.map((item) => (
                <li key={item.path}>
                  <button onClick={() => navigate(item.path)}>{item.name}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="directory-picker-footer">
          <nav className="toolbar" aria-label="Folder pages">
            <button
              disabled={history.length < 2 || query.isFetching}
              onClick={() => setHistory(pageCursors(history))}
            >
              Previous
            </button>
            <button
              disabled={!query.data?.next_cursor || query.isFetching || query.isError}
              onClick={() => {
                setPath(query.data?.path);
                setHistory(pageCursors(history, query.data?.next_cursor));
              }}
            >
              Next
            </button>
          </nav>
          <div className="toolbar">
            <button
              disabled={!query.data || query.isFetching || query.isError}
              onClick={() => dismiss(query.data?.path)}
            >
              Select
            </button>
            <button onClick={() => dismiss()}>Cancel</button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
