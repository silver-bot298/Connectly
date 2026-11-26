"""
Connectly FastAPI WebSocket Gateway & HTTP API.

Serves authentication, user search, conversation/group management, file uploads,
and bridges browser WebSocket clients to the dedicated Python TCP server via
individual asyncio TCP socket connections.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from auth import (
    expiry_iso,
    generate_token,
    hash_password,
    hash_token,
    utc_now_iso,
    verify_password,
)
from database import get_connection, init_db

TCP_HOST = os.environ.get("TCP_HOST", "127.0.0.1")
TCP_PORT = int(os.environ.get("TCP_PORT", "9000"))
UPLOADS_DIR = (Path(__file__).resolve().parent.parent / "uploads").resolve()
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".pdf", ".txt", ".csv", ".json", ".zip",
}
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,24}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Connectly WebSocket & REST Gateway", version="1.0.0", lifespan=lifespan)

app_origin = os.environ.get("APP_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[app_origin, "http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=80)
    username: str = Field(min_length=3, max_length=24)
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=6, max_length=128)
    confirm_password: str = Field(min_length=6, max_length=128)
    avatar_url: str = ""


class LoginRequest(BaseModel):
    identifier: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=1, max_length=128)
    remember_me: bool = False


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(default="", max_length=240)
    member_usernames: list[str] = Field(default_factory=list)


class DirectConvRequest(BaseModel):
    username: str


class UploadRequest(BaseModel):
    filename: str
    mime: str
    data_base64: str


def get_current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid bearer token")

    token_hash = hash_token(token)
    conn = get_connection()
    try:
        row = conn.execute(
            """
            SELECT u.id, u.full_name, u.username, u.email, u.avatar_url,
                   u.status_text, u.is_online, u.last_seen_at, u.created_at,
                   s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if row is None or str(row["expires_at"]) < utc_now_iso():
            raise HTTPException(status_code=401, detail="Session expired or invalid")
        return {
            "id": int(row["id"]),
            "full_name": row["full_name"],
            "username": row["username"],
            "email": row["email"],
            "avatar_url": row["avatar_url"],
            "status_text": row["status_text"],
            "is_online": bool(row["is_online"]),
            "last_seen_at": row["last_seen_at"],
            "created_at": row["created_at"],
        }
    finally:
        conn.close()


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    return {"status": "ok", "tcp_target": f"{TCP_HOST}:{TCP_PORT}", "timestamp": utc_now_iso()}


