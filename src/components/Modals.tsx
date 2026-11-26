import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Users,
  Shield,
  UserPlus,
  Trash2,
  Upload,
  Moon,
  Sun,
  RefreshCw,
  Network,
  LogOut,
  Check,
} from 'lucide-react';
import { api } from '../services/api';
import type {
  GroupInfo,
  NetworkDiagnostics,
  TcpConnectionMetadata,
  User,
} from '../types/chat';
import { Avatar } from './Avatar';

interface ModalShellProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}

const ModalShell: React.FC<ModalShellProps> = ({
  title,
  subtitle,
  onClose,
  children,
  maxWidth = 'max-w-lg',
}) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
  >
    <div
      className={`w-full ${maxWidth} rounded-3xl bg-[#FAF7F4] dark:bg-[#241218] text-[#2A1219] dark:text-[#F5EDE5] border border-[#C58C91]/40 shadow-xl overflow-hidden flex flex-col max-h-[90vh]`}
    >
      <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-[#C58C91]/25">
        <div>
          <h3 className="font-display text-lg font-bold text-[#651F35] dark:text-[#F5EDE5]">
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs text-[#651F35]/75 dark:text-[#C58C91] mt-0.5">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close modal"
          className="p-2 rounded-xl hover:bg-[#C58C91]/20 text-[#651F35] dark:text-[#F5EDE5] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-6 overflow-y-auto">{children}</div>
    </div>
  </div>
);

// --- 1. Create Group Modal ---
interface NewGroupModalProps {
  token: string;
  onClose: () => void;
  onCreated: (conversationId: number) => void;
}

export const NewGroupModal: React.FC<NewGroupModalProps> = ({ token, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .searchUsers(token, query)
      .then((res) => setUsers(res.users))
      .catch(() => {});
  }, [token, query]);

  const toggleUser = (uname: string) => {
    setSelected((prev) =>
      prev.includes(uname) ? prev.filter((u) => u !== uname) : [...prev, uname]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (name.trim().length < 2) {
      setError('Group name must be at least 2 characters.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.createGroup(token, {
        name: name.trim(),
        description: description.trim(),
        memberUsernames: selected,
      });
      onCreated(res.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      title="Create a New Group"
      subtitle="You will be assigned as the group administrator."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300 bg-red-500/10 border border-red-400/30 rounded-xl px-3.5 py-2.5">
            {error}
          </p>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Group Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Networking Lab Team"
            className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2.5 text-sm outline-none focus:border-[#651F35]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description (optional)</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="TCP socket practical coordination"
            className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2.5 text-sm outline-none focus:border-[#651F35]"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium">Add Members</label>
            <span className="text-xs text-[#651F35] dark:text-[#C58C91] font-mono tabular-nums">
              {selected.length} selected
            </span>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search registered users..."
            className="w-full rounded-xl border border-[#C58C91]/40 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35] mb-2"
          />
          <div className="max-h-48 overflow-y-auto divide-y divide-[#C58C91]/20 rounded-xl border border-[#C58C91]/30 bg-[#F5EDE5]/60 dark:bg-[#190D11]/60">
            {users.length === 0 ? (
              <p className="p-4 text-xs text-center text-[#651F35]/70 dark:text-[#C58C91]">
                No other registered users found.
              </p>
            ) : (
              users.map((u) => {
                const isSelected = selected.includes(u.username);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleUser(u.username)}
                    className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-[#C58C91]/15 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={u.full_name} src={u.avatar_url} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{u.full_name}</p>
                        <p className="text-xs text-[#651F35]/70 dark:text-[#C58C91] truncate">
                          @{u.username}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`h-5 w-5 rounded-md flex items-center justify-center border ${
                        isSelected
                          ? 'bg-[#651F35] border-[#651F35] text-[#F5EDE5]'
                          : 'border-[#C58C91]/60'
                      }`}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-[#C58C91]/50 text-sm font-medium hover:bg-[#C58C91]/15"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] text-sm font-semibold disabled:opacity-60"
          >
            {loading ? 'Creating...' : 'Create Group'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

// --- 2. Group Management Modal ---
interface GroupManageModalProps {
  token: string;
  currentUser: User;
  group: GroupInfo;
  onClose: () => void;
  onUpdated: () => void;
  onLeftGroup: () => void;
}

export const GroupManageModal: React.FC<GroupManageModalProps> = ({
  token,
  currentUser,
  group,
  onClose,
  onUpdated,
  onLeftGroup,
}) => {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdmin = group.my_role === 'admin';
  const existingIds = new Set(group.members.map((m) => m.id));

  useEffect(() => {
    if (!isAdmin) return;
    api
      .searchUsers(token, search)
      .then((res) => setCandidates(res.users.filter((u) => !existingIds.has(u.id))))
      .catch(() => {});
  }, [token, search, isAdmin, group.members.length]);

  const handleAdd = async (username: string) => {
    setError('');
    setBusy(true);
    try {
      await api.addGroupMember(token, group.id, username);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add member');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (userId: number) => {
    setError('');
    setBusy(true);
    try {
      await api.removeGroupMember(token, group.id, userId);
      if (userId === currentUser.id) {
        onLeftGroup();
      } else {
        onUpdated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove member');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleRole = async (userId: number, currentRole: 'admin' | 'member') => {
    setError('');
    setBusy(true);
    try {
      await api.setGroupMemberRole(
        token,
        group.id,
        userId,
        currentRole === 'admin' ? 'member' : 'admin'
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update role');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={group.name}
      subtitle={`${group.member_count} members · ${group.description || 'Group conversation'}`}
      onClose={onClose}
    >
      <div className="space-y-5">
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300 bg-red-500/10 border border-red-400/30 rounded-xl px-3.5 py-2.5">
            {error}
          </p>
        )}

        <div>
          <h4 className="text-xs font-semibold text-[#651F35] dark:text-[#C58C91] mb-2">
            Members
          </h4>
          <div className="divide-y divide-[#C58C91]/20 rounded-xl border border-[#C58C91]/30 bg-[#F5EDE5]/50 dark:bg-[#190D11]/50">
            {group.members.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar
                    name={m.full_name}
                    src={m.avatar_url}
                    size="sm"
                    isOnline={m.is_online}
                    showPresence
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {m.full_name} {m.id === currentUser.id ? '(You)' : ''}
                    </p>
                    <p className="text-xs text-[#651F35]/70 dark:text-[#C58C91] truncate">
                      @{m.username} · {m.role === 'admin' ? 'Administrator' : 'Member'}
                    </p>
                  </div>
                </div>

                {isAdmin && m.id !== currentUser.id && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleToggleRole(m.id, m.role)}
                      title={m.role === 'admin' ? 'Remove admin role' : 'Make administrator'}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                        m.role === 'admin'
                          ? 'bg-[#651F35] text-[#F5EDE5] border-[#651F35]'
                          : 'border-[#C58C91]/60 text-[#651F35] dark:text-[#F5EDE5] hover:bg-[#C58C91]/20'
                      }`}
                    >
                      <Shield className="h-3.5 w-3.5 inline mr-1" />
                      {m.role === 'admin' ? 'Admin' : 'Promote'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleRemove(m.id)}
                      title="Remove member"
                      className="p-1.5 rounded-lg text-red-700 dark:text-red-300 hover:bg-red-500/15"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {isAdmin && (
          <div>
            <h4 className="text-xs font-semibold text-[#651F35] dark:text-[#C58C91] mb-2">
              Add New Members
            </h4>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users to add..."
              className="w-full rounded-xl border border-[#C58C91]/40 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35] mb-2"
            />
            <div className="max-h-40 overflow-y-auto divide-y divide-[#C58C91]/20 rounded-xl border border-[#C58C91]/30">
              {candidates.length === 0 ? (
                <p className="p-3 text-xs text-center text-[#651F35]/70 dark:text-[#C58C91]">
                  No additional registered users available.
                </p>
              ) : (
                candidates.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-3 px-3.5 py-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={u.full_name} src={u.avatar_url} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{u.full_name}</p>
                        <p className="text-xs text-[#651F35]/70 dark:text-[#C58C91]">@{u.username}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleAdd(u.username)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] text-xs font-semibold whitespace-nowrap"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Add
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-[#C58C91]/25">
          <button
            type="button"
            disabled={busy}
            onClick={() => handleRemove(currentUser.id)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-500/10"
          >
            <LogOut className="h-4 w-4" />
            Leave Group
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-[#651F35] text-[#F5EDE5] text-sm font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
};

// --- 3. Settings Modal ---
interface SettingsModalProps {
  token: string;
  user: User;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onUserUpdated: (user: User) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  token,
  user,
  darkMode,
  onToggleDarkMode,
  onUserUpdated,
  onClose,
}) => {
  const [fullName, setFullName] = useState(user.full_name);
  const [statusText, setStatusText] = useState(user.status_text || '');
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const uploaded = await api.uploadFile(file, { token, purpose: 'avatar' });
      setAvatarUrl(uploaded.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload avatar');
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMsg('');
    setSaving(true);
    try {
      const res = await api.updateProfile(token, {
        fullName: fullName.trim(),
        statusText: statusText.trim(),
        avatarUrl,
      });
      onUserUpdated(res.user);
      setMsg('Profile updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMsg('');
    setSaving(true);
    try {
      const res = await api.changePassword(token, {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMsg(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title="Account Settings"
      subtitle={`Signed in as @${user.username}`}
      onClose={onClose}
    >
      <div className="space-y-6">
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300 bg-red-500/10 border border-red-400/30 rounded-xl px-3.5 py-2.5">
            {error}
          </p>
        )}
        {msg && (
          <p className="text-sm text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3.5 py-2.5">
            {msg}
          </p>
        )}

        {/* Theme Switch */}
        <div className="flex items-center justify-between rounded-2xl border border-[#C58C91]/30 bg-[#F5EDE5]/60 dark:bg-[#190D11]/60 px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Appearance</p>
            <p className="text-xs text-[#651F35]/75 dark:text-[#C58C91]">
              {darkMode ? 'Dark Burgundy Muse active' : 'Light Soft Beige active (default)'}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleDarkMode}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#651F35] text-[#F5EDE5] text-xs font-semibold whitespace-nowrap"
          >
            {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {darkMode ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>

        {/* Profile Form */}
        <form onSubmit={handleSaveProfile} className="space-y-3.5">
          <div className="flex items-center gap-4">
            <Avatar name={fullName || user.username} src={avatarUrl} size="xl" />
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-[#C58C91]/60 text-xs font-semibold hover:bg-[#C58C91]/15"
              >
                <Upload className="h-3.5 w-3.5" />
                Change Photo
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Status Line</label>
            <input
              type="text"
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35]"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] text-sm font-semibold"
          >
            Save Profile
          </button>
        </form>

        {/* Change Password */}
        <form
          onSubmit={handlePasswordUpdate}
          className="space-y-3 pt-4 border-t border-[#C58C91]/25"
        >
          <h4 className="text-sm font-semibold text-[#651F35] dark:text-[#F5EDE5]">
            Update Password
          </h4>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35]"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35]"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-3.5 py-2 text-sm outline-none focus:border-[#651F35]"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-xl border border-[#651F35] text-[#651F35] dark:text-[#F5EDE5] dark:border-[#C58C91] text-sm font-semibold hover:bg-[#651F35]/10"
          >
            Change Password
          </button>
        </form>
      </div>
    </ModalShell>
  );
};

// --- 4. TCP Socket & Network Inspector Modal (Academic Demonstration) ---
interface NetworkInspectorModalProps {
  token: string;
  myConnection: TcpConnectionMetadata | null;
  onClose: () => void;
}

export const NetworkInspectorModal: React.FC<NetworkInspectorModalProps> = ({
  token,
  myConnection,
  onClose,
}) => {
  const [diag, setDiag] = useState<NetworkDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getNetworkDiagnostics(token);
      setDiag(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to query TCP server');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token]);

  return (
    <ModalShell
      title="TCP Socket & Framing Inspector"
      subtitle="Live telemetry queried directly from the dedicated Python TCP server."
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-[#651F35] dark:text-[#C58C91]">
            <Network className="h-4 w-4" />
            <span>Browser (WebSocket) → Gateway (:3000) → Python TCP Server (:9000)</span>
          </div>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#651F35] text-[#F5EDE5] text-xs font-semibold"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-700 dark:text-red-300 bg-red-500/10 border border-red-400/30 rounded-xl px-3.5 py-2.5">
            {error}
          </p>
        )}

        {myConnection && (
          <div className="rounded-2xl border border-[#C58C91]/35 bg-[#F5EDE5]/70 dark:bg-[#190D11]/70 p-4">
            <h4 className="text-xs font-semibold text-[#651F35] dark:text-[#C58C91] mb-2.5">
              Your Active TCP Session 4-Tuple
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
              <div>
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Client IP</p>
                <p className="font-semibold mt-0.5">{myConnection.client_ip}</p>
              </div>
              <div>
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Source Port</p>
                <p className="font-semibold mt-0.5">{myConnection.source_port}</p>
              </div>
              <div>
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Server IP</p>
                <p className="font-semibold mt-0.5">{myConnection.server_ip}</p>
              </div>
              <div>
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Destination Port</p>
                <p className="font-semibold mt-0.5">{myConnection.destination_port}</p>
              </div>
            </div>
          </div>
        )}

        {diag && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="rounded-2xl border border-[#C58C91]/30 p-3.5">
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Listening Socket</p>
                <p className="font-mono font-semibold mt-1 tabular-nums">
                  {diag.gateway.tcpTargetHost}:{diag.gateway.tcpTargetPort}
                </p>
              </div>
              <div className="rounded-2xl border border-[#C58C91]/30 p-3.5">
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Framing Protocol</p>
                <p className="font-mono font-semibold mt-1">NDJSON (\n-delimited)</p>
              </div>
              <div className="rounded-2xl border border-[#C58C91]/30 p-3.5">
                <p className="text-[#651F35]/70 dark:text-[#C58C91]">Active TCP Sockets</p>
                <p className="font-mono font-semibold mt-1 tabular-nums">
                  {diag.tcpServer.active_connections.length} connected
                </p>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-[#651F35] dark:text-[#C58C91] mb-2">
                Connected TCP Sessions on Port {diag.tcpServer.server.port}
              </h4>
              <div className="overflow-x-auto rounded-2xl border border-[#C58C91]/30">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="bg-[#651F35] text-[#F5EDE5]">
                    <tr>
                      <th className="px-3 py-2.5">User</th>
                      <th className="px-3 py-2.5">Client Socket</th>
                      <th className="px-3 py-2.5">Server Socket</th>
                      <th className="px-3 py-2.5 text-right">RX / TX</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#C58C91]/20">
                    {diag.tcpServer.active_connections.map((conn) => (
                      <tr key={conn.session_id} className="hover:bg-[#C58C91]/10">
                        <td className="px-3 py-2 font-sans font-medium">
                          {conn.username ? `@${conn.username}` : conn.client_label}
                        </td>
                        <td className="px-3 py-2">
                          {conn.client_ip}:{conn.source_port}
                        </td>
                        <td className="px-3 py-2">
                          {conn.server_ip}:{conn.destination_port}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {conn.bytes_received}B / {conn.bytes_sent}B
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
};
