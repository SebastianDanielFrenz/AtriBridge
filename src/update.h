// Self-update: fetch a small signed manifest from a self-hosted AtriHord server or from a GitHub release,
// download the new exe, verify it, swap it in and start it. Header-only, included once by main.cpp.
//
// Trust: the transport is HTTPS, but the exe is only accepted when its SHA-256 matches the manifest AND the
// manifest's ECDSA P-256 signature over the exe verifies against the public key compiled in (update_pubkey.h).
// A hacked server or release therefore cannot push code. Downgrades are refused.
//
// Manifest (latest.json):  {"version":"1.2.0","url":"ksf-spatial-bridge.exe","size":123,"sha256":"hex","sig":"base64 r||s"}
// "url" may be absolute (https) or relative to the manifest's own address.
#pragma once
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "update_pubkey.h"

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "bcrypt.lib")

namespace upd {

constexpr size_t kMaxManifest = 16 * 1024;
constexpr size_t kMaxExe = 16u * 1024 * 1024;

// ---------------------------------------------------------------- small helpers
inline std::string jfield(const std::string &j, const char *key) {
    std::string k = std::string("\"") + key + "\"";
    size_t p = j.find(k);
    if (p == std::string::npos) return std::string();
    p = j.find(':', p + k.size());
    if (p == std::string::npos) return std::string();
    ++p;
    while (p < j.size() && (j[p] == ' ' || j[p] == '\t' || j[p] == '\n' || j[p] == '\r')) ++p;
    if (p < j.size() && j[p] == '"') {
        size_t e = j.find('"', p + 1);
        return e == std::string::npos ? std::string() : j.substr(p + 1, e - p - 1);
    }
    size_t e = j.find_first_of(",}\n", p);
    return j.substr(p, e == std::string::npos ? std::string::npos : e - p);
}

// "1.10.2" -> compares numerically part by part; returns >0 if a is newer than b.
inline int compare_versions(const std::string &a, const std::string &b) {
    size_t i = 0, j = 0;
    for (int part = 0; part < 4; ++part) {
        long x = 0, y = 0;
        while (i < a.size() && a[i] != '.') { if (a[i] >= '0' && a[i] <= '9') x = x * 10 + (a[i] - '0'); ++i; }
        while (j < b.size() && b[j] != '.') { if (b[j] >= '0' && b[j] <= '9') y = y * 10 + (b[j] - '0'); ++j; }
        if (x != y) return x > y ? 1 : -1;
        if (i < a.size()) ++i;
        if (j < b.size()) ++j;
    }
    return 0;
}

inline std::vector<uint8_t> b64decode(const std::string &s) {
    std::vector<uint8_t> out;
    int val = 0, bits = -8;
    for (unsigned char c : s) {
        int d;
        if (c >= 'A' && c <= 'Z') d = c - 'A';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
        else if (c >= '0' && c <= '9') d = c - '0' + 52;
        else if (c == '+') d = 62;
        else if (c == '/') d = 63;
        else continue;
        val = (val << 6) | d;
        bits += 6;
        if (bits >= 0) { out.push_back((uint8_t)((val >> bits) & 0xff)); bits -= 8; }
    }
    return out;
}

inline std::wstring widen(const std::string &s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
    return w;
}

inline std::string hex(const uint8_t *p, size_t n) {
    static const char *d = "0123456789abcdef";
    std::string s;
    for (size_t i = 0; i < n; ++i) { s += d[p[i] >> 4]; s += d[p[i] & 15]; }
    return s;
}

// ---------------------------------------------------------------- HTTPS GET (WinHTTP, follows redirects)
// Only https:// is accepted. Returns false on any failure or when the body would exceed `limit`.
inline bool https_get(const std::string &url, size_t limit, std::vector<uint8_t> &body, std::string &err) {
    body.clear();
    if (url.rfind("https://", 0) != 0) { err = "not an https address"; return false; }
    std::wstring wurl = widen(url);
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {}, path[2048] = {};
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    uc.dwExtraInfoLength = (DWORD)-1;
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) { err = "bad address"; return false; }
    std::wstring full = std::wstring(path) + std::wstring(uc.lpszExtraInfo ? uc.lpszExtraInfo : L"", uc.dwExtraInfoLength);
    HINTERNET ses = WinHttpOpen(L"ksf-spatial-bridge-updater", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, nullptr, nullptr, 0);
    if (!ses) { err = "network unavailable"; return false; }
    WinHttpSetTimeouts(ses, 8000, 8000, 15000, 30000);
    DWORD redir = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
    WinHttpSetOption(ses, WINHTTP_OPTION_REDIRECT_POLICY, &redir, sizeof(redir));
    bool ok = false;
    HINTERNET con = WinHttpConnect(ses, host, uc.nPort, 0);
    HINTERNET req = con ? WinHttpOpenRequest(con, L"GET", full.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr;
    if (req && WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(req, nullptr)) {
        DWORD code = 0, sz = sizeof(code);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &code, &sz, WINHTTP_NO_HEADER_INDEX);
        if (code != 200) err = "server answered " + std::to_string(code);
        else {
            ok = true;
            for (;;) {
                DWORD avail = 0;
                if (!WinHttpQueryDataAvailable(req, &avail)) { ok = false; err = "download interrupted"; break; }
                if (avail == 0) break;
                if (body.size() + avail > limit) { ok = false; err = "download too large"; break; }
                size_t at = body.size();
                body.resize(at + avail);
                DWORD got = 0;
                if (!WinHttpReadData(req, body.data() + at, avail, &got)) { ok = false; err = "download interrupted"; break; }
                body.resize(at + got);
            }
        }
    } else if (err.empty()) err = "could not reach the server";
    if (req) WinHttpCloseHandle(req);
    if (con) WinHttpCloseHandle(con);
    WinHttpCloseHandle(ses);
    return ok;
}