@app.post("/api/auth/register")
def register(payload: RegisterRequest) -> dict[str, Any]:
    username = payload.username.strip()
    email = payload.email.strip().lower()
    full_name = payload.full_name.strip()

    if not USERNAME_RE.match(username):
        raise HTTPException(status_code=400, detail="Username must be 3-24 alphanumeric or underscore characters")
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Please enter a valid email address")
    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")

    conn = get_connection()
    try:
        existing = conn.execute(
            "SELECT username, email FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
            (username, email),
        ).fetchone()
        if existing:
            if str(existing["username"]).lower() == username.lower():
                raise HTTPException(status_code=409, detail="Username is already taken")
            raise HTTPException(status_code=409, detail="Email is already registered")

        pw_hash = hash_password(payload.password)
        now = utc_now_iso()
        cur = conn.execute(
            """
            INSERT INTO users (full_name, username, email, password_hash, avatar_url, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (full_name, username, email, pw_hash, payload.avatar_url.strip(), now, now),
        )
        user_id = int(cur.lastrowid)

        raw_token = generate_token()
        conn.execute(
            "INSERT INTO sessions (user_id, token_hash, remember_me, expires_at, created_at) VALUES (?, ?, 0, ?, ?)",
            (user_id, hash_token(raw_token), expiry_iso(24), now),
        )
        conn.commit()
        user = conn.execute(
            "SELECT id, full_name, username, email, avatar_url, status_text, is_online, last_seen_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return {"token": raw_token, "user": dict(user)}
    finally:
        conn.close()


@app.post("/api/auth/login")
def login(payload: LoginRequest) -> dict[str, Any]:
    identifier = payload.identifier.strip()
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
            (identifier, identifier),
        ).fetchone()
        if row is None or not verify_password(payload.password, str(row["password_hash"])):
            raise HTTPException(status_code=401, detail="Invalid username/email or password")

        raw_token = generate_token()
        hours = 24 * 14 if payload.remember_me else 24
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO sessions (user_id, token_hash, remember_me, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (int(row["id"]), hash_token(raw_token), 1 if payload.remember_me else 0, expiry_iso(hours), now),
        )
        conn.commit()
        return {
            "token": raw_token,
            "user": {
                "id": int(row["id"]),
                "full_name": row["full_name"],
                "username": row["username"],
                "email": row["email"],
                "avatar_url": row["avatar_url"],
                "status_text": row["status_text"],
                "is_online": bool(row["is_online"]),
                "last_seen_at": row["last_seen_at"],
            },
        }
    finally:
        conn.close()


@app.get("/api/auth/me")
def me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return {"user": user}


@app.get("/api/users/search")
def search_users(q: str = Query(default=""), user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    conn = get_connection()
    try:
        pattern = f"%{q.strip()}%"
        rows = conn.execute(
            """
            SELECT id, full_name, username, avatar_url, status_text, is_online, last_seen_at
            FROM users
            WHERE id != ? AND (username LIKE ? OR full_name LIKE ?)
            ORDER BY is_online DESC, full_name ASC
            LIMIT 50
            """,
            (user["id"], pattern, pattern),
        ).fetchall()
        return {"users": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/uploads")
def upload_file(payload: UploadRequest, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    ext = Path(payload.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type")
    try:
        raw = base64.b64decode(payload.data_base64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 upload payload")

    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File exceeds 5 MB limit")

    safe_name = f"{uuid.uuid4().hex}{ext}"
    dest = (UPLOADS_DIR / safe_name).resolve()
    if not str(dest).startswith(str(UPLOADS_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid target path")
    dest.write_bytes(raw)
    return {
        "name": Path(payload.filename).name[:120],
        "url": f"/uploads/{safe_name}",
        "mime": payload.mime[:120],
        "size": len(raw),
    }


@app.get("/uploads/{filename}")
def serve_upload(filename: str):
    candidate = (UPLOADS_DIR / Path(filename).name).resolve()
    if not str(candidate).startswith(str(UPLOADS_DIR) + os.sep) or not candidate.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(candidate, headers={"X-Content-Type-Options": "nosniff"})


@app.post("/api/conversations/direct")
def create_or_get_direct(payload: DirectConvRequest, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    conn = get_connection()
    try:
        target = conn.execute(
            "SELECT id, username, full_name FROM users WHERE LOWER(username) = LOWER(?)",
            (payload.username.strip(),),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found")
        low_id, high_id = sorted((user["id"], int(target["id"])))
        direct_key = f"direct:{low_id}:{high_id}"
        row = conn.execute("SELECT id FROM conversations WHERE direct_key = ?", (direct_key,)).fetchone()
        now = utc_now_iso()
        if row is None:
            cur = conn.execute(
                "INSERT INTO conversations (type, direct_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?)",
                (direct_key, user["id"], now, now),
            )
            conv_id = int(cur.lastrowid)
            conn.execute(
                "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)",
                (conv_id, user["id"]),
            )
            conn.execute(
                "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)",
                (conv_id, int(target["id"])),
            )
            conn.commit()
        else:
            conv_id = int(row["id"])
        return {"conversation_id": conv_id}
    finally:
        conn.close()


@app.post("/api/groups")
def create_group(payload: CreateGroupRequest, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    conn = get_connection()
    try:
        now = utc_now_iso()
        cur = conn.execute(
            "INSERT INTO conversations (type, title, created_by, created_at, updated_at) VALUES ('group', ?, ?, ?, ?)",
            (payload.name.strip(), user["id"], now, now),
        )
        conv_id = int(cur.lastrowid)
        g_cur = conn.execute(
            "INSERT INTO groups (conversation_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (conv_id, payload.name.strip(), payload.description.strip(), user["id"], now),
        )
        group_id = int(g_cur.lastrowid)
        conn.execute(
            "INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)",
            (conv_id, user["id"]),
        )
        conn.execute(
            "INSERT INTO group_members (group_id, user_id, role, added_by, joined_at) VALUES (?, ?, 'admin', ?, ?)",
            (group_id, user["id"], user["id"], now),
        )
        for uname in payload.member_usernames:
            m = conn.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (uname.strip(),)).fetchone()
            if m and int(m["id"]) != user["id"]:
                conn.execute(
                    "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)",
                    (conv_id, int(m["id"])),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_by, joined_at) VALUES (?, ?, 'member', ?, ?)",
                    (group_id, int(m["id"]), user["id"], now),
                )
        conn.commit()
        return {"group_id": group_id, "conversation_id": conv_id}
    finally:
        conn.close()


@app.websocket("/ws")
async def websocket_gateway(websocket: WebSocket) -> None:
    await websocket.accept()
    tcp_reader: asyncio.StreamReader | None = None
    tcp_writer: asyncio.StreamWriter | None = None
    pump_task: asyncio.Task[None] | None = None

    try:
        # Expect first frame to authenticate Bearer token
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=15.0)
        auth_frame = json.loads(raw_auth)
        if not isinstance(auth_frame, dict) or auth_frame.get("type") != "auth":
            await websocket.send_text(json.dumps({"type": "error", "code": "UNAUTHENTICATED", "message": "Auth frame required"}))
            await websocket.close(code=4001)
            return

        token = str(auth_frame.get("token") or "").strip()
        conn = get_connection()
        try:
            row = conn.execute(
                """
                SELECT u.id, u.username, s.expires_at
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ?
                """,
                (hash_token(token),),
            ).fetchone()
        finally:
            conn.close()

        if row is None or str(row["expires_at"]) < utc_now_iso():
            await websocket.send_text(json.dumps({"type": "error", "code": "UNAUTHENTICATED", "message": "Invalid session token"}))
            await websocket.close(code=4001)
            return

        verified_username = str(row["username"])

        # Open a dedicated TCP socket connection to the Python TCP messaging server
        tcp_reader, tcp_writer = await asyncio.open_connection(TCP_HOST, TCP_PORT)
        register_payload = json.dumps({
            "type": "register_session",
            "username": verified_username,
            "client_label": "fastapi-ws-gateway",
        }) + "\n"
        tcp_writer.write(register_payload.encode("utf-8"))
        await tcp_writer.drain()

        async def tcp_to_ws() -> None:
            assert tcp_reader is not None
            buf = bytearray()
            while True:
                chunk = await tcp_reader.read(4096)
                if not chunk:
                    break
                buf.extend(chunk)
                while b"\n" in buf:
                    idx = buf.index(b"\n")
                    line = bytes(buf[:idx]).decode("utf-8", errors="replace").strip()
                    del buf[: idx + 1]
                    if line:
                        await websocket.send_text(line)

        pump_task = asyncio.create_task(tcp_to_ws())

        while True:
            ws_text = await websocket.receive_text()
            frame = json.loads(ws_text)
            if not isinstance(frame, dict):
                continue
            # Enforce authenticated sender identity on outbound TCP frames
            frame["sender"] = verified_username
            tcp_writer.write((json.dumps(frame) + "\n").encode("utf-8"))
            await tcp_writer.drain()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_text(json.dumps({"type": "error", "code": "GATEWAY_ERROR", "message": str(exc)}))
        except Exception:
            pass
    finally:
        if pump_task is not None:
            pump_task.cancel()
        if tcp_writer is not None:
            try:
                tcp_writer.close()
                await tcp_writer.wait_closed()
            except Exception:
                pass
