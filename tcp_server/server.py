#!/usr/bin/env python3
"""
Connectly Dedicated Python TCP Messaging Server.

Implements multi-client asynchronous TCP socket communication using
newline-delimited JSON (NDJSON) framing over TCP streams.
Designed for real-time message routing, offline persistence via SQLite,
and clean Wireshark packet inspection.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import signal
import socket
import sqlite3
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_LINE_BYTES = 1_048_576  # 1 MiB guard against unbounded frame buffers

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [TCP-SERVER] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("connectly.tcp")


def utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def init_database(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA foreign_keys = ON;")

    schema_file = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
    if schema_file.exists():
        conn.executescript(schema_file.read_text(encoding="utf-8"))
        conn.commit()
    return conn


@dataclass
class ClientSession:
    session_id: str
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    client_ip: str
    source_port: int
    server_ip: str
    destination_port: int
    username: str | None = None
    user_id: int | None = None
    full_name: str | None = None
    client_label: str = "tcp-client"
    connected_at: str = field(default_factory=utc_now_iso)
    bytes_received: int = 0
    bytes_sent: int = 0
    messages_received: int = 0
    messages_sent: int = 0
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def to_metadata(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "username": self.username,
            "client_label": self.client_label,
            "client_ip": self.client_ip,
            "source_port": self.source_port,
            "server_ip": self.server_ip,
            "destination_port": self.destination_port,
            "connected_at": self.connected_at,
            "bytes_received": self.bytes_received,
            "bytes_sent": self.bytes_sent,
            "messages_received": self.messages_received,
            "messages_sent": self.messages_sent,
        }


class ConnectlyTCPServer:
    def __init__(self, host: str, port: int, db_path: str) -> None:
        self.host = host
        self.port = port
        self.db_path = db_path
        self.db = init_database(db_path)
        self.sessions_by_id: dict[str, ClientSession] = {}
        self.sessions_by_username: dict[str, set[str]] = {}
        self.server: asyncio.AbstractServer | None = None
        self.started_at = utc_now_iso()

    async def start(self) -> None:
        # Reset stale online flags on clean server boot
        self.db.execute("UPDATE users SET is_online = 0;")
        self.db.commit()

        self.server = await asyncio.start_server(
            self.handle_client,
            host=self.host,
            port=self.port,
            reuse_address=True,
        )
        sockets = self.server.sockets or []
        bound = [sock.getsockname() for sock in sockets]
        if bound:
            self.port = int(bound[0][1])
        logger.info(
            "TCP server listening on %s:%s (sockets=%s, db=%s)",
            self.host,
            self.port,
            bound,
            self.db_path,
        )

    async def stop(self) -> None:
        logger.info("Shutting down TCP server...")
        for session in list(self.sessions_by_id.values()):
            try:
                session.writer.close()
            except Exception:
                pass
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        self.db.execute("UPDATE users SET is_online = 0;")
        self.db.commit()
        self.db.close()
        logger.info("TCP server stopped cleanly.")

    async def send_frame(self, session: ClientSession, payload: dict[str, Any]) -> bool:
        data = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            async with session.write_lock:
                session.writer.write(data)
                await session.writer.drain()
                session.bytes_sent += len(data)
                session.messages_sent += 1
            return True
        except (ConnectionResetError, BrokenPipeError, OSError) as exc:
            logger.warning(
                "Send failed to %s (%s:%s -> %s:%s): %s",
                session.username or "unregistered",
                session.client_ip,
                session.source_port,
                session.server_ip,
                session.destination_port,
                exc,
            )
            return False

    async def send_error(
        self,
        session: ClientSession,
        code: str,
        message: str,
        client_msg_id: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "type": "error",
            "code": code,
            "message": message,
            "timestamp": utc_now_iso(),
        }
        if client_msg_id:
            payload["client_msg_id"] = client_msg_id
        await self.send_frame(session, payload)

    async def broadcast_to_user(self, username: str, payload: dict[str, Any]) -> int:
        key = username.lower()
        session_ids = list(self.sessions_by_username.get(key, set()))
        delivered_count = 0
        for sid in session_ids:
            sess = self.sessions_by_id.get(sid)
            if sess is not None:
                ok = await self.send_frame(sess, payload)
                if ok:
                    delivered_count += 1
        return delivered_count

    async def broadcast_presence(self, username: str, is_online: bool, last_seen_at: str) -> None:
        event = {
            "type": "presence",
            "username": username,
            "is_online": is_online,
            "last_seen_at": last_seen_at,
        }
        for sess in list(self.sessions_by_id.values()):
            if sess.username:
                await self.send_frame(sess, event)

    async def handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        sock = writer.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass

        peer = writer.get_extra_info("peername") or ("unknown", 0)
        sockname = writer.get_extra_info("sockname") or (self.host, self.port)

        session = ClientSession(
            session_id=str(uuid.uuid4())[:12],
            reader=reader,
            writer=writer,
            client_ip=str(peer[0]),
            source_port=int(peer[1]) if len(peer) > 1 else 0,
            server_ip=str(sockname[0]),
            destination_port=int(sockname[1]) if len(sockname) > 1 else self.port,
        )
        self.sessions_by_id[session.session_id] = session

        logger.info(
            "TCP CONNECT sid=%s client=%s:%s -> server=%s:%s",
            session.session_id,
            session.client_ip,
            session.source_port,
            session.server_ip,
            session.destination_port,
        )

        buffer = bytearray()
        disconnect_reason = "normal EOF"

        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    disconnect_reason = "normal EOF (FIN)"
                    break

                session.bytes_received += len(chunk)
                buffer.extend(chunk)

                if len(buffer) > MAX_LINE_BYTES and b"\n" not in buffer:
                    await self.send_error(
                        session,
                        "FRAME_TOO_LARGE",
                        f"Message exceeded {MAX_LINE_BYTES} bytes without newline delimiter",
                    )
                    buffer.clear()
                    continue

                while b"\n" in buffer:
                    nl_index = buffer.index(b"\n")
                    raw_line = bytes(buffer[:nl_index])
                    del buffer[: nl_index + 1]

                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue

                    session.messages_received += 1
                    await self.process_line(session, line)

            # Handle trailing data sent before clean EOF without trailing newline
            if buffer:
                trailing = bytes(buffer).decode("utf-8", errors="replace").strip()
                buffer.clear()
                if trailing:
                    session.messages_received += 1
                    await self.process_line(session, trailing)

        except ConnectionResetError as exc:
            disconnect_reason = f"abnormal reset (RST): {exc}"
        except BrokenPipeError as exc:
            disconnect_reason = f"broken pipe: {exc}"
        except asyncio.CancelledError:
            disconnect_reason = "server shutdown"
            raise
        except Exception as exc:
            disconnect_reason = f"unexpected socket error: {exc}"
            logger.exception("Error in client loop sid=%s", session.session_id)
        finally:
            await self.cleanup_session(session, disconnect_reason)

    async def cleanup_session(self, session: ClientSession, reason: str) -> None:
        self.sessions_by_id.pop(session.session_id, None)
        went_offline_username: str | None = None

        if session.username:
            key = session.username.lower()
            user_set = self.sessions_by_username.get(key)
            if user_set:
                user_set.discard(session.session_id)
                if not user_set:
                    self.sessions_by_username.pop(key, None)
                    went_offline_username = session.username

        try:
            session.writer.close()
            await asyncio.wait_for(session.writer.wait_closed(), timeout=1.0)
        except Exception:
            pass

        logger.info(
            "TCP DISCONNECT sid=%s user=%s client=%s:%s -> server=%s:%s reason=%s rx=%dB tx=%dB",
            session.session_id,
            session.username or "unregistered",
            session.client_ip,
            session.source_port,
            session.server_ip,
            session.destination_port,
            reason,
            session.bytes_received,
            session.bytes_sent,
        )

        if went_offline_username:
            now = utc_now_iso()
            self.db.execute(
                "UPDATE users SET is_online = 0, last_seen_at = ? WHERE LOWER(username) = LOWER(?)",
                (now, went_offline_username),
            )
            self.db.commit()
            await self.broadcast_presence(went_offline_username, False, now)

    async def process_line(self, session: ClientSession, line: str) -> None:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            logger.warning("Malformed JSON from sid=%s (%s): %s", session.session_id, session.client_ip, exc)
            await self.send_error(session, "MALFORMED_JSON", f"Malformed JSON payload: {exc.msg}")
            return

        if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
            await self.send_error(session, "INVALID_FRAME", "Frame must be a JSON object with string 'type'")
            return

        msg_type = msg["type"].strip()

        if msg_type == "ping":
            await self.send_frame(session, {"type": "pong", "timestamp": utc_now_iso()})
            return

        if msg_type == "get_stats":
            await self.send_frame(
                session,
                {
                    "type": "stats",
                    "server": {
                        "host": session.server_ip,
                        "port": self.port,
                        "started_at": self.started_at,
                        "online_users": sorted(
                            {
                                s.username
                                for s in self.sessions_by_id.values()
                                if s.username
                            }
                        ),
                    },
                    "current_connection": session.to_metadata(),
                    "active_connections": [
                        s.to_metadata() for s in self.sessions_by_id.values()
                    ],
                },
            )
            return

        if msg_type == "register_session":
            await self.handle_register_session(session, msg)
            return

        if msg_type == "chat_message":
            await self.handle_chat_message(session, msg)
            return

        if msg_type == "group_message":
            await self.handle_group_message(session, msg)
            return

        if msg_type == "typing":
            await self.handle_typing(session, msg)
            return

        if msg_type == "read_receipt":
            await self.handle_read_receipt(session, msg)
            return

        if msg_type == "disconnect":
            await self.send_frame(session, {"type": "bye", "timestamp": utc_now_iso()})
            session.writer.close()
            return

        await self.send_error(session, "UNKNOWN_TYPE", f"Unsupported message type '{msg_type}'")

    async def handle_register_session(self, session: ClientSession, msg: dict[str, Any]) -> None:
        raw_username = str(msg.get("username", "")).strip()
        client_label = str(msg.get("client_label", "tcp-client")).strip()[:40] or "tcp-client"

        if not raw_username:
            await self.send_error(session, "INVALID_USERNAME", "Username is required to register session")
            return

        row = self.db.execute(
            "SELECT id, username, full_name FROM users WHERE LOWER(username) = LOWER(?)",
            (raw_username,),
        ).fetchone()
        if row is None:
            await self.send_error(session, "INVALID_USERNAME", f"User '{raw_username}' is not registered")
            return

        # Remove prior username mapping if re-registering on same socket
        if session.username:
            old_key = session.username.lower()
            if old_key in self.sessions_by_username:
                self.sessions_by_username[old_key].discard(session.session_id)

        session.user_id = int(row["id"])
        session.username = str(row["username"])
        session.full_name = str(row["full_name"])
        session.client_label = client_label

        key = session.username.lower()
        was_offline = key not in self.sessions_by_username or len(self.sessions_by_username[key]) == 0
        self.sessions_by_username.setdefault(key, set()).add(session.session_id)

        now = utc_now_iso()
        self.db.execute(
            "UPDATE users SET is_online = 1, last_seen_at = ? WHERE id = ?",
            (now, session.user_id),
        )
        self.db.commit()

        logger.info(
            "SESSION REGISTERED sid=%s user=%s (%s:%s -> %s:%s)",
            session.session_id,
            session.username,
            session.client_ip,
            session.source_port,
            session.server_ip,
            session.destination_port,
        )

        online_users = sorted({s.username for s in self.sessions_by_id.values() if s.username})

        await self.send_frame(
            session,
            {
                "type": "session_registered",
                "username": session.username,
                "user_id": session.user_id,
                "online_users": online_users,
                "connection": session.to_metadata(),
                "timestamp": now,
            },
        )

        if was_offline:
            await self.broadcast_presence(session.username, True, now)

        # Deliver any pending offline messages (`delivery_status = 'sent'`) to this user
        await self.flush_pending_deliveries(session)

    async def flush_pending_deliveries(self, session: ClientSession) -> None:
        if session.user_id is None or session.username is None:
            return

        pending = self.db.execute(
            """
            SELECT m.id, m.conversation_id, m.sender_id, m.client_msg_id, m.content,
                   m.message_type, m.attachment_name, m.attachment_url, m.attachment_mime,
                   m.attachment_size, m.created_at,
                   u.username AS sender_username, u.full_name AS sender_full_name,
                   u.avatar_url AS sender_avatar_url, c.type AS conv_type
            FROM messages m
            JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
            JOIN conversations c ON c.id = m.conversation_id
            JOIN users u ON u.id = m.sender_id
            WHERE cp.user_id = ?
              AND m.sender_id != ?
              AND m.delivery_status = 'sent'
            ORDER BY m.id ASC
            """,
            (session.user_id, session.user_id),
        ).fetchall()

        if not pending:
            return

        msg_ids: list[int] = []
        sender_notifications: dict[str, list[int]] = {}

        for row in pending:
            msg_id = int(row["id"])
            msg_ids.append(msg_id)
            sender_uname = str(row["sender_username"])
            sender_notifications.setdefault(sender_uname, []).append(msg_id)

            outbound = {
                "type": "group_message" if row["conv_type"] == "group" else "chat_message",
                "message_id": msg_id,
                "conversation_id": int(row["conversation_id"]),
                "sender": sender_uname,
                "sender_id": int(row["sender_id"]),
                "sender_name": str(row["sender_full_name"]),
                "sender_avatar": str(row["sender_avatar_url"] or ""),
                "recipient": session.username if row["conv_type"] == "direct" else None,
                "message": str(row["content"]),
                "message_type": str(row["message_type"]),
                "attachment": {
                    "name": row["attachment_name"],
                    "url": row["attachment_url"],
                    "mime": row["attachment_mime"],
                    "size": row["attachment_size"],
                }
                if row["attachment_url"]
                else None,
                "delivery_status": "delivered",
                "client_msg_id": row["client_msg_id"] or "",
                "created_at": str(row["created_at"]),
                "replayed_offline": True,
            }
            await self.send_frame(session, outbound)

        placeholders = ",".join("?" for _ in msg_ids)
        self.db.execute(
            f"UPDATE messages SET delivery_status = 'delivered' WHERE id IN ({placeholders})",
            msg_ids,
        )
        self.db.commit()

        for sender_uname, ids in sender_notifications.items():
            await self.broadcast_to_user(
                sender_uname,
                {
                    "type": "status_update",
                    "message_ids": ids,
                    "delivery_status": "delivered",
                    "updated_by": session.username,
                    "timestamp": utc_now_iso(),
                },
            )

    async def handle_chat_message(self, session: ClientSession, msg: dict[str, Any]) -> None:
        client_msg_id = str(msg.get("client_msg_id") or "")
        sender_name = str(msg.get("sender") or session.username or "").strip()
        recipient_name = str(msg.get("recipient") or "").strip()
        content = str(msg.get("message") or "").strip()
        attachment = msg.get("attachment") if isinstance(msg.get("attachment"), dict) else None

        if not session.username or session.user_id is None:
            await self.send_error(session, "UNAUTHENTICATED", "Register session before sending messages", client_msg_id)
            return

        if sender_name.lower() != session.username.lower():
            await self.send_error(session, "SENDER_MISMATCH", "Sender does not match authenticated TCP session", client_msg_id)
            return

        if not recipient_name:
            await self.send_error(session, "INVALID_USERNAME", "Recipient username is required", client_msg_id)
            return

        if not content and not attachment:
            await self.send_error(session, "EMPTY_MESSAGE", "Message content cannot be empty", client_msg_id)
            return

        recipient_row = self.db.execute(
            "SELECT id, username, full_name, avatar_url FROM users WHERE LOWER(username) = LOWER(?)",
            (recipient_name,),
        ).fetchone()
        if recipient_row is None:
            await self.send_error(
                session,
                "INVALID_USERNAME",
                f"Recipient '{recipient_name}' does not exist",
                client_msg_id,
            )
            return

        recipient_id = int(recipient_row["id"])
        canonical_recipient = str(recipient_row["username"])
        low_id, high_id = sorted((session.user_id, recipient_id))
        direct_key = f"direct:{low_id}:{high_id}"

        now = utc_now_iso()
        conv_row = self.db.execute(
            "SELECT id FROM conversations WHERE direct_key = ?",
            (direct_key,),
        ).fetchone()

        if conv_row is None:
            cur = self.db.execute(
                "INSERT INTO conversations (type, direct_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?)",
                (direct_key, session.user_id, now, now),
            )
            conv_id = int(cur.lastrowid)
            self.db.execute(
                "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id, unread_count) VALUES (?, ?, 0)",
                (conv_id, session.user_id),
            )
            self.db.execute(
                "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id, unread_count) VALUES (?, ?, 0)",
                (conv_id, recipient_id),
            )
        else:
            conv_id = int(conv_row["id"])
            self.db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conv_id),
            )

        recipient_online = bool(self.sessions_by_username.get(canonical_recipient.lower()))
        delivery_status = "delivered" if recipient_online else "sent"
        msg_type_db = "attachment" if attachment else "text"

        att_name = str(attachment.get("name", ""))[:255] if attachment else ""
        att_url = str(attachment.get("url", ""))[:500] if attachment else ""
        att_mime = str(attachment.get("mime", ""))[:120] if attachment else ""
        att_size = int(attachment.get("size", 0) or 0) if attachment else 0

        cur = self.db.execute(
            """
            INSERT INTO messages (
                conversation_id, sender_id, client_msg_id, content, message_type,
                attachment_name, attachment_url, attachment_mime, attachment_size,
                delivery_status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conv_id,
                session.user_id,
                client_msg_id,
                content,
                msg_type_db,
                att_name,
                att_url,
                att_mime,
                att_size,
                delivery_status,
                now,
            ),
        )
        message_id = int(cur.lastrowid)

        if recipient_id != session.user_id:
            self.db.execute(
                """
                UPDATE conversation_participants
                SET unread_count = unread_count + 1
                WHERE conversation_id = ? AND user_id = ?
                """,
                (conv_id, recipient_id),
            )
        self.db.commit()

        sender_row = self.db.execute(
            "SELECT full_name, avatar_url FROM users WHERE id = ?",
            (session.user_id,),
        ).fetchone()

        outbound_payload = {
            "type": "chat_message",
            "message_id": message_id,
            "conversation_id": conv_id,
            "sender": session.username,
            "sender_id": session.user_id,
            "sender_name": str(sender_row["full_name"]) if sender_row else session.username,
            "sender_avatar": str(sender_row["avatar_url"] or "") if sender_row else "",
            "recipient": canonical_recipient,
            "message": content,
            "message_type": msg_type_db,
            "attachment": {
                "name": att_name,
                "url": att_url,
                "mime": att_mime,
                "size": att_size,
            }
            if att_url
            else None,
            "delivery_status": delivery_status,
            "client_msg_id": client_msg_id,
            "created_at": now,
        }

        delivered_sockets = 0
        if recipient_id != session.user_id:
            delivered_sockets = await self.broadcast_to_user(canonical_recipient, outbound_payload)

        if recipient_id != session.user_id and delivered_sockets == 0 and delivery_status == "delivered":
            # Edge race: recipient disconnected right before drain
            delivery_status = "sent"
            self.db.execute(
                "UPDATE messages SET delivery_status = 'sent' WHERE id = ?",
                (message_id,),
            )
            self.db.commit()

        logger.info(
            "ROUTED 1:1 id=%d conv=%d %s -> %s status=%s online_sockets=%d",
            message_id,
            conv_id,
            session.username,
            canonical_recipient,
            delivery_status,
            delivered_sockets,
        )

        ack_payload = {
            "type": "delivery_ack",
            "message_id": message_id,
            "conversation_id": conv_id,
            "client_msg_id": client_msg_id,
            "sender": session.username,
            "recipient": canonical_recipient,
            "message": content,
            "message_type": msg_type_db,
            "attachment": outbound_payload["attachment"],
            "delivery_status": delivery_status,
            "queued_offline": delivery_status == "sent" and recipient_id != session.user_id,
            "created_at": now,
        }
        await self.broadcast_to_user(session.username, ack_payload)

    async def handle_group_message(self, session: ClientSession, msg: dict[str, Any]) -> None:
        client_msg_id = str(msg.get("client_msg_id") or "")
        if not session.username or session.user_id is None:
            await self.send_error(session, "UNAUTHENTICATED", "Register session before sending group messages", client_msg_id)
            return

        group_id_raw = msg.get("group_id")
        conv_id_raw = msg.get("conversation_id")
        content = str(msg.get("message") or "").strip()
        attachment = msg.get("attachment") if isinstance(msg.get("attachment"), dict) else None

        if not content and not attachment:
            await self.send_error(session, "EMPTY_MESSAGE", "Group message content cannot be empty", client_msg_id)
            return

        group_row = None
        if group_id_raw is not None:
            group_row = self.db.execute(
                "SELECT id, conversation_id, name FROM groups WHERE id = ?",
                (int(group_id_raw),),
            ).fetchone()
        elif conv_id_raw is not None:
            group_row = self.db.execute(
                "SELECT id, conversation_id, name FROM groups WHERE conversation_id = ?",
                (int(conv_id_raw),),
            ).fetchone()

        if group_row is None:
            await self.send_error(session, "GROUP_NOT_FOUND", "Target group does not exist", client_msg_id)
            return

        group_id = int(group_row["id"])
        conv_id = int(group_row["conversation_id"])
        group_name = str(group_row["name"])

        membership = self.db.execute(
            "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, session.user_id),
        ).fetchone()
        if membership is None:
            await self.send_error(session, "FORBIDDEN", "You are not a member of this group", client_msg_id)
            return

        members = self.db.execute(
            """
            SELECT u.id, u.username
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            """,
            (group_id,),
        ).fetchall()

        other_online = any(
            str(m["username"]).lower() != session.username.lower()
            and bool(self.sessions_by_username.get(str(m["username"]).lower()))
            for m in members
        )
        delivery_status = "delivered" if other_online else "sent"
        now = utc_now_iso()
        msg_type_db = "attachment" if attachment else "text"

        att_name = str(attachment.get("name", ""))[:255] if attachment else ""
        att_url = str(attachment.get("url", ""))[:500] if attachment else ""
        att_mime = str(attachment.get("mime", ""))[:120] if attachment else ""
        att_size = int(attachment.get("size", 0) or 0) if attachment else 0

        cur = self.db.execute(
            """
            INSERT INTO messages (
                conversation_id, sender_id, client_msg_id, content, message_type,
                attachment_name, attachment_url, attachment_mime, attachment_size,
                delivery_status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conv_id,
                session.user_id,
                client_msg_id,
                content,
                msg_type_db,
                att_name,
                att_url,
                att_mime,
                att_size,
                delivery_status,
                now,
            ),
        )
        message_id = int(cur.lastrowid)

        self.db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
        self.db.execute(
            """
            UPDATE conversation_participants
            SET unread_count = unread_count + 1
            WHERE conversation_id = ? AND user_id != ?
            """,
            (conv_id, session.user_id),
        )
        self.db.commit()

        sender_row = self.db.execute(
            "SELECT full_name, avatar_url FROM users WHERE id = ?",
            (session.user_id,),
        ).fetchone()

        outbound_payload = {
            "type": "group_message",
            "message_id": message_id,
            "conversation_id": conv_id,
            "group_id": group_id,
            "group_name": group_name,
            "sender": session.username,
            "sender_id": session.user_id,
            "sender_name": str(sender_row["full_name"]) if sender_row else session.username,
            "sender_avatar": str(sender_row["avatar_url"] or "") if sender_row else "",
            "message": content,
            "message_type": msg_type_db,
            "attachment": {
                "name": att_name,
                "url": att_url,
                "mime": att_mime,
                "size": att_size,
            }
            if att_url
            else None,
            "delivery_status": delivery_status,
            "client_msg_id": client_msg_id,
            "created_at": now,
        }

        routed_count = 0
        for member in members:
            uname = str(member["username"])
            if uname.lower() != session.username.lower():
                routed_count += await self.broadcast_to_user(uname, outbound_payload)

        logger.info(
            "ROUTED GROUP id=%d group=%d (%s) sender=%s peers_delivered=%d",
            message_id,
            group_id,
            group_name,
            session.username,
            routed_count,
        )

        ack_payload = {
            "type": "delivery_ack",
            "message_id": message_id,
            "conversation_id": conv_id,
            "group_id": group_id,
            "client_msg_id": client_msg_id,
            "sender": session.username,
            "sender_name": outbound_payload["sender_name"],
            "sender_avatar": outbound_payload["sender_avatar"],
            "message": content,
            "message_type": msg_type_db,
            "attachment": outbound_payload["attachment"],
            "delivery_status": delivery_status,
            "created_at": now,
        }
        await self.broadcast_to_user(session.username, ack_payload)

    async def handle_typing(self, session: ClientSession, msg: dict[str, Any]) -> None:
        if not session.username or session.user_id is None:
            return
        conv_id = msg.get("conversation_id")
        is_typing = bool(msg.get("is_typing", False))
        recipient = str(msg.get("recipient") or "").strip()

        payload = {
            "type": "typing",
            "conversation_id": conv_id,
            "sender": session.username,
            "sender_name": session.full_name or session.username,
            "is_typing": is_typing,
            "timestamp": utc_now_iso(),
        }

        if conv_id is not None:
            peers = self.db.execute(
                """
                SELECT u.username
                FROM conversation_participants cp
                JOIN users u ON u.id = cp.user_id
                WHERE cp.conversation_id = ? AND u.id != ?
                """,
                (int(conv_id), session.user_id),
            ).fetchall()
            for p in peers:
                await self.broadcast_to_user(str(p["username"]), payload)
        elif recipient:
            await self.broadcast_to_user(recipient, payload)

    async def handle_read_receipt(self, session: ClientSession, msg: dict[str, Any]) -> None:
        if not session.username or session.user_id is None:
            return
        conv_id_raw = msg.get("conversation_id")
        if conv_id_raw is None:
            return
        conv_id = int(conv_id_raw)

        # Verify caller belongs to this conversation
        participant = self.db.execute(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
            (conv_id, session.user_id),
        ).fetchone()
        if participant is None:
            return

        unread_msgs = self.db.execute(
            """
            SELECT m.id, u.username AS sender_username
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ?
              AND m.sender_id != ?
              AND m.delivery_status != 'read'
            """,
            (conv_id, session.user_id),
        ).fetchall()

        self.db.execute(
            "UPDATE conversation_participants SET unread_count = 0 WHERE conversation_id = ? AND user_id = ?",
            (conv_id, session.user_id),
        )

        if unread_msgs:
            msg_ids = [int(r["id"]) for r in unread_msgs]
            placeholders = ",".join("?" for _ in msg_ids)
            self.db.execute(
                f"UPDATE messages SET delivery_status = 'read' WHERE id IN ({placeholders})",
                msg_ids,
            )
            self.db.commit()

            by_sender: dict[str, list[int]] = {}
            for r in unread_msgs:
                by_sender.setdefault(str(r["sender_username"]), []).append(int(r["id"]))

            for sender_uname, ids in by_sender.items():
                await self.broadcast_to_user(
                    sender_uname,
                    {
                        "type": "status_update",
                        "conversation_id": conv_id,
                        "message_ids": ids,
                        "delivery_status": "read",
                        "updated_by": session.username,
                        "timestamp": utc_now_iso(),
                    },
                )
        else:
            self.db.commit()


async def run_server() -> None:
    host = os.environ.get("TCP_HOST", "0.0.0.0")
    port = int(os.environ.get("TCP_PORT", "9000"))
    default_db = str(Path(__file__).resolve().parent.parent / "database" / "connectly.db")
    db_path = os.environ.get("DB_PATH", default_db)

    tcp_server = ConnectlyTCPServer(host=host, port=port, db_path=db_path)
    await tcp_server.start()

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    try:
        await stop_event.wait()
    finally:
        await tcp_server.stop()


if __name__ == "__main__":
    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        sys.exit(0)
