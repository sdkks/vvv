import { useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
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
  const [media] = useState(() => window.matchMedia('(max-width: 60rem)'));
  const [narrow, setNarrow] = useState(media.matches);
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const restoreNavFocus = useRef(false);
  const location = useLocation();

  useEffect(() => {
    function resize(event: MediaQueryListEvent) {
      setMenuOpen(event.matches && Boolean(nav.current?.contains(document.activeElement)));
      restoreNavFocus.current = !event.matches && document.activeElement === menu.current;
      setNarrow(event.matches);
    }
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [media]);

  useEffect(() => {
    if (!narrow && restoreNavFocus.current) {
      const link =
        nav.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ??
        nav.current?.querySelector<HTMLAnchorElement>('a');
      link?.focus();
    }
    restoreNavFocus.current = false;
  }, [narrow]);

  useEffect(() => {
    if (media.matches && nav.current?.contains(document.activeElement)) content.current?.focus();
    setMenuOpen(false);
  }, [location.key, media]);

  function selectDestination(event: MouseEvent<HTMLElement>) {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (
      !narrow ||
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      (link.target && link.target !== '_self')
    )
      return;
    if (nav.current?.contains(document.activeElement)) content.current?.focus();
    setMenuOpen(false);
  }

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api<SessionResponse>('/auth/session'),
    retry: false,
  });
  if (session.isPending)
    return (
      <main className="standalone-surface">
        <p role="status">Checking session…</p>
      </main>
    );
  if (session.isError)
    return (
      <main className="standalone-surface">
        <p role="alert">{session.error.message}</p>
        <button
          onClick={() => {
            void session.refetch();
          }}
        >
          Retry
        </button>
      </main>
    );
  return (
    <div className="app-shell" data-layout={narrow ? 'narrow' : 'desktop'}>
      <div className="shell-sidebar">
        <header>VVV — Veni Vidi Video</header>
        <button
          ref={menu}
          className="shell-menu"
          type="button"
          hidden={!narrow}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={(event) => {
            event.currentTarget.focus();
            setMenuOpen((open) => !open);
          }}
        >
          Menu
        </button>
        <nav
          ref={nav}
          id="main-navigation"
          className="shell-nav"
          aria-label="Main navigation"
          hidden={narrow && !menuOpen}
          onClickCapture={selectDestination}
        >
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/directories">Directories</NavLink>
          <NavLink to="/scan">Scan</NavLink>
          <NavLink to="/logs">Logs</NavLink>
          <NavLink to="/groups">Groups</NavLink>
          <NavLink to="/trash">Trash</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </div>
      <main ref={content} id="content" className="content-surface" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

function Home() {
  return (
    <div className="home-intro">
      <div className="home-instructions">
        <PageHeading>Home</PageHeading>
        <p>Add directories, scan your media, then review duplicate groups.</p>
        <NavLink to="/directories">Set up scan directories</NavLink>
      </div>
      <img
        className="home-illustration"
        src="/home-duplicates.svg"
        alt=""
        width="352"
        height="256"
      />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <main className="standalone-surface">
            <Login />
          </main>
        }
      />
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
  );
}
