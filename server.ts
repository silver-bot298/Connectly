import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';
const TCP_PORT = Number(process.env.TCP_PORT || 9000);
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || './database/connectly.db');
const UPLOADS_DIR = path.resolve(__dirname, './uploads');
const SCHEMA_PATH = path.resolve(__dirname, './database/schema.sql');
const TCP_SERVER_SCRIPT = path.resolve(__dirname, './tcp_server/server.py');

const RUNTIME_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
function getSessionSecret(): string {
  return process.env.SESSION_SECRET || RUNTIME_SESSION_SECRET;
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Suppress experimental SQLite warning noise in server logs while keeping errors visible
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');
if (fs.existsSync(SCHEMA_PATH)) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
}

// --- Security & Utility Helpers ---
function utcNowIso(): string {
  return new Date().toISOString();
}

function expiryIso(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED_UPLOAD_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.pdf',
  '.txt',
  '.csv',
  '.json',
  '.zip',
]);

interface AuthUser {
  id: number;
  full_name: string;
  username: string;
  email: string;
  avatar_url: string;
  status_text: string;
  is_online: boolean;
  last_seen_at: string;
  created_at: string;
}

interface AuthedRequest extends Request {
  user?: AuthUser;
  tokenHash?: string;
}

function getUserByToken(rawToken: string): { user: AuthUser; tokenHash: string } | null {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT u.id, u.full_name, u.username, u.email, u.avatar_url, u.status_text,
              u.is_online, u.last_seen_at, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) return null;
  if (String(row.expires_at) < utcNowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  return {
    tokenHash,
    user: {
      id: Number(row.id),
      full_name: String(row.full_name),
      username: String(row.username),
      email: String(row.email),
      avatar_url: String(row.avatar_url || ''),
      status_text: String(row.status_text || ''),
      is_online: Boolean(row.is_online),
      last_seen_at: String(row.last_seen_at),
      created_at: String(row.created_at),
    },
  };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice(7).trim();
  const result = getUserByToken(token);
  if (!result) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  req.user = result.user;
  req.tokenHash = result.tokenHash;
  next();
}

// Track active browser WebSocket connections per username for REST-triggered group sync notices
const activeSocketsByUsername = new Map<string, Set<WebSocket>>();

function notifyUsersWorkspaceSync(usernames: string[], payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  for (const uname of usernames) {
    const set = activeSocketsByUsername.get(uname.toLowerCase());
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    }
  }
}

// --- Managed Python TCP Server Process ---
let tcpChild: ChildProcess | null = null;
let shuttingDown = false;

function startPythonTcpServer(): void {
  if (shuttingDown) return;
  tcpChild = spawn('python3', [TCP_SERVER_SCRIPT], {
    cwd: __dirname,
    env: {
      ...process.env,
      TCP_HOST,
      TCP_PORT: String(TCP_PORT),
      DB_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tcpChild.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').trimEnd().split('\n');
    for (const line of lines) {
      if (line) console.log(line);
    }
  });

  tcpChild.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').trimEnd().split('\n');
    for (const line of lines) {
      if (line) console.error(line);
    }
  });

  tcpChild.on('exit', (code, signal) => {
    console.warn(`[GATEWAY] Python TCP server exited (code=${code}, signal=${signal})`);
    tcpChild = null;
    if (!shuttingDown) {
      setTimeout(startPythonTcpServer, 1500);
    }
  });
}

