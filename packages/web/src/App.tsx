import { useState } from 'react';
import type { FormEvent } from 'react';
import { NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, SessionResponse } from '@vvv/shared';
import { api, login, returnLocation } from './api';
import { Groups } from './Groups';
import { Directories } from './Directories';
import { Scan } from './Scan';
import { Logs } from './Logs';
import { Trash } from './Trash';
import { Settings } from './Settings';
import { PageHeading } from './PageHeading';

export function loginPayload(data: FormData): LoginRequest {
  return {
    password: String(data.get('password') ?? ''),
    rememberMe: data.has('rememberMe'),
  };
}

function Login() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const cache = useQueryClient();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const body = loginPayload(new FormData(event.currentTarget));
    setPending(true);
    setError('');
    try {
      await login(body);
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
      <PageHeading>Sign in to VVV</PageHeading>
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
        <label className="scan-option" htmlFor="remember-me">
          <input
            id="remember-me"
            name="rememberMe"
            type="checkbox"
            aria-describedby="remember-me-hint"
            disabled={pending}
          />
          Remember me for 30 days
        </label>
        <p id="remember-me-hint" className="metadata">
          Requires a stable session secret to survive server restarts.
        </p>
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
        <NavLink to="/directories">Directories</NavLink>
        <NavLink to="/scan">Scan</NavLink>
        <NavLink to="/logs">Logs</NavLink>
        <NavLink to="/groups">Groups</NavLink>
        <NavLink to="/trash">Trash</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <Outlet />
    </>
  );
}

function Home() {
  return (
    <>
      <PageHeading>Home</PageHeading>
      <p>Add directories, scan your media, then review duplicate groups.</p>
      <NavLink to="/directories">Set up scan directories</NavLink>
    </>
  );
}

export function App() {
  return (
    <main>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route path="/groups/:id?" element={<Groups />} />
          <Route path="/directories" element={<Directories />} />
          <Route path="/scan" element={<Scan />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/trash" element={<Trash />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </main>
  );
}
