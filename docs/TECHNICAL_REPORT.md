# Connectly Technical Report — Data Communication & Networking Practical Assessment

## 1. Executive Summary

**Connectly** is a multi-user real-time messaging platform built to demonstrate reliable transport-layer communication using **TCP sockets**, **WebSockets over TCP**, **newline-delimited JSON (NDJSON) message framing**, **persistent relational storage**, and **production cloud deployment**. Rather than relying on database polling or simulated timers, every chat message, typing indicator, delivery acknowledgement, and read receipt traverses an explicit end-to-end TCP path from the browser to a dedicated Python TCP socket server (`tcp_server/server.py`).

---

## 2. System Architecture & Port Mapping

Connectly separates presentation, protocol bridging, and core TCP routing into three distinct tiers:

1. **Browser Client (`src/`)**: React + Vite single-page application communicating with the gateway over HTTP/HTTPS and a persistent full-duplex WebSocket connection (`/ws`).
2. **WebSocket & HTTP Gateway (`backend/main.py` / `server.ts`)**:
   - Exposes REST endpoints (`/api/auth/*`, `/api/users/*`, `/api/conversations/*`, `/api/groups/*`, `/api/uploads`) on port `3000` (integrated dev/preview) or `8000` (FastAPI/Docker).
   - Terminates browser WebSocket connections at `/ws`.
   - For **every authenticated user WebSocket session**, opens a **dedicated outbound TCP socket** to the Python TCP server on port `9000`.
3. **Dedicated Python TCP Socket Server (`tcp_server/server.py`)**:
   - Binds an `AF_INET`, `SOCK_STREAM` socket to configurable `TCP_HOST` (default `0.0.0.0`) and `TCP_PORT` (default `9000`).
   - Maintains a live session registry mapping `username -> set[ClientSession]` and persists messages/state in SQLite (`database/connectly.db` with WAL mode).

### Documented Socket Addressing & 4-Tuple Identification

Every connected client forms a unique TCP 4-tuple recorded in server logs and visible inside the app's **TCP Socket Inspector**:

| Field | Example Value | Explanation |
| :--- | :--- | :--- |
| **Server IP Address** | `127.0.0.1` / `172.18.0.2` | IP bound by `tcp_server/server.py`. |
| **Listening Port (Destination Port)** | `9000` | Well-defined application port accepting TCP connections. |
| **Client IP Address** | `127.0.0.1` / `172.18.0.3` | IP address of the gateway or direct TCP test client. |
| **Source Port (Ephemeral Port)** | `54312`, `54314`, `54316` | OS-assigned ephemeral port uniquely identifying each client's TCP socket. |

Because the gateway opens one TCP socket per connected WebSocket user, **three simultaneous browser users generate three independent TCP connections** with distinct source ports (`e.g. :54312`, `:54314`, `:54316`) all targeting destination port `9000`.

---

## 3. TCP Stream Framing & Edge-Case Handling

