# Connectly — Real-Time Multi-User TCP Messaging Application

Connectly is a full-stack real-time messaging application designed for multi-user one-to-one and group communication over **dedicated Python TCP socket connections**. It uses the **Burgundy Muse** visual palette (`#651F35` Deep Burgundy, `#C58C91` Dusty Rose, `#F5EDE5` Soft Beige) and fulfills Data Communication & Networking practical requirements for TCP socket programming, newline-delimited JSON framing, packet capture analysis, and cloud deployment.

---

## Architecture Overview

```
+-----------------------+         HTTPS / WSS (TCP:443)         +-------------------------------+
|  Browser Clients      | <===================================> |  Nginx Reverse Proxy          |
|  (React + Vite UI)    |     WebSocket RFC 6455 over TCP       |  TLS Termination (443 -> 80)  |
+-----------------------+                                       +---------------+---------------+
                                                                                |
                                                                HTTP / WS (TCP:8000 or :3000)
                                                                                |
                                                                +---------------v---------------+
                                                                |  WebSocket & REST Gateway     |
                                                                |  - backend/main.py (FastAPI)  |
                                                                |  - server.ts (Express + ws)   |
                                                                +---------------+---------------+
                                                                                |
                                                   Dedicated TCP Socket per Client (NDJSON \n)
                                                     e.g. 127.0.0.1:54312 -> 127.0.0.1:9000
                                                                                |
                                                                +---------------v---------------+
                                                                |  Dedicated Python TCP Server  |
                                                                |  tcp_server/server.py (:9000) |
                                                                +---------------+---------------+
                                                                                |
                                                                                v
                                                                +-------------------------------+
                                                                |  SQLite Database (WAL Mode)   |
                                                                |  database/schema.sql          |
                                                                +-------------------------------+
```

---

## Directory Structure

| Path | Purpose |
| :--- | :--- |
| `tcp_server/server.py` | Dedicated Python `asyncio` TCP socket server (`AF_INET`, `SOCK_STREAM`) handling NDJSON framing, split/coalesced reads, routing, presence, and offline replay. |
| `backend/` | Python FastAPI REST API + WebSocket gateway (`main.py`, `auth.py`, `database.py`, `requirements.txt`). |
| `server.ts` | Node/Express + `ws` gateway + Vite runtime for port `3000` that spawns `tcp_server/server.py` and opens one `net.Socket` TCP connection per authenticated browser client. |
| `database/schema.sql` | Relational SQLite schema (`users`, `sessions`, `password_resets`, `conversations`, `conversation_participants`, `groups`, `group_members`, `messages`). |
| `src/` | React + Vite + Tailwind CSS v4 frontend (`AuthScreen.tsx`, `ChatDashboard.tsx`, `Modals.tsx`, `api.ts`). |
| `tests/` | Automated TCP socket tests (`test_tcp_server.py`) and 120-message TCP vs UDP benchmark (`tcp_vs_udp_benchmark.py`). |
| `deployment/` | Nginx HTTPS/WSS reverse proxy config (`nginx.conf`) and container entrypoint (`entrypoint.sh`). |
| `Dockerfile`, `docker-compose.yml` | Multi-stage Docker build and orchestrated stack (`tcp_server`, `gateway`, `nginx`). |
| `docs/TECHNICAL_REPORT.md` | Full university practical assessment report covering sockets, framing, Wireshark, security, and cloud deployment. |

---

## Local Execution Instructions

### Option A: Integrated Gateway + Python TCP Server (Port 3000)

1. Install Node dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` if customizing ports or secrets:
   ```bash
   cp .env.example .env
   ```
3. Start the application (automatically spawns `python3 tcp_server/server.py` on port `9000` and the Express/WS/Vite gateway on port `3000`):
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000` in two or three separate browser tabs/incognito windows, register accounts (e.g., `grace`, `alex`, `maya`), and exchange real-time messages.

### Option B: Standalone Python TCP Server + FastAPI Gateway

1. Install Python dependencies in a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. Terminal 1 — Start the dedicated Python TCP Server:
   ```bash
   TCP_HOST=0.0.0.0 TCP_PORT=9000 python3 tcp_server/server.py
   ```
3. Terminal 2 — Start the FastAPI WebSocket & HTTP Gateway:
   ```bash
   TCP_HOST=127.0.0.1 TCP_PORT=9000 uvicorn main:app --app-dir backend --host 0.0.0.0 --port 8000
   ```
