"""Signs a built exe and writes the update files a server or a GitHub release serves.

    python tools/publish.py --exe out/ksf-spatial-bridge.exe --version 1.1.0 --key PATH/update_private.pem --out release/

Writes release/latest.json and release/ksf-spatial-bridge.exe. Put BOTH files in one place:
  * self-hosted AtriHord: web_files/app/spatial-bridge/  (served at /api/public/spatial-bridge/)
  * GitHub: attach both as assets of the release (the app reads releases/latest/download/latest.json)
The version must equal kVersion in src/main.cpp of that build (the app refuses a downgrade)."""
import argparse, base64, hashlib, json, os, shutil, subprocess, sys, tempfile
ap = argparse.ArgumentParser()
ap.add_argument("--exe", required=True); ap.add_argument("--version", required=True)
ap.add_argument("--key", required=True); ap.add_argument("--out", required=True)
a = ap.parse_args()
data = open(a.exe, "rb").read()
with tempfile.TemporaryDirectory() as d:
    sigf = os.path.join(d, "sig.der")
    subprocess.run(["openssl", "dgst", "-sha256", "-sign", a.key, "-out", sigf, a.exe], check=True)
    der = open(sigf, "rb").read()
def ints(der):                       # DER SEQUENCE { INTEGER r, INTEGER s }  ->  r||s, 32 bytes each
    assert der[0] == 0x30
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7f)
    out = []
    for _ in range(2):
        assert der[i] == 2
        n = der[i + 1]; v = der[i + 2:i + 2 + n]; i += 2 + n
        out.append(v.lstrip(b"\0").rjust(32, b"\0"))
    return b"".join(out)
sig = ints(der); assert len(sig) == 64
os.makedirs(a.out, exist_ok=True)
name = "ksf-spatial-bridge.exe"
shutil.copyfile(a.exe, os.path.join(a.out, name))
json.dump({"version": a.version, "url": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
           "sig": base64.b64encode(sig).decode()}, open(os.path.join(a.out, "latest.json"), "w"), indent=1)
print("published", a.version, len(data), "bytes ->", a.out)
