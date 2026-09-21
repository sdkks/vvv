import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, SessionResponse } from '@vvv/shared';
import { api, returnLocation } from './api';
import { Groups } from './Groups';

function Login() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const cache = useQueryClient();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    setPending(true);
    setError('');
    try {
      await api('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password } satisfies LoginRequest),
      });
      cache.clear();
      await navigate(returnLocation(location.search, window.location.origin), { replace: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in. Try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <h1>Sign in to VVV</h1>
      {location.search && <p role="status">Please sign in to continue where you left off.</p>}
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        aria-busy={pending}
      >
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-describedby="password-hint login-error"
          aria-invalid={Boolean(error)}
        />
        <p id="password-hint">Use the password configured with VVV_PASSWORD on your server.</p>
        <p id="login-error" role="alert">
          {error}
        </p>
        <button disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </>
  );
}

function Shell() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api<SessionResponse>('/auth/session'),
    retry: false,
  });
  if (session.isPending) return <p role="status">Checking session…</p>;
  if (session.isError)
    return (
      <>
        <p role="alert">{session.error.message}</p>
        <button
          onClick={() => {
            void session.refetch();
          }}
        >
          Retry
        </button>
      </>
    );
  return (
    <>
      <header>VVV — Veni Vidi Video</header>
      <nav className="toolbar" aria-label="Main navigation">
        <NavLink to="/">Home</NavLink>
        <NavLink to="/groups">Groups</NavLink>
      </nav>
      <Outlet />
    </>
  );
}

function Home() {
  return (
    <>
      <h1>Home</h1>
      <p>No scan directories yet.</p>
      <p>Directory setup and scanning are coming next.</p>
    </>
  );
}

export function App() {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, [location.pathname]);
  return (
    <main ref={main} tabIndex={-1}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route path="/groups/:id?" element={<Groups />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </main>
  );
}