4. Terminal 3 — Build or serve the frontend (`npm run build` serves via Nginx/FastAPI or `npm run dev` on port `3000`).

---

## Docker Execution Instructions

```bash
# 1. Build frontend dist for Nginx static serving
npm install && npm run build

# 2. Configure environment variables
cp .env.example .env
# Set SESSION_SECRET and APP_URL inside .env

# 3. Build and start all services (TCP server, FastAPI gateway, Nginx)
docker compose up -d --build

# 4. Inspect running containers and TCP server logs
docker compose ps
docker compose logs -f tcp_server

# 5. Stop services cleanly
docker compose down
```

---

## Testing & Networking Verification Commands

### 1. Run Automated TCP Protocol & Edge-Case Suite
Tests 3 simultaneous clients, delivery, disconnection/reconnection + offline replay, malformed JSON, invalid usernames, empty messages, split TCP messages, coalesced multi-message reads, and `FIN` vs `RST` termination:

```bash
python3 tests/test_tcp_server.py
```

### 2. Run TCP vs UDP 120-Message Comparison Benchmark
```bash
python3 tests/tcp_vs_udp_benchmark.py --count 120 --udp-loss 0.05
```

### 3. Simulate TCP Retransmissions on Linux (`tc netem`)
To observe TCP retransmissions (`tcp.analysis.retransmission`) in Wireshark on loopback (`lo`):
```bash
# Inject 10% artificial packet loss on loopback
sudo tc qdisc add dev lo root netem loss 10%

# Generate traffic across TCP port 9000
python3 tests/test_tcp_server.py

# Remove netem rule immediately after capture
sudo tc qdisc del dev lo root
```

---

## Wireshark Investigation Guide

1. **Capture Interface**:
   - Local testing: select **Adapter for loopback traffic capture (`lo` / `lo0`)**.
   - Cloud VM testing: select the primary Ethernet interface (`eth0` / `ens5`).
2. **Capture Filter**:
   ```
   tcp port 9000 or tcp port 3000 or tcp port 8000
   ```
3. **Useful Display Filters**:
   - All traffic on the dedicated Python TCP server: `tcp.port == 9000`
   - TCP 3-way handshake (`SYN`, `SYN-ACK`, `ACK`): `tcp.port == 9000 && tcp.flags.syn == 1`
   - Normal graceful disconnect (`FIN`): `tcp.port == 9000 && tcp.flags.fin == 1`
   - Abnormal abrupt disconnect (`RST`): `tcp.port == 9000 && tcp.flags.reset == 1`
   - TCP retransmissions: `tcp.port == 9000 && tcp.analysis.retransmission`
   - Browser WebSocket frames: `websocket`
4. **Inspecting Payloads**: Right-click any packet on port `9000` → **Follow → TCP Stream** to view the raw newline-delimited JSON frames (`{"type":"chat_message","sender":"grace",...}`).

---

## Cloud Deployment (AWS EC2 / Azure Virtual Machine)

### Firewall & Security Group Rules

| Port | Protocol | Source | Purpose |
| :--- | :--- | :--- | :--- |
| `22` | TCP | Admin IP only | SSH administration |
| `80` | TCP | `0.0.0.0/0` | HTTP redirect to HTTPS + Let's Encrypt ACME |
| `443` | TCP | `0.0.0.0/0` | Public HTTPS web app & WSS WebSocket endpoint |
| `9000` | TCP | Internal Docker/VPC (`127.0.0.1` or VPC CIDR) | Dedicated Python TCP server (restrict public access in production unless demonstrating direct remote TCP clients) |

### Deployment Steps (Ubuntu 22.04/24.04 VM)

1. Install Docker Engine, Docker Compose plugin, Node 22, and Certbot:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 certbot
   ```
2. Point your domain DNS `A` record to the VM's public IPv4 address and obtain a TLS certificate:
   ```bash
   sudo certbot certonly --standalone -d chat.example.com
   ```
3. Update `server_name` and certificate paths in `deployment/nginx.conf`, set `APP_URL=https://chat.example.com` and a strong random `SESSION_SECRET` in `.env`, then launch:
   ```bash
   npm install && npm run build
   docker compose up -d --build
   ```
4. **Verify Remote Communication**:
   - User A opens `https://chat.example.com` on Laptop/Phone 1 and registers `@grace`.
   - User B opens `https://chat.example.com` on a different network/device and registers `@alex`.
   - Send messages, attachments, and typing events; open **TCP Socket Inspector** in the sidebar to verify each user's live TCP 4-tuple on port `9000`.
