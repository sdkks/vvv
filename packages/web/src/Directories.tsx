import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addScanDir, getScanDirs, removeScanDir, updateScanDir } from './api';
import { PageHeading } from './PageHeading';
import { DirectoryPreview } from './DirectoryPreview';
import { DirectoryPicker } from './DirectoryPicker';
import { finishPicking, pickerStartPath } from './directory-picker';

const options = [
  ['follow_symlinks', 'Follow symbolic links'],
  ['cross_filesystems', 'Cross filesystem boundaries'],
] as const;
export function Directories() {
  const cache = useQueryClient();
  const pathInput = useRef<HTMLInputElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<{ path?: string } | null>(null);
  const query = useQuery({
    queryKey: ['scan-dirs'],
    queryFn: ({ signal }) => getScanDirs(signal),
    retry: false,
  });
  const action = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['scan-dirs'] }),
  });
  return (
    <>
      <PageHeading>Scan directories</PageHeading>
      <p id="directory-hint">
        Use paths as mounted inside the container, such as /media, not host paths.
      </p>
      {query.data?.items.length === 0 && (
        <p>No scan directories yet. Add a directory below, then start a scan.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          action.mutate(() =>
            addScanDir({
              path: String(data.get('path') ?? '').trim(),
              follow_symlinks: data.has('follow_symlinks'),
              cross_filesystems: data.has('cross_filesystems'),
            }).then(() => form.reset())
          );
        }}
        aria-busy={action.isPending}
      >
        <label htmlFor="directory-path">Directory path</label>
        <div className="directory-path-row">
          <input
            ref={pathInput}
            id="directory-path"
            name="path"
            required
            aria-describedby="directory-hint"
          />
          <button
            ref={browseButton}
            type="button"
            aria-expanded={picker !== null}
            aria-controls="directory-picker"
            onClick={() =>
              setPicker(picker ? null : { path: pickerStartPath(pathInput.current?.value ?? '') })
            }
          >
            Browse…
          </button>
        </div>
        {options.map(([key, label]) => (
          <label className="scan-option" key={key}>
            <input type="checkbox" name={key} disabled={action.isPending} />
            {label}
          </label>
        ))}
        <button disabled={action.isPending}>Add directory</button>
      </form>
      {picker && (
        <DirectoryPicker
          initialPath={picker.path}
          close={(path) =>
            finishPicking(() => setPicker(null), pathInput.current, browseButton.current, path)
          }
        />
      )}
      {action.isError && <p role="alert">{action.error.message}</p>}
      {action.isSuccess && <p role="status">Directory settings saved.</p>}
      {query.isPending && <p role="status">Loading directories…</p>}
      {query.isError && (
        <p role="alert">
          {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      <ul className="scan-list">
        {query.data?.items.map((dir) => (
          <li key={dir.id}>
            <fieldset disabled={action.isPending}>
              <legend>{dir.path}</legend>
              <p>{dir.file_count} catalogued files</p>
              {options.map(([key, label]) => (
                <label className="scan-option" key={key}>
                  <input
                    type="checkbox"
                    checked={dir[key]}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      action.mutate(() => updateScanDir(dir.id, { [key]: checked }));
                    }}
                  />
                  {label}
                </label>
              ))}
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${dir.path}? Its catalog and trash metadata will be discarded. Files on disk are not deleted. Restore or purge trash first if needed.`
                    )
                  )
                    action.mutate(() =>
                      removeScanDir(dir.id).then(() => pathInput.current?.focus())
                    );
                }}
              >
                Remove directory
              </button>{' '}
              <DirectoryPreview dir={dir} />
            </fieldset>
          </li>
        ))}
      </ul>
      <Link to="/scan">Go to scan</Link>
    </>
  );
}
