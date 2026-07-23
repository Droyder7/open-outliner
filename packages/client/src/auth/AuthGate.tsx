import { useEffect, useState } from 'react';
import { createRpcClient, RpcClientError } from '../rpc.js';

/**
 * Minimal auth gate for server-synced mode (Phase 5/6): resolves the current
 * session via `WhoAmI`, or shows a Signup/Login form. Local-only mode (no
 * `VITE_SYNC_URL`) never renders this — the app stays a fully usable
 * offline outliner with no account (App.tsx).
 */

const rpc = createRpcClient();

export interface AuthedUser {
  userId: string;
  workspaceIds: string[];
}

export function AuthGate({
  children,
}: {
  children: (user: AuthedUser) => JSX.Element;
}): JSX.Element {
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    rpc
      .call('WhoAmI', {})
      .then((who) => {
        if (alive) setUser(who);
      })
      .catch(() => {
        // Not logged in — expected, show the form.
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await rpc.call('Signup', { email, password });
      } else {
        await rpc.call('Login', { email, password });
      }
      const who = await rpc.call('WhoAmI', {});
      setUser(who);
    } catch (err) {
      setError(err instanceof RpcClientError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <div className="loading">Loading…</div>;
  if (user) return children(user);

  return (
    <div className="auth-gate">
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <h2>{mode === 'login' ? 'Log in' : 'Create an account'}</h2>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={busy}>
          {mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
        <button
          type="button"
          className="auth-switch"
          onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
        </button>
      </form>
    </div>
  );
}
