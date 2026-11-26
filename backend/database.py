"""Database connection and schema initialization for Connectly Python backend."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def get_db_path() -> str:
    default_db = str(Path(__file__).resolve().parent.parent / "database" / "connectly.db")
    return os.environ.get("DB_PATH", default_db)


def get_connection() -> sqlite3.Connection:
    db_path = Path(get_db_path())
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    conn = get_connection()
    try:
        schema_path = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
        if schema_path.exists():
            conn.executescript(schema_path.read_text(encoding="utf-8"))
            conn.commit()
    finally:
        conn.close()