// ---------------------------------------------------------------- SHA-256 and the ECDSA check (Windows CNG)
inline bool sha256(const uint8_t *data, size_t n, uint8_t out[32]) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE h = nullptr;
    bool ok = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 &&
              BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) == 0 &&
              BCryptHashData(h, const_cast<PUCHAR>(data), (ULONG)n, 0) == 0 &&
              BCryptFinishHash(h, out, 32, 0) == 0;
    if (h) BCryptDestroyHash(h);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

inline bool verify_signature(const uint8_t hash[32], const std::vector<uint8_t> &sig) {
    if (sig.size() != 64) return false;
    uint8_t blob[8 + 64];
    BCRYPT_ECCKEY_BLOB hdr{BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32};
    std::memcpy(blob, &hdr, 8);
    std::memcpy(blob + 8, kUpdateKeyX, 32);
    std::memcpy(blob + 40, kUpdateKeyY, 32);
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_KEY_HANDLE key = nullptr;
    bool ok = BCryptOpenAlgorithmProvider(&alg, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) == 0 &&
              BCryptImportKeyPair(alg, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key, blob, sizeof(blob), 0) == 0 &&
              BCryptVerifySignature(key, nullptr, const_cast<PUCHAR>(hash), 32, const_cast<PUCHAR>(sig.data()), 64, 0) == 0;
    if (key) BCryptDestroyKey(key);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

// ---------------------------------------------------------------- one check
struct Found {
    std::string version;
    std::vector<uint8_t> exe;       // verified
};

// Checks one manifest address. Returns 1 = a newer, verified exe is in `out`; 0 = up to date; -1 = failed (err).
inline int check_source(const std::string &manifest_url, const std::string &current, Found &out, std::string &err) {
    std::vector<uint8_t> m;
    if (!https_get(manifest_url, kMaxManifest, m, err)) return -1;
    std::string j(m.begin(), m.end());
    std::string version = jfield(j, "version"), url = jfield(j, "url"), want = jfield(j, "sha256"), sig = jfield(j, "sig");
    if (version.empty() || url.empty() || want.size() != 64 || sig.empty()) { err = "manifest incomplete"; return -1; }
    if (compare_versions(version, current) <= 0) return 0;
    if (url.rfind("https://", 0) != 0) {
        size_t cut = manifest_url.find_last_of('/');
        url = manifest_url.substr(0, cut + 1) + url;
    }
    std::vector<uint8_t> exe;
    if (!https_get(url, kMaxExe, exe, err)) return -1;
    if (exe.size() < 4096 || exe[0] != 'M' || exe[1] != 'Z') { err = "not a program"; return -1; }
    uint8_t h[32];
    if (!sha256(exe.data(), exe.size(), h)) { err = "hashing failed"; return -1; }
    if (hex(h, 32) != want) { err = "checksum mismatch"; return -1; }
    if (!verify_signature(h, b64decode(sig))) { err = "signature not valid"; return -1; }
    out.version = version;
    out.exe = std::move(exe);
    return 1;
}

// ---------------------------------------------------------------- swap in and restart
// The running exe can be renamed but not overwritten: move it to .old, put the new one in its place, start it
// (it waits for this process to end), the caller then quits. Returns false (and restores) on failure.
inline bool install_and_relaunch(const std::vector<uint8_t> &exe, std::string &err) {
    wchar_t self[MAX_PATH];
    GetModuleFileNameW(nullptr, self, MAX_PATH);
    std::wstring path = self, neu = path + L".new", old = path + L".old";
    HANDLE f = CreateFileW(neu.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) { err = "cannot write next to the program (is it in a protected folder?)"; return false; }
    DWORD wrote = 0;
    bool ok = WriteFile(f, exe.data(), (DWORD)exe.size(), &wrote, nullptr) && wrote == exe.size();
    CloseHandle(f);
    if (!ok) { DeleteFileW(neu.c_str()); err = "cannot write the new program"; return false; }
    DeleteFileW(old.c_str());
    if (!MoveFileExW(path.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING)) { DeleteFileW(neu.c_str()); err = "cannot move the old program aside"; return false; }
    if (!MoveFileExW(neu.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        MoveFileExW(old.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
        err = "cannot put the new program in place";
        return false;
    }
    std::wstring cmd = L"\"" + path + L"\" --after-update " + std::to_wstring(GetCurrentProcessId());
    // keep the user's own options
    std::wstring all = GetCommandLineW();
    size_t sp = all.find(L' ');
    if (sp != std::wstring::npos) cmd += all.substr(sp);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(0);
    if (!CreateProcessW(path.c_str(), buf.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        DeleteFileW(path.c_str());
        MoveFileExW(old.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
        err = "the new program did not start";
        return false;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

// A freshly started copy waits (up to 20 s) for the copy it replaces to end, so the port and the single-instance
// mutex are free. Then the leftover .old file is removed.
inline void wait_for_predecessor(DWORD pid) {
    if (!pid) return;
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (h) { WaitForSingleObject(h, 20000); CloseHandle(h); }
}

inline void remove_old_copy() {
    wchar_t self[MAX_PATH];
    GetModuleFileNameW(nullptr, self, MAX_PATH);
    DeleteFileW((std::wstring(self) + L".old").c_str());
}

}  // namespace upd
