import type { Attachment, ChatMessage, Conversation, NetworkDiagnostics, User } from '../types/chat';

async function request<T>(
  url: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  }
  return data as T;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export const api = {
  register(payload: {
    fullName: string;
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
    avatarUrl?: string;
  }) {
    return request<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  login(payload: { identifier: string; password: string; rememberMe: boolean }) {
    return request<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  logout(token: string) {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }, token);
  },

  forgotPassword(identifier: string) {
    return request<{ message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    });
  },

  resetPassword(payload: {
    identifier: string;
    code: string;
    newPassword: string;
    confirmPassword: string;
  }) {
    return request<{ message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  changePassword(
    token: string,
    payload: { currentPassword: string; newPassword: string; confirmPassword: string }
  ) {
    return request<{ message: string }>(
      '/api/auth/change-password',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    );
  },

  async uploadFile(
    file: File,
    options: { token?: string | null; purpose?: 'avatar' | 'attachment' }
  ): Promise<Attachment> {
    const dataBase64 = await fileToBase64(file);
    return request<Attachment>(
      '/api/uploads',
      {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          dataBase64,
          purpose: options.purpose || 'attachment',
        }),
      },
      options.token
    );
  },

  searchUsers(token: string, query: string) {
    return request<{ users: User[] }>(
      `/api/users/search?q=${encodeURIComponent(query)}`,
      {},
      token
    );
  },

  updateProfile(
    token: string,
    payload: { fullName: string; statusText: string; avatarUrl: string }
  ) {
    return request<{ user: User }>(
      '/api/users/profile',
      { method: 'PATCH', body: JSON.stringify(payload) },
      token
    );
  },

  getConversations(token: string) {
    return request<{ conversations: Conversation[] }>('/api/conversations', {}, token);
  },

  startDirectConversation(token: string, username: string) {
    return request<{ conversationId: number }>(
      '/api/conversations/direct',
      { method: 'POST', body: JSON.stringify({ username }) },
      token
    );
  },

  getMessages(token: string, conversationId: number) {
    return request<{ messages: ChatMessage[] }>(
      `/api/conversations/${conversationId}/messages`,
      {},
      token
    );
  },

  createGroup(
    token: string,
    payload: { name: string; description: string; memberUsernames: string[] }
  ) {
    return request<{ groupId: number; conversationId: number }>(
      '/api/groups',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    );
  },

  addGroupMember(token: string, groupId: number, username: string) {
    return request<{ ok: boolean }>(
      `/api/groups/${groupId}/members`,
      { method: 'POST', body: JSON.stringify({ username }) },
      token
    );
  },

  removeGroupMember(token: string, groupId: number, userId: number) {
    return request<{ ok: boolean }>(
      `/api/groups/${groupId}/members/${userId}`,
      { method: 'DELETE' },
      token
    );
  },

  setGroupMemberRole(token: string, groupId: number, userId: number, role: 'admin' | 'member') {
    return request<{ ok: boolean }>(
      `/api/groups/${groupId}/members/${userId}/role`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
      token
    );
  },

  getNetworkDiagnostics(token: string) {
    return request<NetworkDiagnostics>('/api/network/diagnostics', {}, token);
  },
};
