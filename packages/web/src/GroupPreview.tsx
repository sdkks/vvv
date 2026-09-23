import { useEffect, useRef, useState } from 'react';
import type { GroupListItem } from '@vvv/shared';
import { loadGroupPreview, type PreviewState } from './group-preview';

export function PreviewContent({ state, onError }: { state: PreviewState; onError: () => void }) {
  if (state.status === 'ready') return <img src={state.src} alt="" onError={onError} />;
  return state.status === 'empty'
    ? 'No preview'
    : state.status === 'unavailable'
      ? 'Preview unavailable'
      : 'Loading…';
}

export function GroupPreview({
  representative,
}: {
  representative: GroupListItem['representative'];
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const fileId = representative?.file_id;
  useEffect(() => {
    if (fileId === undefined || !box.current) return;
    setState({ status: 'loading' });
    return loadGroupPreview(box.current, fileId, setState);
  }, [fileId]);
  return (
    <span className="group-preview thumbnail fallback" ref={box}>
      <PreviewContent
        state={representative ? state : { status: 'empty' }}
        onError={() => setState({ status: 'unavailable' })}
      />
    </span>
  );
}
