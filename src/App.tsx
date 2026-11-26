/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './services/api';
import type {
  Attachment,
  ChatMessage,
  Conversation,
  TcpConnectionMetadata,
  User,
} from './types/chat';
import { AuthScreen } from './components/AuthScreen';
import { ChatDashboard } from './components/ChatDashboard';

export default function App() {
  const [darkMode, setDarkMode] = useState(false);
  // Session token kept strictly in React memory per security guidelines
  const [token, setToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [messagesByConv, setMessagesByConv] = useState<Record<number, ChatMessage[]>>({});
  const [typingByConv, setTypingByConv] = useState<Record<number, string[]>>({});
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [myTcpConnection, setMyTcpConnection] = useState<TcpConnectionMetadata | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeConvRef = useRef<number | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const pendingQueueRef = useRef<Array<Record<string, unknown>>>([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    activeConvRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.getConversations(token);
      setConversations(res.conversations);
    } catch {
      // Ignore transient errors
    }
  }, [token]);

  const loadMessages = useCallback(
    async (convId: number) => {
      if (!token) return;
      try {
        const res = await api.getMessages(token, convId);
        setMessagesByConv((prev) => ({
          ...prev,
          [convId]: res.messages,
        }));
      } catch {
        // Ignore transient errors
      }
    },
    [token]
  );

  const sendWsFrame = useCallback((frame: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    if (frame.type === 'chat_message' || frame.type === 'group_message') {
      pendingQueueRef.current.push(frame);
    }
    return false;
  }, []);

  const handleSelectConversation = useCallback(
    (convId: number | null) => {
      setActiveConversationId(convId);
      if (convId !== null) {
        loadMessages(convId);
        sendWsFrame({ type: 'read_receipt', conversation_id: convId });
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        );
      }
    },
    [loadMessages, sendWsFrame]
  );

  // Establish WebSocket connection -> Gateway -> Python TCP Server
  useEffect(() => {
    if (!token || !currentUser) {
      setWsStatus('disconnected');
      return;
    }

    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (evt) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(evt.data));
        } catch {
          return;
        }

        const msgType = data.type;

        if (msgType === 'session_registered') {
          setWsStatus('connected');
          reconnectAttemptRef.current = 0;
          if (data.connection) {
            setMyTcpConnection(data.connection as TcpConnectionMetadata);
          }
          refreshConversations();
          if (activeConvRef.current !== null) {
            loadMessages(activeConvRef.current);
          }
          // Flush any messages queued while offline
          while (pendingQueueRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
            const queued = pendingQueueRef.current.shift()!;
            ws.send(JSON.stringify(queued));
          }
          return;
        }

        if (msgType === 'conversations_sync') {
          refreshConversations();
          if (
            typeof data.conversation_id === 'number' &&
            data.conversation_id === activeConvRef.current
          ) {
            loadMessages(data.conversation_id);
          }
          return;
        }

        if (msgType === 'presence') {
          const uname = String(data.username || '').toLowerCase();
          const isOnline = Boolean(data.is_online);
          const lastSeen = String(data.last_seen_at || '');
          setConversations((prev) =>
            prev.map((c) => {
              if (c.type === 'direct' && c.peer?.username.toLowerCase() === uname) {
                return {
                  ...c,
                  peer: { ...c.peer, is_online: isOnline, last_seen_at: lastSeen },
                };
              }
              if (c.type === 'group' && c.group) {
                return {
                  ...c,
                  group: {
                    ...c.group,
                    members: c.group.members.map((m) =>
                      m.username.toLowerCase() === uname ? { ...m, is_online: isOnline } : m
                    ),
                  },
                };
              }
              return c;
            })
          );
          return;
        }

        if (msgType === 'typing') {
          const convId = Number(data.conversation_id);
          const senderName = String(data.sender_name || data.sender || '');
          const isTyping = Boolean(data.is_typing);
          if (!convId || !senderName) return;
          setTypingByConv((prev) => {
            const current = prev[convId] || [];
            const next = isTyping
              ? current.includes(senderName)
                ? current
                : [...current, senderName]
              : current.filter((n) => n !== senderName);
            return { ...prev, [convId]: next };
          });
          return;
        }

        if (msgType === 'status_update') {
          const ids = new Set((data.message_ids as number[]) || []);
          const newStatus = String(data.delivery_status || 'delivered') as
            | 'sent'
            | 'delivered'
            | 'read';
          setMessagesByConv((prev) => {
            const updated: Record<number, ChatMessage[]> = {};
            for (const [cid, list] of Object.entries(prev)) {
              updated[Number(cid)] = list.map((m) =>
                ids.has(m.id) ? { ...m, delivery_status: newStatus } : m
              );
            }
            return updated;
          });
          return;
        }

        if (msgType === 'delivery_ack') {
          const convId = Number(data.conversation_id);
          const msgId = Number(data.message_id);
          const clientMsgId = String(data.client_msg_id || '');
          const deliveryStatus = String(data.delivery_status || 'sent') as
            | 'sent'
            | 'delivered'
            | 'read';

          setMessagesByConv((prev) => {
            const list = prev[convId] || [];
            const existsById = list.some((m) => m.id === msgId);
            if (existsById) {
              return {
                ...prev,
                [convId]: list.map((m) =>
                  m.id === msgId ? { ...m, delivery_status: deliveryStatus, pending: false } : m
                ),
              };
            }
            const existsByClient = clientMsgId && list.some((m) => m.client_msg_id === clientMsgId);
            if (existsByClient) {
              return {
                ...prev,
                [convId]: list.map((m) =>
                  m.client_msg_id === clientMsgId
                    ? {
                        ...m,
                        id: msgId,
                        delivery_status: deliveryStatus,
                        created_at: String(data.created_at || m.created_at),
                        pending: false,
                      }
                    : m
                ),
              };
            }
            // Message sent from another tab of the same user
            return {
              ...prev,
              [convId]: [
                ...list,
                {
                  id: msgId,
                  conversation_id: convId,
                  sender_id: currentUser.id,
                  sender: currentUser.username,
                  sender_name: currentUser.full_name,
                  sender_avatar: currentUser.avatar_url,
                  client_msg_id: clientMsgId,
                  message: String(data.message || ''),
                  message_type: (data.message_type as ChatMessage['message_type']) || 'text',
                  attachment: (data.attachment as Attachment | null) || null,
                  delivery_status: deliveryStatus,
                  created_at: String(data.created_at || new Date().toISOString()),
                },
              ],
            };
          });

          refreshConversations();
          return;
        }

        if (msgType === 'chat_message' || msgType === 'group_message') {
          const convId = Number(data.conversation_id);
          const msgId = Number(data.message_id);
          const incomingMsg: ChatMessage = {
            id: msgId,
            conversation_id: convId,
            sender_id: Number(data.sender_id || 0),
            sender: String(data.sender || ''),
            sender_name: String(data.sender_name || data.sender || ''),
            sender_avatar: String(data.sender_avatar || ''),
            client_msg_id: String(data.client_msg_id || ''),
            message: String(data.message || ''),
            message_type: (data.message_type as ChatMessage['message_type']) || 'text',
            attachment: (data.attachment as Attachment | null) || null,
            delivery_status: (data.delivery_status as ChatMessage['delivery_status']) || 'delivered',
            created_at: String(data.created_at || new Date().toISOString()),
          };

          // Clear sender's typing indicator when their message arrives
          setTypingByConv((prev) => {
            const list = prev[convId];
            if (!list || list.length === 0) return prev;
            return {
              ...prev,
              [convId]: list.filter((n) => n !== incomingMsg.sender_name && n !== incomingMsg.sender),
            };
          });

          setMessagesByConv((prev) => {
            const existing = prev[convId] || [];
            if (existing.some((m) => m.id === msgId)) return prev;
            return { ...prev, [convId]: [...existing, incomingMsg] };
          });

          if (activeConvRef.current === convId) {
            sendWsFrame({ type: 'read_receipt', conversation_id: convId });
          }

          refreshConversations();
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        setWsStatus('disconnected');
        const delay = Math.min(8000, 1000 * Math.pow(1.5, reconnectAttemptRef.current));
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token, currentUser, refreshConversations, loadMessages, sendWsFrame]);

  const handleSendMessage = useCallback(
    ({
      conversationId,
      text,
      attachment,
    }: {
      conversationId: number;
      text: string;
      attachment?: Attachment | null;
    }) => {
      if (!currentUser) return;
      const conv = conversationsRef.current.find((c) => c.id === conversationId);
      if (!conv) return;

      const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: ChatMessage = {
        id: -Date.now(),
        conversation_id: conversationId,
        sender_id: currentUser.id,
        sender: currentUser.username,
        sender_name: currentUser.full_name,
        sender_avatar: currentUser.avatar_url,
        client_msg_id: clientMsgId,
        message: text,
        message_type: attachment ? 'attachment' : 'text',
        attachment: attachment || null,
        delivery_status: 'sent',
        created_at: new Date().toISOString(),
        pending: true,
      };

      setMessagesByConv((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] || []), optimistic],
      }));

      if (conv.type === 'group' && conv.group) {
        sendWsFrame({
          type: 'group_message',
          sender: currentUser.username,
          group_id: conv.group.id,
          conversation_id: conversationId,
          message: text,
          attachment: attachment || undefined,
          client_msg_id: clientMsgId,
        });
      } else if (conv.peer) {
        sendWsFrame({
          type: 'chat_message',
          sender: currentUser.username,
          recipient: conv.peer.username,
          conversation_id: conversationId,
          message: text,
          attachment: attachment || undefined,
          client_msg_id: clientMsgId,
        });
      }
    },
    [currentUser, sendWsFrame]
  );

  const handleSendTyping = useCallback(
    (conversationId: number, isTyping: boolean) => {
      if (!currentUser) return;
      sendWsFrame({
        type: 'typing',
        sender: currentUser.username,
        conversation_id: conversationId,
        is_typing: isTyping,
      });
    },
    [currentUser, sendWsFrame]
  );

  const handleLogout = useCallback(async () => {
    if (token) {
      await api.logout(token).catch(() => {});
    }
    wsRef.current?.close();
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessagesByConv({});
    setTypingByConv({});
    setMyTcpConnection(null);
  }, [token]);

  if (!token || !currentUser) {
    return (
      <AuthScreen
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        onAuthenticated={(newToken, user) => {
          setToken(newToken);
          setCurrentUser(user);
        }}
      />
    );
  }

  return (
    <ChatDashboard
      token={token}
      currentUser={currentUser}
      conversations={conversations}
      activeConversationId={activeConversationId}
      messagesByConv={messagesByConv}
      typingByConv={typingByConv}
      wsStatus={wsStatus}
      myTcpConnection={myTcpConnection}
      darkMode={darkMode}
      onToggleDarkMode={() => setDarkMode((d) => !d)}
      onSelectConversation={handleSelectConversation}
      onSendMessage={handleSendMessage}
      onSendTyping={handleSendTyping}
      onRefreshConversations={refreshConversations}
      onUserUpdated={setCurrentUser}
      onLogout={handleLogout}
    />
  );
}
