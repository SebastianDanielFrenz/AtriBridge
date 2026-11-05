"""Drives ksf-spatial-bridge --null: handshake, hello, 3 s of a stereo sine at 44100 Hz, a mode change.
   python tools/ws_test.py [port]  - prints the app's replies; watch the app's console for rms/underruns."""
import base64, math, os, socket, struct, sys, time, json
port = int(sys.argv[1]) if len(sys.argv) > 1 else 47321
s = socket.create_connection(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://media-dl.ksfhost.de\r\n\r\n").encode())
resp = b""
while b"\r\n\r\n" not in resp:
    resp += s.recv(1)
print(resp.decode().splitlines()[0])
import hashlib
exp = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
assert exp in resp.decode(), "bad accept key"

def frame(op, payload):
    mask = os.urandom(4)
    n = len(payload)
    head = bytes([0x80 | op])
    if n < 126: head += bytes([0x80 | n])
    elif n < 65536: head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else: head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    return head + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(payload))

def read_frame():
    h = s.recv(2)
    n = h[1] & 0x7f
    if n == 126: n = struct.unpack(">H", s.recv(2))[0]
    return h[0] & 15, s.recv(n)

s.sendall(frame(1, json.dumps({"type": "hello", "rate": 44100, "mode": "all", "heights": False}).encode()))
s.settimeout(2)
print("reply:", read_frame())
rate, t = 44100, 0
start = time.time()
sent = 0
while time.time() - start < 3:
    blk = bytearray()
    for i in range(1024):
        v = 0.5 * math.sin(2 * math.pi * 440 * (t + i) / rate)
        blk += struct.pack("<ff", v, 0.0)
    t += 1024; sent += 1024
    s.sendall(frame(2, bytes(blk)))
    due = start + sent / rate
    time.sleep(max(0, due - time.time()))
s.sendall(frame(1, json.dumps({"type": "mode", "mode": "stereo", "heights": True}).encode()))
time.sleep(0.5)
s.sendall(frame(8, b""))
print("done, sent", sent, "frames")
