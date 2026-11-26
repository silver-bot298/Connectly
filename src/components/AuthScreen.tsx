import React, { useRef, useState } from 'react';
import { Eye, EyeOff, Moon, Sun, Upload, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { api } from '../services/api';
import type { User } from '../types/chat';
import { BrandLogo } from './BrandLogo';

interface AuthScreenProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onAuthenticated: (token: string, user: User) => void;
}

type AuthMode = 'login' | 'register' | 'forgot';

export const AuthScreen: React.FC<AuthScreenProps> = ({
  darkMode,
  onToggleDarkMode,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // Login fields
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showLoginPw, setShowLoginPw] = useState(false);

  // Register fields
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showRegPw, setShowRegPw] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Forgot / reset password fields
  const [forgotIdentifier, setForgotIdentifier] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'verify'>('request');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError('');
    setSuccess('');
    setResetStep('request');
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setAvatarUploading(true);
    try {
      const uploaded = await api.uploadFile(file, { purpose: 'avatar' });
      setAvatarUrl(uploaded.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload profile picture');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!identifier.trim() || !password) {
      setError('Please enter your email or username and password.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.login({ identifier: identifier.trim(), password, rememberMe });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (fullName.trim().length < 2) {
      setError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username.trim())) {
      setError('Username must be 3–24 characters using letters, numbers, or underscores.');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    if (regPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (regPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.register({
        fullName: fullName.trim(),
        username: username.trim(),
        email: email.trim(),
        password: regPassword,
        confirmPassword,
        avatarUrl,
      });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account creation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!forgotIdentifier.trim()) {
      setError('Enter your registered email or username.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.forgotPassword(forgotIdentifier.trim());
      setSuccess(res.message);
      setResetStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request password reset');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword.length < 6 || newPassword !== confirmNewPassword) {
      setError('New password must be at least 6 characters and match confirmation.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.resetPassword({
        identifier: forgotIdentifier.trim(),
        code: resetCode.trim(),
        newPassword,
        confirmPassword: confirmNewPassword,
      });
      setSuccess(res.message);
      setTimeout(() => switchMode('login'), 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F5EDE5] dark:bg-[#190D11] text-[#2A1219] dark:text-[#F5EDE5] flex flex-col lg:flex-row">
      {/* Left Brand & Architecture Showcase */}
      <div className="lg:w-[46%] bg-[#651F35] text-[#F5EDE5] p-8 sm:p-12 lg:p-14 flex flex-col justify-between relative overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandLogo size={40} variant="light" />
            <span className="font-display text-xl font-bold tracking-tight">Connectly</span>
          </div>
          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-2.5 rounded-xl bg-[#F5EDE5]/10 hover:bg-[#F5EDE5]/20 text-[#F5EDE5] transition-colors"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>

        <div className="my-10 lg:my-0 space-y-6 max-w-lg">
          <h1
            className="font-display text-3xl sm:text-4xl font-bold leading-tight tracking-tight"
            style={{ textWrap: 'balance' }}
          >
            Direct, reliable messaging built on dedicated TCP streams.
          </h1>
          <p className="text-[#F5EDE5]/80 text-base leading-relaxed">
            Exchange instant one-to-one messages and collaborate in multi-member groups. Every
            browser session bridges over WebSockets directly to Connectly’s Python TCP socket
            server with newline-delimited JSON framing and persistent history.
          </p>

          <div className="rounded-2xl overflow-hidden border border-[#C58C91]/30 bg-[#53172A] aspect-[4/3]">
            <img
              src="/src/assets/images/connectly_auth_illustration_1795606184713.jpg"
              alt="Interwoven geometric pathways representing Connectly TCP socket communication"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#F5EDE5]/75 font-mono tabular-nums">
          <span>TCP Socket Server :9000</span>
          <span aria-hidden="true">·</span>
          <span>NDJSON Framing</span>
          <span aria-hidden="true">·</span>
          <span>SQLite Persistence</span>
        </div>
      </div>

      {/* Right Authentication Form Surface */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md bg-[#FAF7F4] dark:bg-[#241218] border border-[#C58C91]/35 dark:border-[#C58C91]/20 rounded-3xl p-7 sm:p-9 shadow-sm">
          {mode !== 'forgot' ? (
            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#F5EDE5] dark:bg-[#190D11] border border-[#C58C91]/25 mb-7">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-[#651F35] text-[#F5EDE5]'
                    : 'text-[#651F35] dark:text-[#C58C91] hover:bg-[#C58C91]/15'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={`flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  mode === 'register'
                    ? 'bg-[#651F35] text-[#F5EDE5]'
                    : 'text-[#651F35] dark:text-[#C58C91] hover:bg-[#C58C91]/15'
                }`}
              >
                Create Account
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="inline-flex items-center gap-2 text-sm font-medium text-[#651F35] dark:text-[#C58C91] hover:underline mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Sign In
            </button>
          )}

          {error && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div
              role="status"
              className="mb-5 flex items-start gap-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{success}</span>
            </div>
          )}

          {mode === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <h2 className="font-display text-2xl font-bold text-[#651F35] dark:text-[#F5EDE5]">
                  Welcome back
                </h2>
                <p className="text-sm text-[#651F35]/75 dark:text-[#C58C91] mt-1">
                  Sign in with your Connectly username or email address.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="login-identifier">
                  Email or Username
                </label>
                <input
                  id="login-identifier"
                  type="text"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="grace or grace@university.edu"
                  className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="login-password">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showLoginPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 pr-11 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPw((v) => !v)}
                    aria-label={showLoginPw ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#651F35]/70 dark:text-[#C58C91] hover:text-[#651F35]"
                  >
                    {showLoginPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-[#C58C91] accent-[#651F35]"
                  />
                  <span>Remember me</span>
                </label>

                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-sm font-medium text-[#651F35] dark:text-[#C58C91] hover:underline"
                >
                  Forgot password?
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-3 px-5 rounded-xl bg-[#651F35] hover:bg-[#53172A] disabled:opacity-60 text-[#F5EDE5] font-semibold text-sm transition-colors cursor-pointer"
              >
                {loading ? 'Signing in...' : 'Login'}
              </button>
            </form>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <h2 className="font-display text-2xl font-bold text-[#651F35] dark:text-[#F5EDE5]">
                  Create your account
                </h2>
                <p className="text-sm text-[#651F35]/75 dark:text-[#C58C91] mt-1">
                  Register a profile to connect with peers over TCP.
                </p>
              </div>

              <div className="flex items-center gap-4 pt-1">
                <div className="h-14 w-14 rounded-full bg-[#651F35] text-[#F5EDE5] flex items-center justify-center font-display font-semibold overflow-hidden border border-[#C58C91]/60 shrink-0">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Profile preview" className="h-full w-full object-cover" />
                  ) : (
                    <span>{(fullName.trim()[0] || 'C').toUpperCase()}</span>
                  )}
                </div>
                <div className="flex-1">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-[#C58C91]/60 text-xs font-semibold text-[#651F35] dark:text-[#F5EDE5] hover:bg-[#C58C91]/15 transition-colors"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {avatarUploading ? 'Uploading...' : 'Profile picture (optional)'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="reg-fullname">
                  Full name
                </label>
                <input
                  id="reg-fullname"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Grace Agorson"
                  className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1" htmlFor="reg-username">
                    Username
                  </label>
                  <input
                    id="reg-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="grace"
                    className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" htmlFor="reg-email">
                    Email address
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="grace@university.edu"
                    className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="reg-password">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="reg-password"
                    type={showRegPw ? 'text' : 'password'}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 pr-11 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegPw((v) => !v)}
                    aria-label={showRegPw ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#651F35]/70 dark:text-[#C58C91]"
                  >
                    {showRegPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="reg-confirm">
                  Confirm password
                </label>
                <input
                  id="reg-confirm"
                  type={showRegPw ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35] focus:ring-2 focus:ring-[#C58C91]/40"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-3 px-5 rounded-xl bg-[#651F35] hover:bg-[#53172A] disabled:opacity-60 text-[#F5EDE5] font-semibold text-sm transition-colors cursor-pointer"
              >
                {loading ? 'Creating account...' : 'Create account'}
              </button>
            </form>
          )}

          {mode === 'forgot' && (
            <div className="space-y-4">
              <div>
                <h2 className="font-display text-2xl font-bold text-[#651F35] dark:text-[#F5EDE5]">
                  Reset password
                </h2>
                <p className="text-sm text-[#651F35]/75 dark:text-[#C58C91] mt-1">
                  {resetStep === 'request'
                    ? 'Enter your email or username to issue a 6-digit verification code.'
                    : 'Enter the 6-digit code logged on the server console and choose a new password.'}
                </p>
              </div>

              {resetStep === 'request' ? (
                <form onSubmit={handleRequestReset} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1.5" htmlFor="forgot-id">
                      Email or Username
                    </label>
                    <input
                      id="forgot-id"
                      type="text"
                      value={forgotIdentifier}
                      onChange={(e) => setForgotIdentifier(e.target.value)}
                      placeholder="grace or grace@university.edu"
                      className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] font-semibold text-sm transition-colors"
                  >
                    {loading ? 'Issuing code...' : 'Send verification code'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleResetPassword} className="space-y-3.5">
                  <div>
                    <label className="block text-sm font-medium mb-1" htmlFor="reset-code">
                      6-digit verification code
                    </label>
                    <input
                      id="reset-code"
                      type="text"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      placeholder="123456"
                      className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm font-mono outline-none focus:border-[#651F35]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" htmlFor="reset-new-pw">
                      New password
                    </label>
                    <input
                      id="reset-new-pw"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Minimum 6 characters"
                      className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" htmlFor="reset-confirm-pw">
                      Confirm new password
                    </label>
                    <input
                      id="reset-confirm-pw"
                      type="password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] font-semibold text-sm transition-colors"
                  >
                    {loading ? 'Updating...' : 'Reset password'}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
