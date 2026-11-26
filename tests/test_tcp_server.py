#!/usr/bin/env python3
"""
Connectly TCP Server Automated Verification Suite.

Tests all required Data Communication & Networking behaviors directly against
the dedicated Python TCP server (tcp_server/server.py):
1. Connection establishment & session registration
2. Three+ simultaneous connected clients (grace, alex, maya)
3. One-to-one message delivery
4. Client disconnection & reconnection with offline message replay
5. Malformed JSON, invalid usernames, and empty message handling
6. Split TCP messages across multiple recv() reads
7. Multiple messages coalesced in a single TCP recv() read
8. Normal (FIN) vs abnormal (RST via SO_LINGER=0) TCP termination
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
TCP_SERVER_SCRIPT = ROOT_DIR / "tcp_server" / "server.py"
SCHEMA_SQL = ROOT_DIR / "database" / "schema.sql"


def hash_pw(password: str) -> str:
    salt = secrets.token_hex(16)
    derived = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()
    return f"scrypt${salt}${derived}"


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class JsonTcpClient:
    """Raw TCP socket test client supporting NDJSON framing."""

    def __init__(self, host: str, port: int, timeout: float = 4.0) -> None:
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock.settimeout(timeout)
        self._buf = bytearray()

    def send_json(self, payload: dict) -> None:
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        self.sock.sendall(raw)

    def send_raw(self, raw: bytes) -> None:
        self.sock.sendall(raw)

    def recv_json(self, predicate=None, timeout: float = 4.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            while b"\n" in self._buf:
                idx = self._buf.index(b"\n")
                line = bytes(self._buf[:idx]).decode("utf-8")
                del self._buf[: idx + 1]
                if not line.strip():
                    continue
                obj = json.loads(line)
                if predicate is None or predicate(obj):
                    return obj

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for matching JSON frame from TCP server")
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Server closed TCP connection (EOF)")
            self._buf.extend(chunk)

    def close_gracefully(self) -> None:
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def abort_with_rst(self) -> None:
        """Force immediate TCP RST packet using SO_LINGER=(1, 0)."""
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.sock.close()


class ConnectlyTcpServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.db_path = Path(cls.tmp_dir.name) / "test_connectly.db"
        cls.port = pick_free_port()

        # Initialize test SQLite database and seed 3 users
        conn = sqlite3.connect(str(cls.db_path))
        conn.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
        for uname, fname, email in [
            ("grace", "Grace Agorson", "grace@example.com"),
            ("alex", "Alex Mensah", "alex@example.com"),
            ("maya", "Maya Boateng", "maya@example.com"),
        ]:
            conn.execute(
                "INSERT INTO users (full_name, username, email, password_hash) VALUES (?, ?, ?, ?)",
                (fname, uname, email, hash_pw("password123")),
            )
        conn.commit()
        conn.close()

        env = os.environ.copy()
        env["TCP_HOST"] = "127.0.0.1"
        env["TCP_PORT"] = str(cls.port)
        env["DB_PATH"] = str(cls.db_path)

        cls.proc = subprocess.Popen(
            [sys.executable, str(TCP_SERVER_SCRIPT)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        # Wait until port accepts connections
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            try:
                s = socket.create_connection(("127.0.0.1", cls.port), timeout=0.5)
                s.close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("TCP server failed to start in time")

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
        cls.tmp_dir.cleanup()

    def test_01_three_simultaneous_clients_and_delivery(self) -> None:
        c_grace = JsonTcpClient("127.0.0.1", self.port)
        c_alex = JsonTcpClient("127.0.0.1", self.port)
        c_maya = JsonTcpClient("127.0.0.1", self.port)
        try:
            for client, uname in [(c_grace, "grace"), (c_alex, "alex"), (c_maya, "maya")]:
                client.send_json({"type": "register_session", "username": uname})
                reg = client.recv_json(lambda m: m.get("type") == "session_registered")
                self.assertEqual(reg["username"], uname)
                self.assertEqual(reg["connection"]["destination_port"], self.port)
                self.assertGreater(reg["connection"]["source_port"], 0)

            # Verify 3 active sessions reported via get_stats
            c_grace.send_json({"type": "get_stats"})
            stats = c_grace.recv_json(lambda m: m.get("type") == "stats")
            online = set(stats["server"]["online_users"])
            self.assertTrue({"grace", "alex", "maya"}.issubset(online))

            # Grace -> Alex
            c_grace.send_json({
                "type": "chat_message",
                "sender": "grace",
                "recipient": "alex",
                "message": "Hello Alex from Grace!",
                "client_msg_id": "m-1",
            })
            ack = c_grace.recv_json(lambda m: m.get("type") == "delivery_ack" and m.get("client_msg_id") == "m-1")
            self.assertEqual(ack["delivery_status"], "delivered")

            msg_alex = c_alex.recv_json(lambda m: m.get("type") == "chat_message" and m.get("sender") == "grace")
            self.assertEqual(msg_alex["message"], "Hello Alex from Grace!")

            # Alex -> Maya
            c_alex.send_json({
                "type": "chat_message",
                "sender": "alex",
                "recipient": "maya",
                "message": "Hi Maya, TCP routing confirmed.",
                "client_msg_id": "m-2",
            })
            msg_maya = c_maya.recv_json(lambda m: m.get("type") == "chat_message" and m.get("sender") == "alex")
            self.assertEqual(msg_maya["message"], "Hi Maya, TCP routing confirmed.")
        finally:
            c_grace.close_gracefully()
            c_alex.close_gracefully()
            c_maya.close_gracefully()
            time.sleep(0.1)

    def test_02_malformed_json_invalid_username_and_empty_message(self) -> None:
        c_grace = JsonTcpClient("127.0.0.1", self.port)
        try:
            c_grace.send_json({"type": "register_session", "username": "grace"})
            c_grace.recv_json(lambda m: m.get("type") == "session_registered")

            # Malformed JSON
            c_grace.send_raw(b"{not_valid_json: true\n")
            err1 = c_grace.recv_json(lambda m: m.get("type") == "error")
            self.assertEqual(err1["code"], "MALFORMED_JSON")

            # Invalid username
            c_grace.send_json({
                "type": "chat_message",
                "sender": "grace",
                "recipient": "nonexistent_user_999",
                "message": "Hello?",
            })
            err2 = c_grace.recv_json(lambda m: m.get("type") == "error")
            self.assertEqual(err2["code"], "INVALID_USERNAME")

            # Empty message
            c_grace.send_json({
                "type": "chat_message",
                "sender": "grace",
                "recipient": "alex",
                "message": "   ",
            })
            err3 = c_grace.recv_json(lambda m: m.get("type") == "error")
            self.assertEqual(err3["code"], "EMPTY_MESSAGE")

            # Verify socket stays healthy after errors
            c_grace.send_json({"type": "ping"})
            pong = c_grace.recv_json(lambda m: m.get("type") == "pong")
            self.assertEqual(pong["type"], "pong")
        finally:
            c_grace.close_gracefully()
            time.sleep(0.1)

    def test_03_split_tcp_message_across_multiple_reads(self) -> None:
        c_grace = JsonTcpClient("127.0.0.1", self.port)
        c_alex = JsonTcpClient("127.0.0.1", self.port)
        try:
            c_grace.send_json({"type": "register_session", "username": "grace"})
            c_grace.recv_json(lambda m: m.get("type") == "session_registered")
            c_alex.send_json({"type": "register_session", "username": "alex"})
            c_alex.recv_json(lambda m: m.get("type") == "session_registered")

            payload = (
                json.dumps({
                    "type": "chat_message",
                    "sender": "grace",
                    "recipient": "alex",
                    "message": "Split TCP stream message test",
                    "client_msg_id": "split-1",
                })
                + "\n"
            ).encode("utf-8")

            # Send 7 bytes at a time with short pauses to force partial TCP reads
            for i in range(0, len(payload), 7):
                c_grace.send_raw(payload[i : i + 7])
                time.sleep(0.01)

            delivered = c_alex.recv_json(
                lambda m: m.get("type") == "chat_message" and m.get("client_msg_id") == "split-1"
            )
            self.assertEqual(delivered["message"], "Split TCP stream message test")
        finally:
            c_grace.close_gracefully()
            c_alex.close_gracefully()
            time.sleep(0.1)

    def test_04_multiple_messages_in_single_tcp_read(self) -> None:
        c_grace = JsonTcpClient("127.0.0.1", self.port)
        c_alex = JsonTcpClient("127.0.0.1", self.port)
        try:
            c_grace.send_json({"type": "register_session", "username": "grace"})
            c_grace.recv_json(lambda m: m.get("type") == "session_registered")
            c_alex.send_json({"type": "register_session", "username": "alex"})
            c_alex.recv_json(lambda m: m.get("type") == "session_registered")

            batch = b"".join(
                (
                    json.dumps({
                        "type": "chat_message",
                        "sender": "grace",
                        "recipient": "alex",
                        "message": f"Batch item {idx}",
                        "client_msg_id": f"batch-{idx}",
                    })
                    + "\n"
                ).encode("utf-8")
                for idx in range(1, 5)
            )
            # Single sendall with 4 coalesced frames
            c_grace.send_raw(batch)

            received = []
            for idx in range(1, 5):
                msg = c_alex.recv_json(
                    lambda m, i=idx: m.get("type") == "chat_message" and m.get("client_msg_id") == f"batch-{i}"
                )
                received.append(msg["message"])
            self.assertEqual(received, ["Batch item 1", "Batch item 2", "Batch item 3", "Batch item 4"])
        finally:
            c_grace.close_gracefully()
            c_alex.close_gracefully()
            time.sleep(0.1)

    def test_05_disconnect_offline_queue_and_reconnect_plus_rst_termination(self) -> None:
        c_grace = JsonTcpClient("127.0.0.1", self.port)
        c_maya = JsonTcpClient("127.0.0.1", self.port)
        try:
            c_grace.send_json({"type": "register_session", "username": "grace"})
            c_grace.recv_json(lambda m: m.get("type") == "session_registered")
            c_maya.send_json({"type": "register_session", "username": "maya"})
            c_maya.recv_json(lambda m: m.get("type") == "session_registered")

            # Simulate abnormal termination (TCP RST) for Maya
            c_maya.abort_with_rst()
            time.sleep(0.2)

            # Grace sends message while Maya is disconnected
            c_grace.send_json({
                "type": "chat_message",
                "sender": "grace",
                "recipient": "maya",
                "message": "Offline queued message for Maya",
                "client_msg_id": "offline-1",
            })
            ack = c_grace.recv_json(lambda m: m.get("type") == "delivery_ack" and m.get("client_msg_id") == "offline-1")
            self.assertEqual(ack["delivery_status"], "sent")
            self.assertTrue(ack["queued_offline"])

            # Maya reconnects and automatically receives the queued message
            c_maya_reconnected = JsonTcpClient("127.0.0.1", self.port)
            try:
                c_maya_reconnected.send_json({"type": "register_session", "username": "maya"})
                replayed = c_maya_reconnected.recv_json(
                    lambda m: m.get("type") == "chat_message" and m.get("client_msg_id") == "offline-1"
                )
                self.assertEqual(replayed["message"], "Offline queued message for Maya")
                self.assertTrue(replayed["replayed_offline"])
            finally:
                c_maya_reconnected.close_gracefully()
        finally:
            c_grace.close_gracefully()


if __name__ == "__main__":
    unittest.main(verbosity=2)