function waitForTcpServer(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
      sock.once('connect', () => {
        sock.end();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve();
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

function queryTcpServerStats(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('TCP stats request timed out'));
    }, 2500);

    sock.once('connect', () => {
      sock.write(JSON.stringify({ type: 'get_stats' }) + '\n');
    });

    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buf.slice(0, idx).trim();
        sock.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });

    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function bootstrap(): Promise<void> {
  startPythonTcpServer();
  await waitForTcpServer();

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // Health
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      tcpTarget: `${TCP_HOST}:${TCP_PORT}`,
      timestamp: utcNowIso(),
    });
  });

  // --- Auth Routes ---
  app.post('/api/auth/register', (req, res) => {
    const fullName = String(req.body?.fullName ?? req.body?.full_name ?? '').trim();
    const username = String(req.body?.username ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm_password ?? '');
    let avatarUrl = String(req.body?.avatarUrl ?? req.body?.avatar_url ?? '').trim();

    if (fullName.length < 2 || fullName.length > 80) {
      res.status(400).json({ error: 'Full name must be between 2 and 80 characters.' });
      return;
    }
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, underscores).' });
      return;
    }
    if (!EMAIL_RE.test(email) || email.length > 120) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }
    if (password !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match.' });
      return;
    }
    if (avatarUrl && !avatarUrl.startsWith('/uploads/')) {
      avatarUrl = '';
    }

    const existing = db
      .prepare('SELECT username, email FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(username, email) as { username: string; email: string } | undefined;

    if (existing) {
      if (existing.username.toLowerCase() === username.toLowerCase()) {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const pwHash = hashPassword(password);
    const now = utcNowIso();
    const info = db
      .prepare(
        `INSERT INTO users (full_name, username, email, password_hash, avatar_url, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(fullName, username, email, pwHash, avatarUrl, now, now);

    const userId = Number(info.lastInsertRowid);
    const rawToken = generateToken();
    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, remember_me, expires_at, created_at) VALUES (?, ?, 0, ?, ?)'
    ).run(userId, hashToken(rawToken), expiryIso(24), now);

    const user = db
      .prepare(
        'SELECT id, full_name, username, email, avatar_url, status_text, is_online, last_seen_at, created_at FROM users WHERE id = ?'
      )
      .get(userId) as Record<string, unknown>;

    res.status(201).json({
      token: rawToken,
      user: { ...user, is_online: Boolean(user.is_online) },
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const password = String(req.body?.password ?? '');
    const rememberMe = Boolean(req.body?.rememberMe ?? req.body?.remember_me);

    if (!identifier || !password) {
      res.status(400).json({ error: 'Email or username and password are required.' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(identifier, identifier) as Record<string, unknown> | undefined;

    if (!row || !verifyPassword(password, String(row.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials. Please check your username/email and password.' });
      return;
    }

    const rawToken = generateToken();
    const ttlHours = rememberMe ? 24 * 14 : 24;
    const now = utcNowIso();
    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, remember_me, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(Number(row.id), hashToken(rawToken), rememberMe ? 1 : 0, expiryIso(ttlHours), now);

    res.json({
      token: rawToken,
      user: {
        id: Number(row.id),
        full_name: String(row.full_name),
        username: String(row.username),
        email: String(row.email),
        avatar_url: String(row.avatar_url || ''),
        status_text: String(row.status_text || ''),
        is_online: Boolean(row.is_online),
        last_seen_at: String(row.last_seen_at),
        created_at: String(row.created_at),
      },
    });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.tokenHash) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/forgot-password', (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    if (!identifier) {
      res.status(400).json({ error: 'Please provide your email address or username.' });
      return;
    }
    const user = db
      .prepare('SELECT id, username, email FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(identifier, identifier) as { id: number; username: string; email: string } | undefined;

    if (user) {
      const code = String(crypto.randomInt(100000, 999999));
      const codeHash = hashToken(`${user.id}:${code}`);
      const now = utcNowIso();
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
      db.prepare(
        'INSERT INTO password_resets (user_id, code_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)'
      ).run(user.id, codeHash, expires, now);

      console.log(`[AUTH] Password reset verification code for @${user.username} (${user.email}): ${code}`);
    }

    res.json({
      message:
        'If an account matches that email or username, a 6-digit verification code has been issued to the server console.',
    });
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const newPassword = String(req.body?.newPassword ?? '');
    const confirmPassword = String(req.body?.confirmPassword ?? '');

    if (!identifier || !code || newPassword.length < 6) {
      res.status(400).json({ error: 'Valid identifier, 6-digit code, and password (min 6 chars) are required.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match.' });
      return;
    }

    const user = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(identifier, identifier) as { id: number } | undefined;

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset code.' });
      return;
    }

    const expectedHash = hashToken(`${user.id}:${code}`);
    const resetRow = db
      .prepare(
        `SELECT id, expires_at FROM password_resets
         WHERE user_id = ? AND code_hash = ? AND used = 0
         ORDER BY id DESC LIMIT 1`
      )
      .get(user.id, expectedHash) as { id: number; expires_at: string } | undefined;

    if (!resetRow || resetRow.expires_at < utcNowIso()) {
      res.status(400).json({ error: 'Invalid or expired reset code.' });
      return;
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(resetRow.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

    res.json({ message: 'Password updated successfully. You can now log in.' });
  });

  app.post('/api/auth/change-password', requireAuth, (req: AuthedRequest, res) => {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    const confirmPassword = String(req.body?.confirmPassword ?? '');

    if (newPassword.length < 6 || newPassword !== confirmPassword) {
      res.status(400).json({ error: 'New password must be at least 6 characters and match confirmation.' });
      return;
    }

    const row = db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(req.user!.id) as { password_hash: string } | undefined;

    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user!.id);
    res.json({ message: 'Password updated.' });
  });

  // --- Upload Routes (supports pre-auth registration avatar upload as well as authenticated attachments) ---
  app.post('/api/uploads', (req: AuthedRequest, res) => {
    const authHeader = req.headers.authorization;
    const isAvatarUpload = Boolean(req.body?.purpose === 'avatar');

    if (!isAvatarUpload) {
      if (!authHeader || !authHeader.startsWith('Bearer ') || !getUserByToken(authHeader.slice(7).trim())) {
        res.status(401).json({ error: 'Authentication required for message attachments.' });
        return;
      }
    }

    const filename = String(req.body?.filename ?? '').trim();
    const mime = String(req.body?.mime ?? 'application/octet-stream').trim().slice(0, 120);
    const dataBase64 = String(req.body?.dataBase64 ?? '');

    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }
    if (isAvatarUpload && !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      res.status(400).json({ error: 'Profile pictures must be PNG, JPG, WEBP, or GIF.' });
      return;
    }

    const cleanedB64 = dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(cleanedB64, 'base64');
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'File must be between 1 byte and 5 MB.' });
      return;
    }

    const safeDiskName = `${crypto.randomUUID()}${ext}`;
    const destPath = path.resolve(UPLOADS_DIR, safeDiskName);
    if (!destPath.startsWith(UPLOADS_DIR + path.sep)) {
      res.status(400).json({ error: 'Invalid upload destination.' });
      return;
    }

    fs.writeFileSync(destPath, buf);
    res.status(201).json({
      name: path.basename(filename).slice(0, 120),
      url: `/uploads/${safeDiskName}`,
      mime,
      size: buf.length,
    });
  });

  app.get('/uploads/:filename', (req, res) => {
    const safeBase = path.basename(String(req.params.filename || ''));
    const targetPath = path.resolve(UPLOADS_DIR, safeBase);
    if (!targetPath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(targetPath);
  });

  // --- Users & Profile ---
  app.get('/api/users/search', requireAuth, (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? '').trim();
    const pattern = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT id, full_name, username, avatar_url, status_text, is_online, last_seen_at
         FROM users
         WHERE id != ? AND (username LIKE ? OR full_name LIKE ?)
         ORDER BY is_online DESC, full_name ASC
         LIMIT 50`
      )
      .all(req.user!.id, pattern, pattern) as Array<Record<string, unknown>>;

    res.json({
      users: rows.map((r) => ({ ...r, is_online: Boolean(r.is_online) })),
    });
  });

  app.patch('/api/users/profile', requireAuth, (req: AuthedRequest, res) => {
    const fullName = String(req.body?.fullName ?? req.user!.full_name).trim();
    const statusText = String(req.body?.statusText ?? req.user!.status_text).trim().slice(0, 120);
    let avatarUrl = String(req.body?.avatarUrl ?? req.user!.avatar_url).trim();

    if (fullName.length < 2 || fullName.length > 80) {
      res.status(400).json({ error: 'Full name must be 2-80 characters.' });
      return;
    }
    if (avatarUrl && !avatarUrl.startsWith('/uploads/')) {
      avatarUrl = req.user!.avatar_url;
    }

    db.prepare('UPDATE users SET full_name = ?, status_text = ?, avatar_url = ? WHERE id = ?').run(
      fullName,
      statusText,
      avatarUrl,
      req.user!.id
    );

    const updated = db
      .prepare(
        'SELECT id, full_name, username, email, avatar_url, status_text, is_online, last_seen_at, created_at FROM users WHERE id = ?'
      )
      .get(req.user!.id) as Record<string, unknown>;

    res.json({ user: { ...updated, is_online: Boolean(updated.is_online) } });
  });

  // --- Conversations & Messages ---
  app.get('/api/conversations', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const convRows = db
      .prepare(
        `SELECT c.id, c.type, c.title, c.updated_at, cp.unread_count
         FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id
         WHERE cp.user_id = ?
         ORDER BY c.updated_at DESC, c.id DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const conversations = convRows.map((c) => {
      const convId = Number(c.id);
      const lastMsg = db
        .prepare(
          `SELECT m.id, m.content, m.message_type, m.attachment_name, m.delivery_status,
                  m.created_at, u.username AS sender_username, u.full_name AS sender_name
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = ?
           ORDER BY m.id DESC LIMIT 1`
        )
        .get(convId) as Record<string, unknown> | undefined;

      if (c.type === 'direct') {
        const peer = db
          .prepare(
            `SELECT u.id, u.full_name, u.username, u.avatar_url, u.status_text, u.is_online, u.last_seen_at
             FROM conversation_participants cp
             JOIN users u ON u.id = cp.user_id
             WHERE cp.conversation_id = ? AND u.id != ?
             LIMIT 1`
          )
          .get(convId, userId) as Record<string, unknown> | undefined;

        return {
          id: convId,
          type: 'direct',
          unread_count: Number(c.unread_count || 0),
          updated_at: String(c.updated_at),
          peer: peer ? { ...peer, is_online: Boolean(peer.is_online) } : null,
          group: null,
          last_message: lastMsg || null,
        };
      } else {
        const group = db
          .prepare('SELECT id, name, description, avatar_url, created_by FROM groups WHERE conversation_id = ?')
          .get(convId) as Record<string, unknown> | undefined;

        const members = group
          ? (db
              .prepare(
                `SELECT u.id, u.full_name, u.username, u.avatar_url, u.is_online, gm.role
                 FROM group_members gm
                 JOIN users u ON u.id = gm.user_id
                 WHERE gm.group_id = ?
                 ORDER BY CASE gm.role WHEN 'admin' THEN 0 ELSE 1 END, u.full_name ASC`
              )
              .all(Number(group.id)) as Array<Record<string, unknown>>)
          : [];

        const myMember = members.find((m) => Number(m.id) === userId);

        return {
          id: convId,
          type: 'group',
          unread_count: Number(c.unread_count || 0),
          updated_at: String(c.updated_at),
          peer: null,
          group: group
            ? {
                id: Number(group.id),
                name: String(group.name),
                description: String(group.description || ''),
                avatar_url: String(group.avatar_url || ''),
                created_by: Number(group.created_by),
                my_role: String(myMember?.role || 'member'),
                member_count: members.length,
                members: members.map((m) => ({ ...m, is_online: Boolean(m.is_online) })),
              }
            : null,
          last_message: lastMsg || null,
        };
      }
    });

    res.json({ conversations });
  });

  app.post('/api/conversations/direct', requireAuth, (req: AuthedRequest, res) => {
    const targetUsername = String(req.body?.username ?? '').trim();
    if (!targetUsername) {
      res.status(400).json({ error: 'Target username is required.' });
      return;
    }

    const target = db
      .prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)')
      .get(targetUsername) as { id: number; username: string } | undefined;

    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    if (target.id === req.user!.id) {
      res.status(400).json({ error: 'Cannot start a direct chat with yourself.' });
      return;
    }

    const lowId = Math.min(req.user!.id, target.id);
    const highId = Math.max(req.user!.id, target.id);
    const directKey = `direct:${lowId}:${highId}`;

    const existing = db.prepare('SELECT id FROM conversations WHERE direct_key = ?').get(directKey) as
      | { id: number }
      | undefined;

    let convId: number;
    if (existing) {
      convId = Number(existing.id);
    } else {
      const now = utcNowIso();
      const info = db
        .prepare(
          "INSERT INTO conversations (type, direct_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?)"
        )
        .run(directKey, req.user!.id, now, now);
      convId = Number(info.lastInsertRowid);
      db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(
        convId,
        req.user!.id
      );
      db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(
        convId,
        target.id
      );
    }

    res.json({ conversationId: convId });
  });

  app.get('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    if (!Number.isInteger(convId) || convId <= 0) {
      res.status(400).json({ error: 'Invalid conversation ID.' });
      return;
    }

    const participant = db
      .prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.user!.id);

    if (!participant) {
      res.status(403).json({ error: 'Access denied to this conversation.' });
      return;
    }

    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sender_id, m.client_msg_id, m.content,
                m.message_type, m.attachment_name, m.attachment_url, m.attachment_mime,
                m.attachment_size, m.delivery_status, m.created_at,
                u.username AS sender, u.full_name AS sender_name, u.avatar_url AS sender_avatar
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ?
         ORDER BY m.id ASC
         LIMIT 500`
      )
      .all(convId) as Array<Record<string, unknown>>;

    res.json({
      messages: rows.map((r) => ({
        id: Number(r.id),
        conversation_id: Number(r.conversation_id),
        sender_id: Number(r.sender_id),
        sender: String(r.sender),
        sender_name: String(r.sender_name),
        sender_avatar: String(r.sender_avatar || ''),
        client_msg_id: String(r.client_msg_id || ''),
        message: String(r.content || ''),
        message_type: String(r.message_type),
        attachment: r.attachment_url
          ? {
              name: String(r.attachment_name || ''),
              url: String(r.attachment_url),
              mime: String(r.attachment_mime || ''),
              size: Number(r.attachment_size || 0),
            }
          : null,
        delivery_status: String(r.delivery_status),
        created_at: String(r.created_at),
      })),
    });
  });

  // --- Group Management Routes ---
  app.post('/api/groups', requireAuth, (req: AuthedRequest, res) => {
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim().slice(0, 240);
    const memberUsernames = Array.isArray(req.body?.memberUsernames)
      ? req.body.memberUsernames.map((u: unknown) => String(u).trim()).filter(Boolean)
      : [];

    if (name.length < 2 || name.length > 64) {
      res.status(400).json({ error: 'Group name must be between 2 and 64 characters.' });
      return;
    }

    const now = utcNowIso();
    const convInfo = db
      .prepare(
        "INSERT INTO conversations (type, title, created_by, created_at, updated_at) VALUES ('group', ?, ?, ?, ?)"
      )
      .run(name, req.user!.id, now, now);
    const convId = Number(convInfo.lastInsertRowid);

    const groupInfo = db
      .prepare('INSERT INTO groups (conversation_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(convId, name, description, req.user!.id, now);
    const groupId = Number(groupInfo.lastInsertRowid);

    db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(
      convId,
      req.user!.id
    );
    db.prepare('INSERT INTO group_members (group_id, user_id, role, added_by, joined_at) VALUES (?, ?, ?, ?, ?)').run(
      groupId,
      req.user!.id,
      'admin',
      req.user!.id,
      now
    );

    const addedUsernames = [req.user!.username];
    for (const uname of memberUsernames) {
      const m = db
        .prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)')
        .get(uname) as { id: number; username: string } | undefined;
      if (m && m.id !== req.user!.id) {
        db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(
          convId,
          m.id
        );
        db.prepare(
          'INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_by, joined_at) VALUES (?, ?, ?, ?, ?)'
        ).run(groupId, m.id, 'member', req.user!.id, now);
        addedUsernames.push(m.username);
      }
    }

    db.prepare(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, delivery_status, created_at)
       VALUES (?, ?, ?, 'system', 'delivered', ?)`
    ).run(convId, req.user!.id, `${req.user!.full_name} created group "${name}"`, now);

    notifyUsersWorkspaceSync(addedUsernames, { type: 'conversations_sync', group_id: groupId, conversation_id: convId });

    res.status(201).json({ groupId, conversationId: convId });
  });

  app.post('/api/groups/:id/members', requireAuth, (req: AuthedRequest, res) => {
    const groupId = Number(req.params.id);
    const username = String(req.body?.username ?? '').trim();
    if (!Number.isInteger(groupId) || !username) {
      res.status(400).json({ error: 'Valid group ID and username required.' });
      return;
    }

    const group = db
      .prepare('SELECT id, conversation_id, name FROM groups WHERE id = ?')
      .get(groupId) as { id: number; conversation_id: number; name: string } | undefined;
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    const callerRole = db
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, req.user!.id) as { role: string } | undefined;
    if (!callerRole || callerRole.role !== 'admin') {
      res.status(403).json({ error: 'Only group administrators can add members.' });
      return;
    }

    const target = db
      .prepare('SELECT id, username, full_name FROM users WHERE LOWER(username) = LOWER(?)')
      .get(username) as { id: number; username: string; full_name: string } | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const now = utcNowIso();
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(
      group.conversation_id,
      target.id
    );
    db.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_by, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).run(groupId, target.id, 'member', req.user!.id, now);

    db.prepare(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, delivery_status, created_at)
       VALUES (?, ?, ?, 'system', 'delivered', ?)`
    ).run(group.conversation_id, req.user!.id, `${req.user!.full_name} added @${target.username}`, now);

    const allMembers = db
      .prepare(
        'SELECT u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?'
      )
      .all(groupId) as Array<{ username: string }>;
    notifyUsersWorkspaceSync(
      allMembers.map((m) => m.username),
      { type: 'conversations_sync', group_id: groupId, conversation_id: group.conversation_id }
    );

    res.json({ ok: true });
  });

  app.delete('/api/groups/:id/members/:userId', requireAuth, (req: AuthedRequest, res) => {
    const groupId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const group = db
      .prepare('SELECT id, conversation_id FROM groups WHERE id = ?')
      .get(groupId) as { id: number; conversation_id: number } | undefined;
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    const callerRole = db
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, req.user!.id) as { role: string } | undefined;

    const isSelfLeave = targetUserId === req.user!.id;
    if (!callerRole || (!isSelfLeave && callerRole.role !== 'admin')) {
      res.status(403).json({ error: 'Only group administrators can remove members.' });
      return;
    }

    const targetUser = db
      .prepare('SELECT username, full_name FROM users WHERE id = ?')
      .get(targetUserId) as { username: string; full_name: string } | undefined;

    const remainingBefore = db
      .prepare(
        'SELECT u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?'
      )
      .all(groupId) as Array<{ username: string }>;

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetUserId);
    db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').run(
      group.conversation_id,
      targetUserId
    );

    // Ensure at least one admin remains if members still exist
    const adminCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ? AND role = 'admin'")
      .get(groupId) as { cnt: number };
    if (Number(adminCount.cnt) === 0) {
      const nextMember = db
        .prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at ASC LIMIT 1')
        .get(groupId) as { user_id: number } | undefined;
      if (nextMember) {
        db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(
          groupId,
          nextMember.user_id
        );
      }
    }

    if (targetUser) {
      const now = utcNowIso();
      const sysText = isSelfLeave
        ? `${targetUser.full_name} left the group`
        : `${req.user!.full_name} removed @${targetUser.username}`;
      db.prepare(
        `INSERT INTO messages (conversation_id, sender_id, content, message_type, delivery_status, created_at)
         VALUES (?, ?, ?, 'system', 'delivered', ?)`
      ).run(group.conversation_id, req.user!.id, sysText, now);
    }

    notifyUsersWorkspaceSync(
      remainingBefore.map((m) => m.username),
      { type: 'conversations_sync', group_id: groupId, conversation_id: group.conversation_id }
    );
    res.json({ ok: true });
  });

  app.patch('/api/groups/:id/members/:userId/role', requireAuth, (req: AuthedRequest, res) => {
    const groupId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const role = String(req.body?.role ?? '').trim();

    if (role !== 'admin' && role !== 'member') {
      res.status(400).json({ error: "Role must be 'admin' or 'member'." });
      return;
    }

    const group = db
      .prepare('SELECT id, conversation_id FROM groups WHERE id = ?')
      .get(groupId) as { id: number; conversation_id: number } | undefined;
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    const callerRole = db
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, req.user!.id) as { role: string } | undefined;
    if (!callerRole || callerRole.role !== 'admin') {
      res.status(403).json({ error: 'Only group administrators can assign roles.' });
      return;
    }

    if (role === 'member') {
      const admins = db
        .prepare("SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ? AND role = 'admin'")
        .get(groupId) as { cnt: number };
      const targetRow = db
        .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(groupId, targetUserId) as { role: string } | undefined;
      if (targetRow?.role === 'admin' && Number(admins.cnt) <= 1) {
        res.status(400).json({ error: 'Group must retain at least one administrator.' });
        return;
      }
    }

    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(
      role,
      groupId,
      targetUserId
    );

    const allMembers = db
      .prepare(
        'SELECT u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?'
      )
      .all(groupId) as Array<{ username: string }>;
    notifyUsersWorkspaceSync(
      allMembers.map((m) => m.username),
      { type: 'conversations_sync', group_id: groupId, conversation_id: group.conversation_id }
    );

    res.json({ ok: true });
  });

  // --- Network Diagnostics Route (queries live Python TCP Server) ---
  app.get('/api/network/diagnostics', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const stats = await queryTcpServerStats();
      res.json({
        gateway: {
          protocol: 'WebSocket (RFC 6455) over TCP',
          httpPort: PORT,
          tcpTargetHost: TCP_HOST,
          tcpTargetPort: TCP_PORT,
          framing: 'Newline-delimited JSON (NDJSON, UTF-8)',
        },
        tcpServer: stats,
      });
    } catch (err) {
      res.status(503).json({
        error: 'Unable to reach Python TCP messaging server',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // --- Frontend Serving (Vite dev middleware or built dist/) ---
  const server = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // --- WebSocket Gateway (/ws) -> Dedicated TCP Socket per Client ---
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const urlPath = (request.url || '').split('?')[0];
    if (urlPath !== '/ws') {
      // Allow Vite HMR upgrade in non-disabled environments, otherwise close
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let authedUser: AuthUser | null = null;
    let tcpSocket: net.Socket | null = null;
    let tcpBuffer = '';

    const authTimeout = setTimeout(() => {
      if (!authedUser && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', code: 'AUTH_TIMEOUT', message: 'WebSocket auth timeout' }));
        ws.close(4001, 'Auth timeout');
      }
    }, 10000);

    const cleanup = () => {
      clearTimeout(authTimeout);
      if (authedUser) {
        const set = activeSocketsByUsername.get(authedUser.username.toLowerCase());
        if (set) {
          set.delete(ws);
          if (set.size === 0) activeSocketsByUsername.delete(authedUser.username.toLowerCase());
        }
      }
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.end();
      }
    };

    ws.on('message', (rawData) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(rawData.toString('utf-8'));
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON', message: 'Invalid JSON frame' }));
        return;
      }

      if (!authedUser) {
        if (frame.type !== 'auth' || typeof frame.token !== 'string') {
          ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED', message: 'First frame must authenticate' }));
          ws.close(4001, 'Unauthenticated');
          return;
        }
        const verified = getUserByToken(frame.token);
        if (!verified) {
          ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED', message: 'Invalid or expired token' }));
          ws.close(4001, 'Invalid token');
          return;
        }
        clearTimeout(authTimeout);
        authedUser = verified.user;

        const key = authedUser.username.toLowerCase();
        if (!activeSocketsByUsername.has(key)) {
          activeSocketsByUsername.set(key, new Set());
        }
        activeSocketsByUsername.get(key)!.add(ws);

        // Open a dedicated TCP connection to the Python TCP server for this client
        tcpSocket = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
        tcpSocket.setNoDelay(true);

        tcpSocket.on('connect', () => {
          const registerFrame = {
            type: 'register_session',
            username: authedUser!.username,
            client_label: 'connectly-web-ws',
          };
          tcpSocket!.write(JSON.stringify(registerFrame) + '\n');
        });

        tcpSocket.on('data', (chunk: Buffer) => {
          tcpBuffer += chunk.toString('utf-8');
          let nlIndex = tcpBuffer.indexOf('\n');
          while (nlIndex !== -1) {
            const line = tcpBuffer.slice(0, nlIndex).trim();
            tcpBuffer = tcpBuffer.slice(nlIndex + 1);
            if (line && ws.readyState === WebSocket.OPEN) {
              ws.send(line);
            }
            nlIndex = tcpBuffer.indexOf('\n');
          }
        });

        tcpSocket.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1012, 'TCP backend disconnected');
          }
        });

        tcpSocket.on('error', (err) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'TCP_BRIDGE_ERROR',
                message: `TCP server connection error: ${err.message}`,
              })
            );
          }
        });
        return;
      }

      // Forward authenticated WebSocket messages to the dedicated TCP socket
      if (tcpSocket && !tcpSocket.destroyed) {
        const sanitized = {
          ...frame,
          sender: authedUser.username,
        };
        tcpSocket.write(JSON.stringify(sanitized) + '\n');
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  const handleShutdown = () => {
    shuttingDown = true;
    if (tcpChild) {
      tcpChild.kill('SIGTERM');
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[GATEWAY] Connectly HTTP & WebSocket Gateway listening on http://0.0.0.0:${PORT}`);
    console.log(`[GATEWAY] Bridging WebSockets (/ws) -> Python TCP Server (${TCP_HOST}:${TCP_PORT})`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
