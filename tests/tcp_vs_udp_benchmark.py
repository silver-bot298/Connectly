#!/usr/bin/env python3
"""
TCP vs UDP Reliability & Ordering Comparison Benchmark.

Sends N >= 100 numbered messages (default: 120) over both TCP (SOCK_STREAM)
and UDP (SOCK_DGRAM) sockets, measures delivery rate, out-of-order count,
duplicate/lost packets, and elapsed transmission time.
"""

from __future__ import annotations

import argparse
import json
import random
import socket
import threading
import time
from dataclasses import dataclass


@dataclass
class BenchmarkResult:
    protocol: str
    sent: int
    received: int
    lost: int
    out_of_order: int
    elapsed_ms: float

    @property
    def delivery_pct(self) -> float:
        return (self.received / self.sent) * 100.0 if self.sent else 0.0


def run_tcp_benchmark(count: int, payload_bytes: int) -> BenchmarkResult:
    received_seqs: list[int] = []
    ready = threading.Event()
    server_port_holder: list[int] = []

    def tcp_receiver() -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        server_port_holder.append(int(srv.getsockname()[1]))
        ready.set()

        conn, _ = srv.accept()
        buf = bytearray()
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf.extend(chunk)
            while b"\n" in buf:
                idx = buf.index(b"\n")
                line = bytes(buf[:idx]).decode("utf-8")
                del buf[: idx + 1]
                if line.strip():
                    obj = json.loads(line)
                    received_seqs.append(int(obj["seq"]))
        conn.close()
        srv.close()

    t = threading.Thread(target=tcp_receiver, daemon=True)
    t.start()
    ready.wait()
    port = server_port_holder[0]

    padding = "x" * max(0, payload_bytes - 40)
    start = time.perf_counter()
    cli = socket.create_connection(("127.0.0.1", port))
    cli.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    for seq in range(1, count + 1):
        frame = json.dumps({"seq": seq, "pad": padding}) + "\n"
        cli.sendall(frame.encode("utf-8"))
    cli.shutdown(socket.SHUT_WR)
    cli.close()
    t.join(timeout=10.0)
    elapsed_ms = (time.perf_counter() - start) * 1000.0

    out_of_order = sum(
        1 for i in range(1, len(received_seqs)) if received_seqs[i] < received_seqs[i - 1]
    )
    return BenchmarkResult(
        protocol="TCP (SOCK_STREAM)",
        sent=count,
        received=len(received_seqs),
        lost=count - len(received_seqs),
        out_of_order=out_of_order,
        elapsed_ms=elapsed_ms,
    )


def run_udp_benchmark(count: int, payload_bytes: int, simulated_loss: float) -> BenchmarkResult:
    received_seqs: list[int] = []
    ready = threading.Event()
    stop_flag = threading.Event()
    server_port_holder: list[int] = []

    def udp_receiver() -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        srv.bind(("127.0.0.1", 0))
        srv.settimeout(0.25)
        server_port_holder.append(int(srv.getsockname()[1]))
        ready.set()

        while not stop_flag.is_set() or True:
            try:
                data, _ = srv.recvfrom(4096)
            except socket.timeout:
                if stop_flag.is_set():
                    break
                continue
            obj = json.loads(data.decode("utf-8"))
            if obj.get("type") == "END":
                break
            received_seqs.append(int(obj["seq"]))
        srv.close()

    t = threading.Thread(target=udp_receiver, daemon=True)
    t.start()
    ready.wait()
    port = server_port_holder[0]

    padding = "x" * max(0, payload_bytes - 40)
    rng = random.Random(42)
    cli = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    start = time.perf_counter()
    for seq in range(1, count + 1):
        # Optional simulated unreliable network loss before UDP sendto
        if simulated_loss > 0.0 and rng.random() < simulated_loss:
            continue
        datagram = json.dumps({"seq": seq, "pad": padding}).encode("utf-8")
        cli.sendto(datagram, ("127.0.0.1", port))
    # Send sentinel twice in case of loss
    time.sleep(0.02)
    stop_flag.set()
    cli.sendto(b'{"type":"END"}', ("127.0.0.1", port))
    cli.close()
    t.join(timeout=5.0)
    elapsed_ms = (time.perf_counter() - start) * 1000.0

    out_of_order = sum(
        1 for i in range(1, len(received_seqs)) if received_seqs[i] < received_seqs[i - 1]
    )
    return BenchmarkResult(
        protocol=f"UDP (SOCK_DGRAM, loss={simulated_loss*100:.0f}%)",
        sent=count,
        received=len(received_seqs),
        lost=count - len(received_seqs),
        out_of_order=out_of_order,
        elapsed_ms=elapsed_ms,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="TCP vs UDP 100+ Message Comparison")
    parser.add_argument("--count", type=int, default=120, help="Number of numbered messages (>=100)")
    parser.add_argument("--bytes", type=int, default=128, help="Approximate bytes per message")
    parser.add_argument(
        "--udp-loss",
        type=float,
        default=0.05,
        help="Simulated packet drop probability for UDP comparison (0.0 to 1.0)",
    )
    args = parser.parse_args()

    if args.count < 100:
        raise SystemExit("Please specify --count >= 100 messages.")

    results = [
        run_tcp_benchmark(args.count, args.bytes),
        run_udp_benchmark(args.count, args.bytes, 0.0),
        run_udp_benchmark(args.count, args.bytes, args.udp_loss),
    ]

    print("\nConnectly Transport Comparison Benchmark")
    print("=" * 84)
    print(f"{'Protocol':<34} {'Sent':>6} {'Recv':>6} {'Lost':>6} {'Delivery':>10} {'OrderErr':>9} {'Time(ms)':>10}")
    print("-" * 84)
    for r in results:
        print(
            f"{r.protocol:<34} {r.sent:>6} {r.received:>6} {r.lost:>6} "
            f"{r.delivery_pct:>9.2f}% {r.out_of_order:>9} {r.elapsed_ms:>10.2f}"
        )
    print("=" * 84)


if __name__ == "__main__":
    main()
