export interface User {
  id: number;
  full_name: string;
  username: string;
  email?: string;
  avatar_url: string;
  status_text: string;
  is_online: boolean;
  last_seen_at: string;
  created_at?: string;
}

export interface Attachment {
  name: string;
  url: string;
  mime: string;
  size: number;
}

export interface GroupMember {
  id: number;
  full_name: string;
  username: string;
  avatar_url: string;
  is_online: boolean;
  role: 'admin' | 'member';
}

export interface GroupInfo {
  id: number;
  name: string;
  description: string;
  avatar_url: string;
  created_by: number;
  my_role: 'admin' | 'member';
  member_count: number;
  members: GroupMember[];
}

export interface LastMessageSummary {
  id: number;
  content: string;
  message_type: 'text' | 'attachment' | 'system';
  attachment_name: string;
  delivery_status: 'sent' | 'delivered' | 'read';
  created_at: string;
  sender_username: string;
  sender_name: string;
}

export interface Conversation {
  id: number;
  type: 'direct' | 'group';
  unread_count: number;
  updated_at: string;
  peer: User | null;
  group: GroupInfo | null;
  last_message: LastMessageSummary | null;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender: string;
  sender_name: string;
  sender_avatar: string;
  client_msg_id?: string;
  message: string;
  message_type: 'text' | 'attachment' | 'system';
  attachment: Attachment | null;
  delivery_status: 'sent' | 'delivered' | 'read';
  created_at: string;
  pending?: boolean;
}

export interface TcpConnectionMetadata {
  session_id: string;
  username: string | null;
  client_label: string;
  client_ip: string;
  source_port: number;
  server_ip: string;
  destination_port: number;
  connected_at: string;
  bytes_received: number;
  bytes_sent: number;
  messages_received: number;
  messages_sent: number;
}

export interface NetworkDiagnostics {
  gateway: {
    protocol: string;
    httpPort: number;
    tcpTargetHost: string;
    tcpTargetPort: number;
    framing: string;
  };
  tcpServer: {
    server: {
      host: string;
      port: number;
      started_at: string;
      online_users: string[];
    };
    current_connection: TcpConnectionMetadata;
    active_connections: TcpConnectionMetadata[];
  };
}