TCP is a **byte-stream protocol** (`SOCK_STREAM`), not a message-preserving protocol. A single `send()` on one host can arrive across multiple `recv()` calls (fragmentation/splitting), or multiple `send()` calls can coalesce into a single `recv()` call (Nagle's algorithm / kernel buffering).

Connectly solves this with **newline-delimited JSON (NDJSON)** framing:
- Every protocol message is serialized to single-line UTF-8 JSON terminated by `\n` (`0x0A`).
- Example frame:
  ```json
  {"type":"chat_message","sender":"grace","recipient":"alex","message":"Hello!"}
  ```
- Each client handler in `tcp_server/server.py` maintains a dedicated `bytearray()` receive buffer:
  - **Split TCP messages**: When `reader.read(4096)` returns a partial JSON string without `\n`, bytes remain in `buffer` until subsequent TCP reads complete the frame.
  - **Coalesced multi-message reads**: `while b"\n" in buffer:` extracts and processes every complete line sequentially from a single read buffer.
  - **Frame size protection**: If `len(buffer) > 1_048_576` without `\n`, the server rejects the malformed stream with `FRAME_TOO_LARGE` and clears the buffer to protect memory.
  - **Malformed JSON**: `json.JSONDecodeError` returns `{"type":"error","code":"MALFORMED_JSON",...}` without dropping healthy TCP sessions.
  - **Invalid usernames / empty messages**: Validated against SQLite (`INVALID_USERNAME`, `EMPTY_MESSAGE`) with explicit error frames returned to the sender.
  - **Disconnected recipients**: Messages addressed to offline users are persisted in `messages` with `delivery_status = 'sent'`. When the recipient reconnects and sends `register_session`, `flush_pending_deliveries()` replays queued messages over their new TCP socket and upgrades their status to `'delivered'`.

---

## 4. Connection Lifecycle: Normal vs. Abnormal Termination

- **Establishment**: `socket.create_connection` / `asyncio.open_connection` completes the TCP 3-way handshake (`SYN` → `SYN-ACK` → `ACK`), followed by application-level `register_session`.
- **Normal Termination (`FIN`)**: Closing the browser tab or calling `sock.shutdown(SHUT_RDWR)` sends a TCP `FIN`. `await reader.read(4096)` returns `b""` (EOF), triggering `cleanup_session(..., "normal EOF (FIN)")`, marking `is_online = 0` in SQLite, and broadcasting `presence` (`is_online: false`) to peers.
- **Abnormal Termination (`RST`)**: Process crash or setting `SO_LINGER = (1, 0)` transmits a TCP `RST`. `reader.read()` raises `ConnectionResetError`, caught cleanly by `cleanup_session(..., "abnormal reset (RST)")` so other connected clients remain unaffected.

---

## 5. Authentication, Database Schema, and Security

- **Password Hashing**: Passwords are salted with 16 random bytes (`crypto.randomBytes(16)` / `secrets.token_hex(16)`) and hashed with **scrypt** (`N=16384, r=8, p=1`). Verification uses constant-time comparison (`timingSafeEqual` / `hmac.compare_digest`).
- **Session Management**: Tokens are 256-bit random values transmitted via `Authorization: Bearer` headers (stored in React memory, never `localStorage`), hashed with HMAC-SHA256 before storage in `sessions`.
- **WebSocket Identity Enforcement**: The `/ws` gateway authenticates the Bearer token on the initial handshake frame and overwrites `frame.sender` with the verified session username before forwarding over TCP, preventing sender spoofing.
- **SQL Injection & File Safety**: All database queries use parameterized `?` placeholders. Uploaded files are checked against an extension allowlist, size-capped at 5 MB, stored under UUID filenames, and served with `path.resolve` confinement and `X-Content-Type-Options: nosniff`.
- **Relational Schema (`database/schema.sql`)**: Normalized tables for `users`, `sessions`, `password_resets`, `conversations`, `conversation_participants`, `groups`, `group_members`, and `messages`.

---

## 6. TCP vs. UDP Empirical Comparison

Using `tests/tcp_vs_udp_benchmark.py` with **120 numbered JSON messages**:

| Transport Protocol | Sent | Received | Lost | Delivery Rate | Out-of-Order | Elapsed Time |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **TCP (`SOCK_STREAM`)** | 120 | 120 | 0 | 100.00% | 0 | ~7.5 ms |
| **UDP (`SOCK_DGRAM`, 0% loss)** | 120 | 120 | 0 | 100.00% | 0 | ~27.1 ms |
| **UDP (`SOCK_DGRAM`, 5% simulated loss)** | 120 | 112 | 8 | 93.33% | 0 | ~26.2 ms |

**Key Engineering Takeaway**: Because chat messaging requires guaranteed in-order delivery without silent message drops, **TCP** is the appropriate transport protocol. TCP's sequence numbers, cumulative ACKs, sliding window flow control, and automatic retransmission eliminate application-level loss, whereas UDP requires re-implementing reliability in user space.

---

## 7. Wireshark Packet Analysis Verification

During demonstration:
1. Start capture on loopback (`lo`) or VM interface (`eth0`) with filter `tcp.port == 9000`.
2. Connect 3 clients (`grace`, `alex`, `maya`) and verify 3 distinct ephemeral source ports completing `SYN`/`SYN-ACK`/`ACK` to port `9000`.
3. Send a message from `grace` to `alex` and inspect the TCP `PSH, ACK` segment payload containing `{"type":"chat_message",...}`.
4. Enable temporary loss (`sudo tc qdisc add dev lo root netem loss 10%`) and observe `tcp.analysis.retransmission` frames recovering lost segments without losing chat messages.
5. Close one client cleanly (`FIN`) and abort another (`RST` via `test_tcp_server.py`) to compare normal vs. abnormal TCP teardown flags.

---

## 8. Cloud Deployment Summary

Connectly is packaged with a multi-stage `Dockerfile`, `docker-compose.yml`, and `deployment/nginx.conf` for AWS EC2 or Azure Virtual Machines:
- **Nginx (`:80`, `:443`)** terminates TLS (`HTTPS`/`WSS`), serves the compiled React static bundle, and proxies `/api/` and `/ws` to the gateway.
- **FastAPI Gateway (`:8000`)** verifies authentication and bridges `/ws` over internal Docker networking to `tcp_server:9000`.
- **Python TCP Server (`:9000`)** routes all real-time frames and persists state to a mounted Docker volume (`/app/data/connectly.db`).
