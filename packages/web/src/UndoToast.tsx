import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restoreTrash } from './api';
import { fileFailure } from './trash-state';

export function UndoToast({ ids }: { ids: number[] }) {
  const [visible, setVisible] = useState(true);
  const cache = useQueryClient();
  const undo = useMutation({
    mutationFn: () => restoreTrash(ids),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['groups'] });
      await cache.invalidateQueries({ queryKey: ['trash'] });
    },
  });
  useEffect(() => {
    if (undo.isPending) return;
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, [undo.isPending]);
  if (!visible) return null;
  return (
    <aside role="status" aria-live="polite">
      {undo.data
        ? `Restored ${undo.data.restored.length} files`
        : `Quarantined ${ids.length} files — `}
      {!undo.data && (
        <button disabled={undo.isPending} onClick={() => undo.mutate()}>
          {undo.isPending ? 'Restoring…' : 'Undo'}
        </button>
      )}
      {undo.isError && <p>{undo.error.message}</p>}
      {undo.data?.failed.map((failure) => (
        <p key={failure.trash_id}>
          Trash item {failure.trash_id}: {fileFailure(failure.error)} Open Trash to retry.
        </p>
      ))}
    </aside>
  );
}
