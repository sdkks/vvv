import { getThumbnail } from './api';

export type PreviewState =
  { status: 'loading' | 'empty' | 'unavailable' } | { status: 'ready'; src: string };

export function loadGroupPreview(
  element: Element,
  fileId: number,
  update: (state: PreviewState) => void
) {
  const controller = new AbortController();
  let url = '';
  let started = false;
  let observer: IntersectionObserver | undefined;
  const load = () => {
    if (started || controller.signal.aborted) return;
    started = true;
    observer?.disconnect();
    void getThumbnail(fileId, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          url = URL.createObjectURL(blob);
          update({ status: 'ready', src: url });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) update({ status: 'unavailable' });
      });
  };
  if (typeof IntersectionObserver === 'undefined') load();
  else {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: '200px' }
    );
    observer.observe(element);
  }
  return () => {
    controller.abort();
    observer?.disconnect();
    if (url) URL.revokeObjectURL(url);
  };
}
