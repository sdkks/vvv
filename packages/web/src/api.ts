export function returnLocation(search: string, origin: string) {
  const target = new URLSearchParams(search).get('returnTo') ?? '/';
  try {
    const url = new URL(target, origin);
    return url.origin === origin && url.pathname !== '/login'
      ? url.pathname + url.search + url.hash
      : '/';
  } catch {
    return '/';
  }
}

export async function api<T = void>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin' });
  if (response.status === 401) {
    if (path !== '/auth/login' && window.location.pathname !== '/login') {
      const { pathname, search, hash } = window.location;
      window.location.replace(`/login?returnTo=${encodeURIComponent(pathname + search + hash)}`);
    }
    throw new Error(
      path === '/auth/login' ? 'Incorrect password. Try again.' : 'Please sign in again.'
    );
  }
  if (!response.ok) throw new Error('Request failed. Check the server and try again.');
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
