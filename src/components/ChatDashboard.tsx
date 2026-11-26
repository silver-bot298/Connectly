import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  MailWarning,
  Users,
  Contact,
  Settings,
  LogOut,
  Search,
  Send,
  Paperclip,
  Smile,
  Check,
  CheckCheck,
  Plus,
  ArrowLeft,
  Network,
  FileText,
  Download,
  X,
  WifiOff,
  SlidersHorizontal,
  Moon,
  Sun,
} from 'lucide-react';
import { api } from '../services/api';
import type {
  Attachment,
  ChatMessage,
  Conversation,
  TcpConnectionMetadata,
  User,
} from '../types/chat';
import { Avatar } from './Avatar';
import { BrandLogo } from './BrandLogo';
import {
  GroupManageModal,
  NetworkInspectorModal,
  NewGroupModal,
  SettingsModal,
} from './Modals';

type SidebarSection = 'all' | 'unread' | 'groups' | 'contacts';

interface ChatDashboardProps {
  token: string;
  currentUser: User;
  conversations: Conversation[];
  activeConversationId: number | null;
  messagesByConv: Record<number, ChatMessage[]>;
  typingByConv: Record<number, string[]>;
  wsStatus: 'connected' | 'connecting' | 'disconnected';
  myTcpConnection: TcpConnectionMetadata | null;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onSelectConversation: (convId: number | null) => void;
  onSendMessage: (payload: {
    conversationId: number;
    text: string;
    attachment?: Attachment | null;
  }) => void;
  onSendTyping: (conversationId: number, isTyping: boolean) => void;
  onRefreshConversations: () => Promise<void>;
  onUserUpdated: (user: User) => void;
  onLogout: () => void;
}

