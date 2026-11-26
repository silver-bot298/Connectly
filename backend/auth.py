"""Password hashing and session token helpers using Python standard library."""

from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import secrets

_RUNTIME_SECRET = secrets.token_hex(32)


def get_session_secret() -> str:
    return os.environ.get("SESSION_SECRET") or _RUNTIME_SECRET


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=32,
    ).hex()
    return f"scrypt${salt}${derived}"


def verify_password(password: str, stored_hash: str) -> bool:
    parts = stored_hash.split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    _, salt, expected_hex = parts
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=32,
    ).hex()
    return hmac.compare_digest(derived, expected_hex)


def hash_token(token: str) -> str:
    return hmac.new(
        get_session_secret().encode("utf-8"),
        token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def expiry_iso(hours: int) -> str:
    dt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
