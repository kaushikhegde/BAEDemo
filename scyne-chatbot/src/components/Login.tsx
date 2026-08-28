import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";

// The background image lives in /public so it's resolved at runtime. Drop any of
// these filenames into scyne-chatbot/public/ — the first one that exists wins.
// Falls back to the branded SVG that ships with the repo. No restart needed.
const LOGIN_BG_CANDIDATES = [
  "/login-bg.jpg",
  "/login-bg.png",
  "/login-bg.webp",
  "/image.png",
  "/image.jpg",
];
const LOGIN_BG_FALLBACK = "/login-bg.svg";

// Identity belongs to the orchestrator, for the whole install. This screen
// posts to the chatbot server, which forwards the credentials and stores the
// resulting session in an httpOnly cookie — so there is no token here to read,
// and nothing to keep in localStorage.

/** The signed-in person, exactly as `GET /api/auth/whoami` returns them. */
export interface LoginSession {
  id: string;
  email: string;
  name: string | null;
  role: string;
  company: { id: string; name: string; slug: string } | null;
  isSuperadmin: boolean;
}

/**
 * Ask the server who we are. The cookie is httpOnly, so this is the ONLY way
 * the app can find out — which is the point: a credential JavaScript cannot
 * read is a credential an injected script cannot steal.
 */
export async function loadSession(): Promise<LoginSession | null> {
  try {
    const res = await fetch("/api/auth/whoami", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as LoginSession;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* the cookie is the server's to clear; a network failure here is not fatal */
  }
}

interface LoginProps {
  onAuthenticated: (session: LoginSession) => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [bgUrl, setBgUrl] = useState(LOGIN_BG_FALLBACK);
  const userInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userInputRef.current?.focus(); }, []);

  // Probe candidate URLs in order; first hit wins. Falls back to the branded SVG.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of LOGIN_BG_CANDIDATES) {
        const ok = await new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = url;
        });
        if (cancelled) return;
        if (ok) { setBgUrl(url); return; }
      }
      if (!cancelled) setBgUrl(LOGIN_BG_FALLBACK);
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (submitting) return;
    setError(null);

    if (!user.trim() || !pass) {
      setError("Enter your email and password.");
      triggerShake();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `include`, or the browser discards the Set-Cookie the server sends.
        credentials: "include",
        body: JSON.stringify({ email: user.trim(), password: pass }),
      });
      if (res.ok) {
        onAuthenticated((await res.json()) as LoginSession);
        return;
      }
      const body = await res.json().catch(() => ({ error: "" }));
      setSubmitting(false);
      // The server deliberately gives one message for an unknown address and a
      // wrong password. Show its wording rather than inventing a friendlier
      // one that might imply which of the two it was.
      setError(String(body.error) || "Those credentials don't match. Try again.");
      triggerShake();
    } catch {
      setSubmitting(false);
      setError("Cannot reach the Scyne server. Is it running?");
      triggerShake();
    }
  }

  function triggerShake() {
    setShake(false);
    requestAnimationFrame(() => setShake(true));
    setTimeout(() => setShake(false), 400);
  }

  return (
    <div
      className="min-h-dvh w-full flex items-center justify-center bg-slate-900 bg-cover bg-center bg-no-repeat font-sans"
      style={{ backgroundImage: `url(${bgUrl})` }}
    >
      {/* Overlay — dark gradient for legibility (4.5:1 against white form text) */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-br from-slate-950/85 via-slate-900/70 to-scyne-deep/70"
      />
      {/* Subtle brand mesh on top */}
      <div aria-hidden className="absolute inset-0 bg-mesh opacity-50 mix-blend-screen" />

      <main className="relative z-10 mx-auto w-full max-w-[440px] px-6 animate-fade-in">
        {/* Brand mark */}
        <div className="flex items-center gap-3 mb-8 text-white">
          <span aria-hidden className="size-9 rounded-xl bg-brand-gradient shadow-glow" />
          <div className="leading-tight">
            <div className="text-[22px] font-semibold tracking-tight">scyne</div>
            <div className="text-[12px] tracking-wide text-white/70">
              AI Powered Software Delivery
            </div>
          </div>
        </div>

        <form
          onSubmit={submit}
          noValidate
          aria-labelledby="login-heading"
          className={`glass-strong rounded-2xl p-7 flex flex-col gap-5 ${shake ? "animate-shake" : ""} motion-reduce:animate-none`}
        >
          <div>
            <h1 id="login-heading" className="text-[20px] font-semibold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Sign in to orchestrate social insurance delivery.
            </p>
          </div>

          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-user" className="text-[12px] font-medium text-foreground">
              Email
            </label>
            <input
              ref={userInputRef}
              id="login-user"
              type="email"
              autoComplete="username"
              spellCheck={false}
              value={user}
              onChange={(e) => { setUser(e.target.value); if (error) setError(null); }}
              aria-invalid={!!error}
              aria-describedby={error ? "login-error" : undefined}
              disabled={submitting}
              className="h-11 px-3 rounded-lg bg-white border border-scyne-line text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-scyne-ink/40 focus:border-scyne-ink/40 transition-shadow disabled:opacity-60"
              placeholder="you@yourorg.com"
            />
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-pass" className="text-[12px] font-medium text-foreground">
              Password
            </label>
            <div className="relative">
              <input
                id="login-pass"
                type={showPass ? "text" : "password"}
                autoComplete="current-password"
                value={pass}
                onChange={(e) => { setPass(e.target.value); if (error) setError(null); }}
                aria-invalid={!!error}
                aria-describedby={error ? "login-error" : undefined}
                disabled={submitting}
                className="h-11 w-full pl-3 pr-11 rounded-lg bg-white border border-scyne-line text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-scyne-ink/40 focus:border-scyne-ink/40 transition-shadow disabled:opacity-60"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? "Hide password" : "Show password"}
                aria-pressed={showPass}
                disabled={submitting}
                className="absolute inset-y-0 right-0 flex items-center justify-center w-11 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-scyne-ink/40 rounded-r-lg transition-colors disabled:opacity-60"
              >
                {showPass ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div
              id="login-error"
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2 text-[12.5px] text-danger-600 bg-danger-50 border border-danger-500/30 rounded-lg px-3 py-2"
            >
              <AlertCircle className="size-4 mt-px shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {/* Submit */}
          <Button
            type="submit"
            disabled={submitting}
            className="h-11 w-full bg-brand-gradient text-white shadow-glow hover:shadow-elev-3 active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-scyne-glow focus-visible:ring-offset-2 transition-all duration-200 motion-reduce:transition-none"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span>Signing you in…</span>
              </>
            ) : (
              <>
                <LogIn className="size-4" aria-hidden />
                <span>Sign in</span>
              </>
            )}
          </Button>

          <p className="text-[11px] text-muted-foreground text-center">
            Local demo build · Authorised users only.
          </p>
        </form>
      </main>
    </div>
  );
}