const EMOJI_PALETTE = [
  '😊', '👋', '👍', '❤️', '🎉', '🔥', '😂', '🙌',
  '👏', '💡', '✅', '🚀', '📌', '💬', '🤝', '✨',
  '😎', '🤔', '🙏', '💯', '📅', '📎', '🔒', '⚡',
];

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatListTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDateHeading(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ChatDashboard: React.FC<ChatDashboardProps> = ({
  token,
  currentUser,
  conversations,
  activeConversationId,
  messagesByConv,
  typingByConv,
  wsStatus,
  myTcpConnection,
  darkMode,
  onToggleDarkMode,
  onSelectConversation,
  onSendMessage,
  onSendTyping,
  onRefreshConversations,
  onUserUpdated,
  onLogout,
}) => {
  const [section, setSection] = useState<SidebarSection>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [contacts, setContacts] = useState<User[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<Attachment | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showGroupManage, setShowGroupManage] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | null>(null);
  const isCurrentlyTypingRef = useRef(false);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  );

  const activeMessages = activeConversationId ? messagesByConv[activeConversationId] || [] : [];
  const typingUsers = activeConversationId ? typingByConv[activeConversationId] || [] : [];

  const totalUnread = useMemo(
    () => conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0),
    [conversations]
  );

  // Fetch registered contacts when browsing Contacts or searching
  useEffect(() => {
    if (section !== 'contacts' && !searchQuery.trim()) return;
    let cancelled = false;
    setContactsLoading(true);
    api
      .searchUsers(token, searchQuery.trim())
      .then((res) => {
        if (!cancelled) setContacts(res.users);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setContactsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, section, searchQuery]);

  // Auto-scroll message history on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length, activeConversationId, typingUsers.length]);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return conversations.filter((conv) => {
      if (section === 'unread' && conv.unread_count <= 0) return false;
      if (section === 'groups' && conv.type !== 'group') return false;
      if (!q) return true;
      const title =
        conv.type === 'group'
          ? conv.group?.name || ''
          : `${conv.peer?.full_name || ''} ${conv.peer?.username || ''}`;
      const preview = conv.last_message?.content || '';
      return title.toLowerCase().includes(q) || preview.toLowerCase().includes(q);
    });
  }, [conversations, section, searchQuery]);

  const handleStartDirectChat = async (username: string) => {
    try {
      const res = await api.startDirectConversation(token, username);
      await onRefreshConversations();
      onSelectConversation(res.conversationId);
      setSection('all');
      setSearchQuery('');
    } catch {
      // Handled gracefully
    }
  };

  const handleDraftChange = (val: string) => {
    setDraft(val);
    if (!activeConversationId) return;

    if (val.trim().length > 0) {
      if (!isCurrentlyTypingRef.current) {
        isCurrentlyTypingRef.current = true;
        onSendTyping(activeConversationId, true);
      }
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(() => {
        if (isCurrentlyTypingRef.current && activeConversationId) {
          isCurrentlyTypingRef.current = false;
          onSendTyping(activeConversationId, false);
        }
      }, 2200);
    } else if (isCurrentlyTypingRef.current) {
      isCurrentlyTypingRef.current = false;
      onSendTyping(activeConversationId, false);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');
    setUploadingFile(true);
    try {
      const uploaded = await api.uploadFile(file, { token, purpose: 'attachment' });
      setPendingAttachment(uploaded);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'File upload failed');
    } finally {
      setUploadingFile(false);
    }
  };

  const submitMessage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!activeConversationId) return;
    const text = draft.trim();
    if (!text && !pendingAttachment) return;

    onSendMessage({
      conversationId: activeConversationId,
      text,
      attachment: pendingAttachment,
    });

    setDraft('');
    setPendingAttachment(null);
    setShowEmojiPicker(false);
    setUploadError('');
    if (isCurrentlyTypingRef.current) {
      isCurrentlyTypingRef.current = false;
      onSendTyping(activeConversationId, false);
    }
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  };

  const navItems: Array<{
    id: SidebarSection;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    { id: 'all', label: 'All Chats', icon: <MessageSquare className="h-4 w-4" /> },
    {
      id: 'unread',
      label: 'Unread',
      icon: <MailWarning className="h-4 w-4" />,
      badge: totalUnread,
    },
    { id: 'groups', label: 'Groups', icon: <Users className="h-4 w-4" /> },
    { id: 'contacts', label: 'Contacts', icon: <Contact className="h-4 w-4" /> },
  ];

  return (
    <div className="h-screen w-full overflow-hidden bg-[#F5EDE5] dark:bg-[#190D11] text-[#2A1219] dark:text-[#F5EDE5] flex flex-col md:flex-row">
      {/* A. LEFT SIDEBAR (Navigation Rail) */}
      <aside
        className={`${
          activeConv ? 'hidden md:flex' : 'hidden md:flex'
        } w-64 shrink-0 bg-[#651F35] text-[#F5EDE5] flex-col justify-between border-r border-[#C58C91]/20`}
      >
        <div className="p-5 space-y-6">
          {/* Logo & Brand */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrandLogo size={36} variant="light" />
              <span className="font-display text-lg font-bold tracking-tight whitespace-nowrap">
                Connectly
              </span>
            </div>
            <button
              type="button"
              onClick={onToggleDarkMode}
              title={darkMode ? 'Light mode' : 'Dark mode'}
              className="p-2 rounded-xl bg-[#F5EDE5]/10 hover:bg-[#F5EDE5]/20 transition-colors"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          {/* Current User Profile & Connection Status */}
          <div className="flex items-center gap-3 p-3 rounded-2xl bg-[#53172A] border border-[#C58C91]/25">
            <Avatar
              name={currentUser.full_name}
              src={currentUser.avatar_url}
              size="md"
              isOnline={wsStatus === 'connected'}
              showPresence
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{currentUser.full_name}</p>
              <p className="text-xs text-[#C58C91] truncate">
                @{currentUser.username} ·{' '}
                {wsStatus === 'connected'
                  ? 'Online'
                  : wsStatus === 'connecting'
                  ? 'Connecting'
                  : 'Offline'}
              </p>
            </div>
          </div>

          {/* Quick Search Trigger */}
          <button
            type="button"
            onClick={() => {
              setSection('contacts');
              setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-[#F5EDE5]/10 hover:bg-[#F5EDE5]/15 text-xs text-[#F5EDE5]/85 transition-colors"
          >
            <Search className="h-3.5 w-3.5 text-[#C58C91]" />
            <span>Find users or chats...</span>
          </button>

          {/* Navigation Items */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#F5EDE5] text-[#651F35] font-semibold'
                      : 'text-[#F5EDE5]/85 hover:bg-[#F5EDE5]/10'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-mono tabular-nums font-semibold ${
                        active
                          ? 'bg-[#651F35] text-[#F5EDE5]'
                          : 'bg-[#C58C91] text-[#2A1219]'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Actions */}
        <div className="p-4 border-t border-[#C58C91]/20 space-y-1">
          <button
            type="button"
            onClick={() => setShowNetworkModal(true)}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-[#F5EDE5]/85 hover:bg-[#F5EDE5]/10 transition-colors whitespace-nowrap"
          >
            <Network className="h-4 w-4 text-[#C58C91]" />
            <span>TCP Socket Inspector</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-[#F5EDE5]/85 hover:bg-[#F5EDE5]/10 transition-colors whitespace-nowrap"
          >
            <Settings className="h-4 w-4 text-[#C58C91]" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-[#F5EDE5]/85 hover:bg-red-500/20 transition-colors whitespace-nowrap"
          >
            <LogOut className="h-4 w-4 text-[#C58C91]" />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* B. MIDDLE CONVERSATION PANEL */}
      <section
        className={`${
          activeConv ? 'hidden md:flex' : 'flex'
        } w-full md:w-80 lg:w-96 shrink-0 flex-col bg-[#FAF7F4] dark:bg-[#241218] border-r border-[#C58C91]/30 dark:border-[#C58C91]/15 h-full`}
      >
        {/* Mobile Top Bar */}
        <div className="md:hidden flex items-center justify-between px-4 py-3 bg-[#651F35] text-[#F5EDE5]">
          <div className="flex items-center gap-2.5">
            <BrandLogo size={30} variant="light" />
            <span className="font-display font-bold text-base">Connectly</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowNetworkModal(true)}
              aria-label="TCP Socket Inspector"
              className="p-2 rounded-lg hover:bg-[#F5EDE5]/15"
            >
              <Network className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              className="p-2 rounded-lg hover:bg-[#F5EDE5]/15"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onLogout}
              aria-label="Logout"
              className="p-2 rounded-lg hover:bg-[#F5EDE5]/15"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Middle Panel Header */}
        <div className="p-4 border-b border-[#C58C91]/25 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-[#651F35] dark:text-[#F5EDE5]">
              {section === 'contacts'
                ? 'Contacts'
                : section === 'groups'
                ? 'Groups'
                : section === 'unread'
                ? 'Unread'
                : 'Messages'}
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSection('contacts')}
                className="px-3 py-1.5 rounded-xl border border-[#C58C91]/50 text-xs font-semibold text-[#651F35] dark:text-[#F5EDE5] hover:bg-[#C58C91]/15 whitespace-nowrap"
              >
                New Chat
              </button>
              <button
                type="button"
                onClick={() => setShowNewGroup(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] text-xs font-semibold whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                Group
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="h-4 w-4 text-[#651F35]/60 dark:text-[#C58C91] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                section === 'contacts'
                  ? 'Search registered users...'
                  : 'Search conversations or users...'
              }
              className="w-full rounded-xl border border-[#C58C91]/40 bg-[#FFFFFF] dark:bg-[#190D11] pl-10 pr-4 py-2 text-sm outline-none focus:border-[#651F35]"
            />
          </div>

          {/* Mobile/Compact Filter Tabs */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-[#F5EDE5] dark:bg-[#190D11] border border-[#C58C91]/20">
            {(['all', 'unread', 'groups', 'contacts'] as SidebarSection[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setSection(tab)}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold capitalize transition-colors whitespace-nowrap ${
                  section === tab
                    ? 'bg-[#651F35] text-[#F5EDE5]'
                    : 'text-[#651F35]/80 dark:text-[#C58C91] hover:bg-[#C58C91]/15'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* List Content */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#C58C91]/15">
          {section === 'contacts' ? (
            contactsLoading ? (
              <div className="p-6 text-center text-sm text-[#651F35]/70 dark:text-[#C58C91]">
                Loading registered users...
              </div>
            ) : contacts.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm font-medium text-[#651F35] dark:text-[#F5EDE5]">
                  No other users found
                </p>
                <p className="text-xs text-[#651F35]/70 dark:text-[#C58C91]">
                  Open another browser window or incognito tab to register a second account and
                  test live messaging.
                </p>
              </div>
            ) : (
              contacts.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => handleStartDirectChat(user.username)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[#C58C91]/15 transition-colors"
                >
                  <Avatar
                    name={user.full_name}
                    src={user.avatar_url}
                    size="md"
                    isOnline={user.is_online}
                    showPresence
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold truncate">{user.full_name}</p>
                      <span className="text-xs text-[#651F35]/70 dark:text-[#C58C91]">
                        {user.is_online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <p className="text-xs text-[#651F35]/75 dark:text-[#C58C91] truncate">
                      @{user.username} · {user.status_text || 'Available on Connectly'}
                    </p>
                  </div>
                </button>
              ))
            )
          ) : (
            <>
              {filteredConversations.length === 0 && !searchQuery.trim() && (
                <div className="p-8 text-center space-y-3">
                  <p className="text-sm font-semibold text-[#651F35] dark:text-[#F5EDE5]">
                    {section === 'unread'
                      ? 'All caught up'
                      : section === 'groups'
                      ? 'No groups yet'
                      : 'No conversations yet'}
                  </p>
                  <p className="text-xs text-[#651F35]/75 dark:text-[#C58C91]">
                    {section === 'groups'
                      ? 'Create a group to chat with multiple team members over TCP.'
                      : 'Select Contacts to start a 1-to-1 conversation with a registered user.'}
                  </p>
                  {section !== 'unread' && (
                    <button
                      type="button"
                      onClick={() =>
                        section === 'groups' ? setShowNewGroup(true) : setSection('contacts')
                      }
                      className="px-4 py-2 rounded-xl bg-[#651F35] text-[#F5EDE5] text-xs font-semibold"
                    >
                      {section === 'groups' ? 'Create Group' : 'Browse Contacts'}
                    </button>
                  )}
                </div>
              )}

              {filteredConversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const title =
                  conv.type === 'group'
                    ? conv.group?.name || 'Group'
                    : conv.peer?.full_name || 'Unknown User';
                const avatar =
                  conv.type === 'group' ? conv.group?.avatar_url : conv.peer?.avatar_url;
                const isOnline = conv.type === 'direct' ? Boolean(conv.peer?.is_online) : false;

                const last = conv.last_message;
                const previewText = last
                  ? last.message_type === 'attachment' && !last.content
                    ? `Attachment: ${last.attachment_name}`
                    : conv.type === 'group' && last.message_type !== 'system'
                    ? `${last.sender_name.split(' ')[0]}: ${last.content}`
                    : last.sender_username === currentUser.username && last.message_type !== 'system'
                    ? `You: ${last.content}`
                    : last.content
                  : 'No messages yet';

                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => onSelectConversation(conv.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                      isActive
                        ? 'bg-[#651F35] text-[#F5EDE5]'
                        : 'hover:bg-[#C58C91]/15'
                    }`}
                  >
                    <Avatar
                      name={title}
                      src={avatar}
                      size="md"
                      isGroup={conv.type === 'group'}
                      isOnline={isOnline}
                      showPresence={conv.type === 'direct'}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold truncate">{title}</p>
                        <span
                          className={`text-xs font-mono tabular-nums shrink-0 ${
                            isActive
                              ? 'text-[#F5EDE5]/80'
                              : 'text-[#651F35]/65 dark:text-[#C58C91]'
                          }`}
                        >
                          {formatListTime(last?.created_at || conv.updated_at)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p
                          className={`text-xs truncate ${
                            isActive
                              ? 'text-[#F5EDE5]/85'
                              : 'text-[#651F35]/75 dark:text-[#C58C91]'
                          }`}
                        >
                          {previewText}
                        </p>
                        {conv.unread_count > 0 && !isActive && (
                          <span className="px-2 py-0.5 rounded-full bg-[#651F35] text-[#F5EDE5] text-[11px] font-mono tabular-nums font-semibold shrink-0">
                            {conv.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* If searching and there are matching registered users, show them below */}
              {searchQuery.trim() && contacts.length > 0 && (
                <div className="pt-2">
                  <p className="px-4 py-2 text-xs font-semibold text-[#651F35]/75 dark:text-[#C58C91]">
                    People on Connectly
                  </p>
                  {contacts.map((user) => (
                    <button
                      key={`search-${user.id}`}
                      type="button"
                      onClick={() => handleStartDirectChat(user.username)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#C58C91]/15 transition-colors"
                    >
                      <Avatar
                        name={user.full_name}
                        src={user.avatar_url}
                        size="sm"
                        isOnline={user.is_online}
                        showPresence
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{user.full_name}</p>
                        <p className="text-xs text-[#651F35]/70 dark:text-[#C58C91]">
                          @{user.username}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* C. RIGHT CONVERSATION PANEL */}
      <main
        className={`${
          activeConv ? 'flex' : 'hidden md:flex'
        } flex-1 flex-col h-full min-w-0 bg-[#F5EDE5] dark:bg-[#190D11]`}
      >
        {/* Reconnection Alert Banner (only shown when disconnected/reconnecting) */}
        {wsStatus !== 'connected' && (
          <div className="flex items-center justify-center gap-2 bg-[#651F35] text-[#F5EDE5] px-4 py-2 text-xs font-medium">
            <WifiOff className="h-3.5 w-3.5 text-[#C58C91]" />
            <span>
              {wsStatus === 'connecting'
                ? 'Reconnecting WebSocket gateway to TCP server...'
                : 'Connection lost. Waiting to reconnect to TCP server...'}
            </span>
          </div>
        )}

        {!activeConv ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="max-w-md space-y-4">
              <div className="mx-auto w-16 h-16 rounded-2xl bg-[#651F35] flex items-center justify-center shadow-sm">
                <BrandLogo size={42} variant="light" />
              </div>
              <h2 className="font-display text-2xl font-bold text-[#651F35] dark:text-[#F5EDE5]">
                Select a conversation
              </h2>
              <p className="text-sm text-[#651F35]/80 dark:text-[#C58C91] leading-relaxed">
                Choose an existing chat from the middle panel, open Contacts to message a
                registered user, or create a multi-user group. All messages route over dedicated TCP
                connections.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSection('contacts')}
                  className="px-4 py-2.5 rounded-xl bg-[#651F35] hover:bg-[#53172A] text-[#F5EDE5] text-sm font-semibold"
                >
                  Start Direct Chat
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewGroup(true)}
                  className="px-4 py-2.5 rounded-xl border border-[#C58C91]/60 text-sm font-semibold text-[#651F35] dark:text-[#F5EDE5] hover:bg-[#C58C91]/15"
                >
                  Create Group
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Active Conversation Header */}
            <header className="flex items-center justify-between gap-4 px-5 py-3.5 bg-[#FAF7F4] dark:bg-[#241218] border-b border-[#C58C91]/30 dark:border-[#C58C91]/15 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => onSelectConversation(null)}
                  aria-label="Back to conversations"
                  className="md:hidden p-2 -ml-2 rounded-xl hover:bg-[#C58C91]/20"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <Avatar
                  name={
                    activeConv.type === 'group'
                      ? activeConv.group?.name || 'Group'
                      : activeConv.peer?.full_name || 'User'
                  }
                  src={
                    activeConv.type === 'group'
                      ? activeConv.group?.avatar_url
                      : activeConv.peer?.avatar_url
                  }
                  size="md"
                  isGroup={activeConv.type === 'group'}
                  isOnline={activeConv.type === 'direct' ? Boolean(activeConv.peer?.is_online) : false}
                  showPresence={activeConv.type === 'direct'}
                />
                <div className="min-w-0">
                  <h3 className="font-display text-base font-bold truncate text-[#651F35] dark:text-[#F5EDE5]">
                    {activeConv.type === 'group'
                      ? activeConv.group?.name
                      : activeConv.peer?.full_name}
                  </h3>
                  <p className="text-xs text-[#651F35]/75 dark:text-[#C58C91] truncate">
                    {typingUsers.length > 0 ? (
                      <span className="font-medium text-[#651F35] dark:text-[#F5EDE5]">
                        {typingUsers.join(', ')} typing...
                      </span>
                    ) : activeConv.type === 'group' ? (
                      `${activeConv.group?.member_count || 0} members`
                    ) : activeConv.peer?.is_online ? (
                      `@${activeConv.peer.username} · Online`
                    ) : (
                      `@${activeConv.peer?.username || ''} · Last seen ${formatListTime(
                        activeConv.peer?.last_seen_at || ''
                      )}`
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {activeConv.type === 'group' && activeConv.group && (
                  <button
                    type="button"
                    onClick={() => setShowGroupManage(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#C58C91]/50 text-xs font-semibold text-[#651F35] dark:text-[#F5EDE5] hover:bg-[#C58C91]/15 whitespace-nowrap"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Group Info
                  </button>
                )}
              </div>
            </header>

            {/* Message History */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3">
              {activeMessages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-center">
                  <p className="text-sm text-[#651F35]/70 dark:text-[#C58C91]">
                    No messages yet. Say hello to start this TCP conversation.
                  </p>
                </div>
              ) : (
                activeMessages.map((msg, idx) => {
                  const prev = idx > 0 ? activeMessages[idx - 1] : null;
                  const showDateDivider =
                    !prev ||
                    new Date(prev.created_at).toDateString() !==
                      new Date(msg.created_at).toDateString();

                  const isMine = msg.sender.toLowerCase() === currentUser.username.toLowerCase();

                  if (msg.message_type === 'system') {
                    return (
                      <React.Fragment key={`${msg.id}-${msg.client_msg_id || idx}`}>
                        {showDateDivider && (
                          <div className="flex justify-center py-2">
                            <span className="text-xs font-medium text-[#651F35]/70 dark:text-[#C58C91]">
                              {formatDateHeading(msg.created_at)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-center py-1">
                          <span className="text-xs text-[#651F35]/75 dark:text-[#C58C91]">
                            {msg.message}
                          </span>
                        </div>
                      </React.Fragment>
                    );
                  }

                  const isImageAttachment =
                    msg.attachment && msg.attachment.mime.startsWith('image/');

                  return (
                    <React.Fragment key={`${msg.id}-${msg.client_msg_id || idx}`}>
                      {showDateDivider && (
                        <div className="flex justify-center py-2">
                          <span className="text-xs font-medium text-[#651F35]/70 dark:text-[#C58C91]">
                            {formatDateHeading(msg.created_at)}
                          </span>
                        </div>
                      )}

                      <div className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[78%] sm:max-w-[65%] rounded-2xl px-4 py-2.5 shadow-xs ${
                            isMine
                              ? 'bg-[#651F35] text-[#F5EDE5] rounded-br-md'
                              : 'bg-[#FFFFFF] dark:bg-[#2A151C] text-[#2A1219] dark:text-[#F5EDE5] border border-[#C58C91]/30 rounded-bl-md'
                          }`}
                        >
                          {!isMine && activeConv.type === 'group' && (
                            <p className="text-xs font-semibold text-[#651F35] dark:text-[#C58C91] mb-1">
                              {msg.sender_name}
                            </p>
                          )}

                          {msg.attachment && (
                            <div className="mb-2">
                              {isImageAttachment ? (
                                <a
                                  href={msg.attachment.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block overflow-hidden rounded-xl border border-[#C58C91]/30"
                                >
                                  <img
                                    src={msg.attachment.url}
                                    alt={msg.attachment.name}
                                    referrerPolicy="no-referrer"
                                    className="max-h-60 w-auto object-cover"
                                  />
                                </a>
                              ) : (
                                <a
                                  href={msg.attachment.url}
                                  download={msg.attachment.name}
                                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 border text-xs ${
                                    isMine
                                      ? 'border-[#F5EDE5]/25 bg-[#53172A] text-[#F5EDE5]'
                                      : 'border-[#C58C91]/35 bg-[#F5EDE5] dark:bg-[#190D11]'
                                  }`}
                                >
                                  <FileText className="h-4 w-4 shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate">{msg.attachment.name}</p>
                                    <p className="opacity-75 font-mono tabular-nums">
                                      {formatBytes(msg.attachment.size)}
                                    </p>
                                  </div>
                                  <Download className="h-4 w-4 shrink-0" />
                                </a>
                              )}
                            </div>
                          )}

                          {msg.message && (
                            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                              {msg.message}
                            </p>
                          )}

                          <div
                            className={`flex items-center justify-end gap-1.5 mt-1 text-[11px] font-mono tabular-nums ${
                              isMine
                                ? 'text-[#F5EDE5]/75'
                                : 'text-[#651F35]/65 dark:text-[#C58C91]'
                            }`}
                          >
                            <span>{formatTime(msg.created_at)}</span>
                            {isMine && (
                              <span
                                title={
                                  msg.pending
                                    ? 'Sending...'
                                    : msg.delivery_status === 'read'
                                    ? 'Read'
                                    : msg.delivery_status === 'delivered'
                                    ? 'Delivered'
                                    : 'Sent'
                                }
                              >
                                {msg.delivery_status === 'sent' || msg.pending ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <CheckCheck
                                    className={`h-3.5 w-3.5 ${
                                      msg.delivery_status === 'read'
                                        ? 'text-[#C58C91]'
                                        : 'text-[#F5EDE5]/80'
                                    }`}
                                  />
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}

              {typingUsers.length > 0 && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md bg-[#FFFFFF] dark:bg-[#2A151C] border border-[#C58C91]/30 px-4 py-2.5 text-xs text-[#651F35] dark:text-[#C58C91]">
                    {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer Area */}
            <footer className="px-4 sm:px-6 py-3.5 bg-[#FAF7F4] dark:bg-[#241218] border-t border-[#C58C91]/30 dark:border-[#C58C91]/15 shrink-0 relative">
              {uploadError && (
                <p className="mb-2 text-xs text-red-700 dark:text-red-300">{uploadError}</p>
              )}

              {pendingAttachment && (
                <div className="mb-2.5 inline-flex items-center gap-2.5 rounded-xl border border-[#C58C91]/50 bg-[#F5EDE5] dark:bg-[#190D11] px-3 py-1.5 text-xs">
                  <FileText className="h-4 w-4 text-[#651F35] dark:text-[#C58C91]" />
                  <span className="font-medium max-w-xs truncate">{pendingAttachment.name}</span>
                  <button
                    type="button"
                    onClick={() => setPendingAttachment(null)}
                    aria-label="Remove attachment"
                    className="p-0.5 rounded hover:bg-[#C58C91]/20"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {showEmojiPicker && (
                <div className="absolute bottom-20 left-4 sm:left-6 z-20 rounded-2xl border border-[#C58C91]/40 bg-[#FAF7F4] dark:bg-[#241218] p-3 shadow-lg grid grid-cols-8 gap-1">
                  {EMOJI_PALETTE.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setDraft((d) => d + emoji)}
                      className="h-9 w-9 rounded-lg hover:bg-[#C58C91]/20 text-lg flex items-center justify-center"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}

              <form onSubmit={submitMessage} className="flex items-end gap-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFile}
                  title="Attach file"
                  aria-label="Attach file"
                  className="p-2.5 rounded-xl border border-[#C58C91]/40 text-[#651F35] dark:text-[#C58C91] hover:bg-[#C58C91]/15 transition-colors shrink-0"
                >
                  <Paperclip className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  title="Insert emoji"
                  aria-label="Insert emoji"
                  className="p-2.5 rounded-xl border border-[#C58C91]/40 text-[#651F35] dark:text-[#C58C91] hover:bg-[#C58C91]/15 transition-colors shrink-0"
                >
                  <Smile className="h-5 w-5" />
                </button>

                <textarea
                  rows={1}
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={uploadingFile ? 'Uploading attachment...' : 'Write a message...'}
                  className="flex-1 resize-none max-h-32 rounded-2xl border border-[#C58C91]/50 bg-[#FFFFFF] dark:bg-[#190D11] px-4 py-2.5 text-sm outline-none focus:border-[#651F35]"
                />

                <button
                  type="submit"
                  disabled={(!draft.trim() && !pendingAttachment) || uploadingFile}
                  aria-label="Send message"
                  className="p-2.5 px-4 rounded-xl bg-[#651F35] hover:bg-[#53172A] disabled:opacity-45 text-[#F5EDE5] transition-colors shrink-0 inline-flex items-center gap-2 text-sm font-semibold cursor-pointer"
                >
                  <Send className="h-4 w-4" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </form>
            </footer>
          </>
        )}
      </main>

      {/* Modals */}
      {showNewGroup && (
        <NewGroupModal
          token={token}
          onClose={() => setShowNewGroup(false)}
          onCreated={async (convId) => {
            setShowNewGroup(false);
            await onRefreshConversations();
            onSelectConversation(convId);
          }}
        />
      )}

      {showGroupManage && activeConv?.type === 'group' && activeConv.group && (
        <GroupManageModal
          token={token}
          currentUser={currentUser}
          group={activeConv.group}
          onClose={() => setShowGroupManage(false)}
          onUpdated={onRefreshConversations}
          onLeftGroup={async () => {
            setShowGroupManage(false);
            onSelectConversation(null);
            await onRefreshConversations();
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          token={token}
          user={currentUser}
          darkMode={darkMode}
          onToggleDarkMode={onToggleDarkMode}
          onUserUpdated={onUserUpdated}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showNetworkModal && (
        <NetworkInspectorModal
          token={token}
          myConnection={myTcpConnection}
          onClose={() => setShowNetworkModal(false)}
        />
      )}
    </div>
  );
};
