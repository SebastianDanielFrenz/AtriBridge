// KSF Spatial Bridge - plays the stereo the media-dl music page sends it through Windows Spatial
// Sound, so a Dolby Atmos / DTS:X / Windows Sonic device gets its ear-level AND height speakers
// (a browser is only given the 7.1 bed). Windows only.
//
//   page --(ws://127.0.0.1:47321, float32 stereo)--> this app --(ISpatialAudioClient)--> speakers
//
// Messages from the page (text frames, JSON): {"type":"hello"|"mode","rate":44100,
// "mode":"all"|"stereo","heights":true|false}. Binary frames are interleaved float32 stereo at
// "rate". The browser extension instead sends {"type":"hello","rate":48000,"speakers":"FL,FR,FC,SL,SR,TFL,TFR"}:
// the binary frames then carry one channel per listed speaker (names FL FR FC SL SR BL BR FWL FWR TFL TFR
// TML TMR TBL TBR, up to 16) and each channel plays on its own speaker, as a static bed object where
// Windows offers one, else as a dynamic (positioned) object, else folded into the nearest bed speaker. The app answers {"type":"info","device":...,"bed":"7.1.4","heights":true} once Windows
// Spatial Sound works on the default output, and {"type":"gone"} when it stops working.
//
// "all" plays every ear-level speaker at the same level (the left-side speakers get L, the right
// ones R, the centre (L+R)/2); heights adds the height speakers the same way. "stereo" is the
// front pair only. The LFE stays silent.
//
// Command line: --port N, --origin URL (extra allowed page origin), --null (no audio output: only
// receives and measures, for tests; needs a console), --help.
// No dependencies beyond the Windows SDK. MIT licence (see LICENSE).

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <spatialaudioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "update.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr int kOutRate = 48000;
constexpr size_t kRingFrames = kOutRate;          // 1 s
constexpr size_t kMaxQueued = kOutRate / 4;       // above 250 ms: drop to the target (clock drift)
constexpr size_t kTargetQueued = kOutRate / 10;   // 100 ms
constexpr size_t kPrime = kOutRate * 6 / 100;     // start playing once 60 ms are queued

// ---------------------------------------------------------------- speakers
constexpr int kMaxCh = 16;
constexpr int kMaxDyn = 16;
enum Spk { S_FL, S_FR, S_FC, S_SL, S_SR, S_BL, S_BR, S_FWL, S_FWR, S_TFL, S_TFR, S_TML, S_TMR, S_TBL, S_TBR, S_COUNT };
struct SpkInfo {
    const char *name;
    AudioObjectType st;     // the static bed object Windows has for it (None: only as a dynamic object)
    float az, el;           // degrees: azimuth (+ right of front), elevation, for a dynamic object
    int fold[3];            // where its channel goes when it gets neither (first static one present); -1 ends
};
const SpkInfo kSpk[S_COUNT] = {
    {"FL", AudioObjectType_FrontLeft, -30, 0, {-1, -1, -1}},
    {"FR", AudioObjectType_FrontRight, 30, 0, {-1, -1, -1}},
    {"FC", AudioObjectType_FrontCenter, 0, 0, {S_FL, -1, -1}},
    {"SL", AudioObjectType_SideLeft, -90, 0, {S_BL, S_FL, -1}},
    {"SR", AudioObjectType_SideRight, 90, 0, {S_BR, S_FR, -1}},
    {"BL", AudioObjectType_BackLeft, -150, 0, {S_SL, S_FL, -1}},
    {"BR", AudioObjectType_BackRight, 150, 0, {S_SR, S_FR, -1}},
    {"FWL", AudioObjectType_None, -60, 0, {S_FL, -1, -1}},
    {"FWR", AudioObjectType_None, 60, 0, {S_FR, -1, -1}},
    {"TFL", AudioObjectType_TopFrontLeft, -45, 45, {S_FL, -1, -1}},
    {"TFR", AudioObjectType_TopFrontRight, 45, 45, {S_FR, -1, -1}},
    {"TML", AudioObjectType_None, -90, 50, {S_TFL, S_TBL, S_FL}},
    {"TMR", AudioObjectType_None, 90, 50, {S_TFR, S_TBR, S_FR}},
    {"TBL", AudioObjectType_TopBackLeft, -135, 45, {S_TFL, S_BL, S_FL}},
    {"TBR", AudioObjectType_TopBackRight, 135, 45, {S_TFR, S_BR, S_FR}},
};

int speaker_index(const std::string &name) {
    for (int i = 0; i < S_COUNT; ++i) if (name == kSpk[i].name) return i;
    return -1;
}

// ---------------------------------------------------------------- state shared by the threads
struct Settings {
    std::atomic<bool> all{true};
    std::atomic<bool> heights{false};
} g_set;

std::atomic<bool> g_quit{false};
std::atomic<bool> g_null{false};
constexpr const char *kVersion = "1.2.0";      // must equal --version given to tools/publish.py for this build
// Where updates come from when nothing else is configured. Replace with your own server or GitHub repository
// (--update-url / --update-github / spatial-bridge.conf).
constexpr const char *kDefaultUpdateSource = "https://media-dl.ksfhost.de/api/public/spatial-bridge/latest.json";
std::vector<std::string> g_update_sources;      // manifest addresses, tried in order
std::atomic<bool> g_auto_update{true};
HANDLE g_update_now = nullptr;                  // event: "check now" (tray menu)
HWND g_hwnd = nullptr;
std::atomic<bool> g_normal_priority{false};     // --normal-priority: leave scheduling alone

// The audio thread feeds a device that wants a buffer every few milliseconds; if a game or a render job keeps
// the cores busy, a normally scheduled thread is late and the sound crackles. Register it with the Multimedia
// Class Scheduler ("Pro Audio" is the highest class a normal user may use, "Audio" the fallback) and ask for
// critical priority inside it. Without MMCSS the thread priority alone is raised.
void boost_audio_thread() {
    if (g_normal_priority) return;
    DWORD task = 0;
    HANDLE h = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    if (!h) { task = 0; h = AvSetMmThreadCharacteristicsW(L"Audio", &task); }
    if (h) AvSetMmThreadPriority(h, AVRT_PRIORITY_CRITICAL);
    else SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
}

// The network thread hands the audio thread its samples: it must not wait behind ordinary work either.
void boost_net_thread() {
    if (!g_normal_priority) SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
}
std::atomic<int> g_client_rate{kOutRate};
std::atomic<bool> g_client_connected{false};

std::mutex g_mu;                       // ring, status text
std::vector<float> g_ring(kRingFrames * kMaxCh, 0.0f);   // frames of g_ring_ch channels, kMaxCh apart
size_t g_rd = 0, g_count = 0;          // read index (frames), queued frames
int g_ring_ch = 2;                     // channels per frame of what is queued
std::vector<int> g_layout;             // speaker per channel; empty = the page's stereo ("all"/"stereo" modes)
std::atomic<int> g_layout_version{0};
int g_dyn_max = 0, g_static_n = 0;     // what the device offers (for the info message)
std::string g_status = "Starting";
std::string g_device;
std::string g_bed;
bool g_has_heights = false;
bool g_spatial_ok = false;
std::atomic<uint64_t> g_frames_in{0}, g_underruns{0};

// info changes the net thread must announce
std::atomic<int> g_info_version{0};

void set_status(const std::string &s) {
    std::lock_guard<std::mutex> lock(g_mu);
    g_status = s;
}

// ---------------------------------------------------------------- SHA-1 and base64 (the WebSocket handshake)
struct Sha1 {
    uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
    uint8_t buf[64];
    size_t n = 0;
    uint64_t total = 0;
    static uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }
    void block(const uint8_t *p) {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i) w[i] = (uint32_t)p[i * 4] << 24 | (uint32_t)p[i * 4 + 1] << 16 | (uint32_t)p[i * 4 + 2] << 8 | p[i * 4 + 3];
        for (int i = 16; i < 80; ++i) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999u; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
            uint32_t t = rol(a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol(b, 30); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    void add(const void *data, size_t len) {
        auto p = static_cast<const uint8_t *>(data);
        total += len;
        while (len) {
            size_t take = std::min(len, sizeof(buf) - n);
            std::memcpy(buf + n, p, take);
            n += take; p += take; len -= take;
            if (n == 64) { block(buf); n = 0; }
        }
    }
    void finish(uint8_t out[20]) {
        uint64_t bits = total * 8;
        uint8_t pad = 0x80;
        add(&pad, 1);
        uint8_t zero = 0;
        while (n != 56) add(&zero, 1);
        uint8_t len[8];
        for (int i = 0; i < 8; ++i) len[i] = (uint8_t)(bits >> (56 - 8 * i));
        add(len, 8);
        for (int i = 0; i < 5; ++i) { out[i * 4] = (uint8_t)(h[i] >> 24); out[i * 4 + 1] = (uint8_t)(h[i] >> 16); out[i * 4 + 2] = (uint8_t)(h[i] >> 8); out[i * 4 + 3] = (uint8_t)h[i]; }
    }
};

std::string base64(const uint8_t *d, size_t n) {
    static const char *t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = d[i] << 16 | (i + 1 < n ? d[i + 1] << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
        o += t[v >> 18 & 63]; o += t[v >> 12 & 63];
        o += i + 1 < n ? t[v >> 6 & 63] : '='; o += i + 2 < n ? t[v & 63] : '=';
    }
    return o;
}

std::string accept_key(const std::string &key) {
    Sha1 s;
    s.add(key.data(), key.size());
    static const char guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    s.add(guid, sizeof(guid) - 1);
    uint8_t d[20];
    s.finish(d);
    return base64(d, 20);
}

// ---------------------------------------------------------------- tiny JSON field reader (flat objects we control)
std::string json_str(const std::string &j, const char *key) {
    std::string k = std::string("\"") + key + "\"";
    size_t p = j.find(k);
    if (p == std::string::npos) return {};
    p = j.find(':', p + k.size());
    if (p == std::string::npos) return {};
    ++p;
    while (p < j.size() && (j[p] == ' ' || j[p] == '\t')) ++p;
    if (p < j.size() && j[p] == '"') {
        size_t e = j.find('"', p + 1);
        return e == std::string::npos ? std::string() : j.substr(p + 1, e - p - 1);
    }
    size_t e = j.find_first_of(",}", p);
    return j.substr(p, e == std::string::npos ? std::string::npos : e - p);
}

std::string json_escape(const std::string &s) {
    std::string o;
    for (char c : s) { if (c == '"' || c == '\\') o += '\\'; if ((unsigned char)c >= 32) o += c; }
    return o;
}

// ---------------------------------------------------------------- the ring and the resampler
// Input arrives at the client's rate; the ring holds 48 kHz frames of `nch` channels. Linear interpolation,
// streaming: `inbuf` keeps the not-yet-consumed input frames, `pos` is the fractional read position in it.
struct Resampler {
    std::vector<float> inbuf;
    double pos = 0.0;
    int nch = 2;
    void reset() { inbuf.clear(); pos = 0.0; }
    void push(const float *frames, size_t n, int rate) {
        std::lock_guard<std::mutex> lock(g_mu);
        if (nch != g_ring_ch) return;                    // frames of a layout that is no longer the ring's
        auto put = [&](const float *fr) {
            if (g_count >= kRingFrames) return;
            size_t w = (g_rd + g_count) % kRingFrames;
            for (int c = 0; c < nch; ++c) g_ring[w * kMaxCh + c] = fr[c];
            ++g_count;
        };
        if (rate == kOutRate) {
            for (size_t i = 0; i < n; ++i) put(frames + i * nch);
        } else {
            inbuf.insert(inbuf.end(), frames, frames + n * nch);
            const double step = (double)rate / kOutRate;
            const size_t have = inbuf.size() / nch;
            float tmp[kMaxCh];
            while (pos + 1.0 < (double)have) {
                size_t i = (size_t)pos;
                float f = (float)(pos - (double)i);
                for (int c = 0; c < nch; ++c) tmp[c] = inbuf[i * nch + c] + (inbuf[(i + 1) * nch + c] - inbuf[i * nch + c]) * f;
                put(tmp);
                pos += step;
            }
            size_t drop = (size_t)pos;
            if (drop > 0) {
                inbuf.erase(inbuf.begin(), inbuf.begin() + (std::ptrdiff_t)(drop * nch));
                pos -= (double)drop;
            }
        }
        if (g_count > kMaxQueued) {                      // the client's clock runs faster: skip ahead
            size_t cut = g_count - kTargetQueued;
            g_rd = (g_rd + cut) % kRingFrames;
            g_count -= cut;
        }
    }
};

// Pulls up to `frames` interleaved frames of `nch` channels into `out` (zero beyond what it got); returns how
// many it got. A ring that holds another channel count (a client just changed layout) yields nothing.
size_t ring_pull(float *out, int nch, size_t frames, bool &primed) {
    std::lock_guard<std::mutex> lock(g_mu);
    std::fill(out, out + frames * (size_t)nch, 0.0f);
    if (nch != g_ring_ch) return 0;
    if (!primed && g_count >= kPrime) primed = true;
    if (!primed) return 0;
    size_t got = std::min(frames, g_count);
    for (size_t i = 0; i < got; ++i) {
        size_t k = (g_rd + i) % kRingFrames;
        for (int c = 0; c < nch; ++c) out[i * nch + c] = g_ring[k * kMaxCh + c];
    }
    g_rd = (g_rd + got) % kRingFrames;
    g_count -= got;
    if (got < frames) { primed = false; g_underruns++; }
    return got;
}

// ---------------------------------------------------------------- the WebSocket server
bool origin_allowed(const std::string &origin, const std::vector<std::string> &extra) {
    if (origin.empty()) return true;                       // not a browser
    static const char *ok[] = {"https://media-dl.ksfhost.de", "https://music.ksfhost.de", "http://localhost", "http://127.0.0.1", "https://localhost"};
    for (const char *o : ok) if (origin.rfind(o, 0) == 0) return true;
    // The browser extension connects from its own origin (the id differs per install and browser). A web page
    // cannot present one, so only an installed extension can.
    if (origin.rfind("chrome-extension://", 0) == 0 || origin.rfind("moz-extension://", 0) == 0) return true;
    for (const auto &o : extra) if (origin == o) return true;
    return false;
}

bool send_all(SOCKET s, const void *d, int n) {
    auto p = static_cast<const char *>(d);
    while (n > 0) { int k = send(s, p, n, 0); if (k <= 0) return false; p += k; n -= k; }
    return true;
}

bool send_frame(SOCKET s, uint8_t opcode, const std::string &payload) {
    std::string f;
    f += (char)(0x80 | opcode);
    if (payload.size() < 126) f += (char)payload.size();
    else if (payload.size() < 65536) { f += (char)126; f += (char)(payload.size() >> 8); f += (char)payload.size(); }
    else { f += (char)127; for (int i = 7; i >= 0; --i) f += (char)((uint64_t)payload.size() >> (8 * i)); }
    f += payload;
    return send_all(s, f.data(), (int)f.size());
}

bool recv_exact(SOCKET s, void *d, size_t n, const std::atomic<bool> &stop) {
    auto p = static_cast<char *>(d);
    while (n > 0) {
        int k = recv(s, p, (int)n, 0);
        if (k == 0) return false;
        if (k < 0) {
            int e = WSAGetLastError();
            if (e == WSAETIMEDOUT && !stop && !g_quit) continue;
            return false;
        }
        p += k; n -= k;
    }
    return true;
}

std::string info_json() {
    std::lock_guard<std::mutex> lock(g_mu);
    return "{\"type\":\"info\",\"version\":\"" + std::string(kVersion) + "\",\"device\":\"" + json_escape(g_device) + "\",\"bed\":\"" + g_bed + "\",\"heights\":" + (g_has_heights ? "true" : "false") +
           ",\"objects\":" + std::to_string(g_static_n + g_dyn_max) + ",\"dynamic\":" + std::to_string(g_dyn_max) + "}";
}

// Returns the channel count the following binary frames carry (2 unless a layout was announced).
void handle_message(const std::string &text, int &nch) {
    std::string type = json_str(text, "type");
    std::string speakers = json_str(text, "speakers");
    if (type == "hello" || !speakers.empty()) {
        std::vector<int> layout;
        size_t p = 0;
        while (!speakers.empty() && p <= speakers.size() && (int)layout.size() < kMaxCh) {
            size_t e = speakers.find(',', p);
            std::string name = speakers.substr(p, e == std::string::npos ? std::string::npos : e - p);
            int idx = speaker_index(name);
            if (idx < 0) { layout.clear(); break; }
            layout.push_back(idx);
            if (e == std::string::npos) break;
            p = e + 1;
        }
        std::lock_guard<std::mutex> lock(g_mu);
        if (layout != g_layout || (layout.empty() ? 2 : (int)layout.size()) != g_ring_ch) {
            g_layout = layout;
            g_ring_ch = layout.empty() ? 2 : (int)layout.size();
            g_count = 0;
            g_layout_version++;
        }
        nch = g_ring_ch;
    }
    std::string rate = json_str(text, "rate");
    if (!rate.empty()) {
        int r = std::atoi(rate.c_str());
        if (r >= 8000 && r <= 192000) g_client_rate = r;
    }
    std::string mode = json_str(text, "mode");
    if (!mode.empty()) g_set.all = mode != "stereo";
    std::string hg = json_str(text, "heights");
    if (!hg.empty()) g_set.heights = hg == "true";
}

void serve_client(SOCKET c, const std::vector<std::string> &extra_origins) {
    DWORD to = 500;
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char *)&to, sizeof(to));
    BOOL nodelay = TRUE;
    setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));
    std::atomic<bool> never{false};
    // ---- handshake
    std::string req;
    char ch;
    while (req.size() < 8192 && req.find("\r\n\r\n") == std::string::npos) {
        if (!recv_exact(c, &ch, 1, never)) return;
        req += ch;
    }
    auto header = [&](const char *name) {
        std::string low = req, key = std::string("\r\n") + name + ":";
        std::transform(low.begin(), low.end(), low.begin(), [](unsigned char x) { return (char)std::tolower(x); });
        std::string lk = key;
        std::transform(lk.begin(), lk.end(), lk.begin(), [](unsigned char x) { return (char)std::tolower(x); });
        size_t p = low.find(lk);
        if (p == std::string::npos) return std::string();
        p += lk.size();
        size_t e = req.find("\r\n", p);
        std::string v = req.substr(p, e - p);
        size_t a = v.find_first_not_of(" \t");
        return a == std::string::npos ? std::string() : v.substr(a);
    };
    std::string key = header("Sec-WebSocket-Key");
    if (key.empty() || !origin_allowed(header("Origin"), extra_origins)) {
        const char *no = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        send_all(c, no, (int)std::strlen(no));
        return;
    }
    std::string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept_key(key) + "\r\n\r\n";
    if (!send_all(c, resp.data(), (int)resp.size())) return;
    g_client_connected = true;
    Resampler rs;
    int nch = 2;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        g_count = 0;
        g_ring_ch = 2;
        if (!g_layout.empty()) { g_layout.clear(); g_layout_version++; }
    }
    int announced = -1;
    std::string message;
    uint8_t message_op = 0;
    // The reader must also announce info changes; a short timeout on recv lets it look.
    for (;;) {
        if (g_quit) break;
        int v = g_info_version;
        if (v != announced) {
            announced = v;
            bool ok;
            { std::lock_guard<std::mutex> lock(g_mu); ok = g_spatial_ok || g_null; }
            if (!send_frame(c, 1, ok ? info_json() : std::string("{\"type\":\"gone\"}"))) break;
        }
        uint8_t h[2];
        int k = recv(c, (char *)h, 1, 0);
        if (k == 0) break;
        if (k < 0) { if (WSAGetLastError() == WSAETIMEDOUT) continue; break; }
        if (!recv_exact(c, h + 1, 1, never)) break;
        bool fin = h[0] & 0x80;
        uint8_t op = h[0] & 0x0f;
        bool masked = h[1] & 0x80;
        uint64_t len = h[1] & 0x7f;
        if (len == 126) { uint8_t e[2]; if (!recv_exact(c, e, 2, never)) break; len = (uint64_t)e[0] << 8 | e[1]; }
        else if (len == 127) { uint8_t e[8]; if (!recv_exact(c, e, 8, never)) break; len = 0; for (int i = 0; i < 8; ++i) len = len << 8 | e[i]; }
        if (len > (1u << 22)) break;
        uint8_t mask[4] = {0, 0, 0, 0};
        if (masked && !recv_exact(c, mask, 4, never)) break;
        std::string payload((size_t)len, '\0');
        if (len && !recv_exact(c, payload.data(), (size_t)len, never)) break;
        if (masked) for (size_t i = 0; i < payload.size(); ++i) payload[i] ^= mask[i & 3];
        if (op == 8) { send_frame(c, 8, std::string()); break; }
        if (op == 9) { if (!send_frame(c, 10, payload)) break; continue; }
        if (op == 10) continue;
        if (op == 0) message += payload; else { message = payload; message_op = op; }
        if (!fin) continue;
        if (message_op == 1) { handle_message(message, nch); rs.nch = nch; rs.reset(); }
        else if (message_op == 2 && message.size() >= 4 * (size_t)nch) {
            size_t frames = message.size() / (4 * (size_t)nch);
            rs.push(reinterpret_cast<const float *>(message.data()), frames, g_client_rate);
            g_frames_in += frames;
        }
        message.clear();
    }
    g_client_connected = false;
    std::lock_guard<std::mutex> lock(g_mu);
    g_count = 0;
}

void net_thread(int port, std::vector<std::string> extra_origins) {
    boost_net_thread();
    SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);          // this machine only
    BOOL yes = TRUE;
    setsockopt(ls, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof(yes));
    if (bind(ls, (sockaddr *)&a, sizeof(a)) != 0 || listen(ls, 4) != 0) {
        set_status("Port " + std::to_string(port) + " is taken - is the app already running?");
        return;
    }
    DWORD to = 300;
    setsockopt(ls, SOL_SOCKET, SO_RCVTIMEO, (const char *)&to, sizeof(to));
    std::vector<std::thread> clients;
    std::atomic<SOCKET> current{INVALID_SOCKET};
    while (!g_quit) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(ls, &fds);
        timeval tv{0, 300000};
        if (select(0, &fds, nullptr, nullptr, &tv) <= 0) continue;
        SOCKET c = accept(ls, nullptr, nullptr);
        if (c == INVALID_SOCKET) continue;
        SOCKET old = current.exchange(c);                   // a new page replaces the old connection
        if (old != INVALID_SOCKET) shutdown(old, SD_BOTH);
        clients.emplace_back([c, &extra_origins, &current] {
            serve_client(c, extra_origins);
            SOCKET expect = c;
            current.compare_exchange_strong(expect, INVALID_SOCKET);
            closesocket(c);
        });
        // forget finished threads lazily: keep the list short
        if (clients.size() > 16) { for (auto &t : clients) if (t.joinable()) t.join(); clients.clear(); }
    }
    SOCKET cur = current.exchange(INVALID_SOCKET);
    if (cur != INVALID_SOCKET) shutdown(cur, SD_BOTH);
    for (auto &t : clients) if (t.joinable()) t.join();
    closesocket(ls);
}

// ---------------------------------------------------------------- Windows Spatial Sound
// What each object plays: a weighted sum of input channels.
struct Route {
    int n = 0;
    int ch[6]{};
    float g[6]{};
    void add(int c, float gain) { if (n < 6) { ch[n] = c; g[n] = gain; ++n; } }
};

struct Plan {
    Route st[S_COUNT];              // static bed objects, by speaker
    Route dyn[kMaxDyn];             // dynamic objects
    int dyn_spk[kMaxDyn]{};
    int ndyn = 0;
    int nch = 2;
};

// layout empty: the music page's stereo ("all": every ear-level speaker gets its side, heights optional).
void build_plan(Plan &p, unsigned native, int max_dyn, const std::vector<int> &layout, bool all, bool heights) {
    p = Plan();
    auto has = [&](int s) { return kSpk[s].st != AudioObjectType_None && (native & kSpk[s].st) != 0; };
    if (layout.empty()) {
        p.nch = 2;
        for (int s = 0; s < S_COUNT; ++s) {
            if (!has(s)) continue;
            const bool left = s == S_FL || s == S_SL || s == S_BL || s == S_TFL || s == S_TBL;
            const bool height = s == S_TFL || s == S_TFR || s == S_TBL || s == S_TBR;
            const bool front = s == S_FL || s == S_FR;
            if (!(front || (all && (!height || heights)))) continue;
            if (s == S_FC) { p.st[s].add(0, 0.5f); p.st[s].add(1, 0.5f); }
            else p.st[s].add(left ? 0 : 1, 1.0f);
        }
        return;
    }
    p.nch = (int)layout.size();
    for (int c = 0; c < p.nch; ++c) {
        const int s = layout[c];
        if (has(s)) { p.st[s].add(c, 1.0f); continue; }
        if (p.ndyn < max_dyn) { p.dyn[p.ndyn].add(c, 1.0f); p.dyn_spk[p.ndyn++] = s; continue; }
        for (int t : kSpk[s].fold) if (t >= 0 && has(t)) { p.st[t].add(c, 1.0f); break; }
    }
}

void mix_route(const Route &r, const float *in, int nch, UINT32 frames, float *out) {
    for (UINT32 f = 0; f < frames; ++f) {
        float v = 0.0f;
        for (int k = 0; k < r.n; ++k) v += in[(size_t)f * nch + r.ch[k]] * r.g[k];
        out[f] = v;
    }
}

std::string bed_label(unsigned mask) {
    bool side = mask & (AudioObjectType_SideLeft | AudioObjectType_SideRight);
    bool back = mask & (AudioObjectType_BackLeft | AudioObjectType_BackRight);
    int tops = 0;
    for (auto t : {AudioObjectType_TopFrontLeft, AudioObjectType_TopFrontRight, AudioObjectType_TopBackLeft, AudioObjectType_TopBackRight})
        if (mask & t) ++tops;
    std::string s = (side && back) ? "7.1" : (side || back) ? "5.1" : "2.1";
    if (tops) s += "." + std::to_string(tops);
    return s;
}

// One activation of the spatial stream on the default output; returns when it fails or on quit.
// Returns false if the device offers no spatial audio at all (the caller waits and retries).
bool run_spatial_once() {
    HRESULT hr = S_OK;
    ComPtr<IMMDeviceEnumerator> en;
    ComPtr<IMMDevice> dev;
    ComPtr<ISpatialAudioClient> client;
    ComPtr<ISpatialAudioObjectRenderStream> stream;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eMultimedia, &dev);
    if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(ISpatialAudioClient), CLSCTX_INPROC_SERVER, nullptr, reinterpret_cast<void **>(client.GetAddressOf()));
    if (FAILED(hr)) { set_status("The default output has no Windows Spatial Sound"); return false; }
    AudioObjectType native = AudioObjectType_None;
    hr = client->GetNativeStaticObjectTypeMask(&native);
    if (FAILED(hr)) return false;
    std::string name = "default output";
    {
        ComPtr<IPropertyStore> ps;
        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &ps))) {
            PROPVARIANT v{};
            if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) {
                char u[512]{};
                WideCharToMultiByte(CP_UTF8, 0, v.pwszVal, -1, u, sizeof(u), nullptr, nullptr);
                name = u;
            }
            PropVariantClear(&v);
        }
    }
    WAVEFORMATEX fmt{};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = 1;
    fmt.nSamplesPerSec = kOutRate;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = 4;
    fmt.nAvgBytesPerSec = kOutRate * 4;
    if (FAILED(client->IsAudioObjectFormatSupported(&fmt))) return false;
    unsigned want = 0;
    int static_n = 0;
    for (const SpkInfo &b : kSpk) if (b.st != AudioObjectType_None && (native & b.st)) { want |= b.st; ++static_n; }
    if (!(want & (AudioObjectType_FrontLeft | AudioObjectType_FrontRight))) { set_status("This output has no front speakers in Spatial Sound"); return false; }
    HANDLE ev = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    SpatialAudioObjectRenderStreamActivationParams p{};
    p.ObjectFormat = &fmt;
    p.StaticObjectTypeMask = static_cast<AudioObjectType>(want);
    UINT32 max_dyn = 0;
    if (SUCCEEDED(client->GetMaxDynamicObjectCount(&max_dyn))) max_dyn = std::min<UINT32>(max_dyn, kMaxDyn);
    else max_dyn = 0;
    for (int attempt = 0; attempt < 2; ++attempt) {
        p.MinDynamicObjectCount = 0;
        p.MaxDynamicObjectCount = max_dyn;
        p.Category = AudioCategory_Media;
        p.EventHandle = ev;
        PROPVARIANT act{};
        act.vt = VT_BLOB;
        act.blob.cbSize = sizeof(p);
        act.blob.pBlobData = reinterpret_cast<BYTE *>(&p);
        stream.Reset();
        hr = client->ActivateSpatialAudioStream(&act, __uuidof(ISpatialAudioObjectRenderStream), reinterpret_cast<void **>(stream.GetAddressOf()));
        if (FAILED(hr) && max_dyn > 0) { max_dyn = 0; continue; }       // no dynamic objects: statics only
        break;
    }
    if (SUCCEEDED(hr)) hr = stream->Start();
    if (FAILED(hr)) { CloseHandle(ev); set_status("Spatial Sound did not start (is it switched on for this device in Windows Sound settings?)"); return false; }

    ComPtr<ISpatialAudioObject> st_objs[S_COUNT];
    ComPtr<ISpatialAudioObject> dyn_objs[kMaxDyn];
    int dyn_last_spk[kMaxDyn];
    for (int &v : dyn_last_spk) v = -1;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        g_device = name;
        g_bed = bed_label(want);
        g_has_heights = (want & (AudioObjectType_TopFrontLeft | AudioObjectType_TopFrontRight | AudioObjectType_TopBackLeft | AudioObjectType_TopBackRight)) != 0;
        g_spatial_ok = true;
        g_dyn_max = (int)max_dyn;
        g_static_n = static_n;
        g_status = "Playing through " + name + " (" + g_bed + ")";
    }
    g_info_version++;
    bool primed = false;
    std::vector<float> in;
    Plan plan;
    int plan_version = -1;
    bool plan_all = true, plan_heights = false;
    while (!g_quit) {
        if (WaitForSingleObject(ev, 300) != WAIT_OBJECT_0) {
            if (g_quit) break;
            hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
            break;
        }
        UINT32 avail = 0, frames = 0;
        hr = stream->BeginUpdatingAudioObjects(&avail, &frames);
        if (FAILED(hr)) break;
        const bool all = g_set.all, heights = g_set.heights;
        const int ver = g_layout_version;
        if (ver != plan_version || all != plan_all || heights != plan_heights) {
            std::vector<int> layout;
            { std::lock_guard<std::mutex> lock(g_mu); layout = g_layout; }
            build_plan(plan, want, (int)max_dyn, layout, all, heights);
            plan_version = ver; plan_all = all; plan_heights = heights;
        }
        in.assign((size_t)frames * plan.nch, 0.0f);
        ring_pull(in.data(), plan.nch, frames, primed);
        for (int si = 0; si < S_COUNT && SUCCEEDED(hr); ++si) {
            const SpkInfo &b = kSpk[si];
            if (b.st == AudioObjectType_None || !(want & b.st)) continue;
            if (!st_objs[si]) hr = stream->ActivateSpatialAudioObject(b.st, &st_objs[si]);
            if (FAILED(hr)) break;
            BYTE *buf = nullptr;
            UINT32 bytes = 0;
            hr = st_objs[si]->GetBuffer(&buf, &bytes);
            if (FAILED(hr)) break;
            float *out = reinterpret_cast<float *>(buf);
            UINT32 n = std::min<UINT32>(frames, bytes / 4);
            mix_route(plan.st[si], in.data(), plan.nch, n, out);
        }
        for (int di = 0; di < (int)max_dyn && SUCCEEDED(hr); ++di) {
            const bool used = di < plan.ndyn;
            if (!dyn_objs[di]) {
                if (!used) continue;
                HRESULT ha = stream->ActivateSpatialAudioObject(AudioObjectType_Dynamic, &dyn_objs[di]);
                if (FAILED(ha)) { dyn_objs[di].Reset(); continue; }      // fewer objects than reported: that channel is dropped
            }
            BYTE *buf = nullptr;
            UINT32 bytes = 0;
            HRESULT hb = dyn_objs[di]->GetBuffer(&buf, &bytes);
            if (FAILED(hb)) { hr = hb; break; }
            float *out = reinterpret_cast<float *>(buf);
            UINT32 n = std::min<UINT32>(frames, bytes / 4);
            if (!used) { std::fill(out, out + n, 0.0f); continue; }
            if (dyn_last_spk[di] != plan.dyn_spk[di]) {
                const SpkInfo &sp = kSpk[plan.dyn_spk[di]];
                const float r = 2.0f, az = sp.az * 0.01745329252f, el = sp.el * 0.01745329252f;
                dyn_objs[di]->SetPosition(r * std::cos(el) * std::sin(az), r * std::sin(el), -r * std::cos(el) * std::cos(az));
                dyn_objs[di]->SetVolume(1.0f);
                dyn_last_spk[di] = plan.dyn_spk[di];
            }
            mix_route(plan.dyn[di], in.data(), plan.nch, n, out);
        }
        HRESULT end = stream->EndUpdatingAudioObjects();
        if (SUCCEEDED(hr)) hr = end;
        if (FAILED(hr)) break;
    }
    stream->Stop();
    stream->Reset();
    CloseHandle(ev);
    {
        std::lock_guard<std::mutex> lock(g_mu);
        g_spatial_ok = false;
    }
    g_info_version++;
    if (!g_quit) set_status("Audio device changed or lost - reconnecting");
    return true;
}

void audio_thread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    boost_audio_thread();
    while (!g_quit) {
        if (g_null) {                                        // test mode: drain and measure
            {
                std::lock_guard<std::mutex> lock(g_mu);
                g_spatial_ok = true;
                g_device = "null";
                g_bed = "7.1.4";
                g_has_heights = true;
                g_dyn_max = 12;
                g_static_n = 11;
                g_status = "Test mode (no audio output)";
            }
            g_info_version++;
            bool primed = false;
            std::vector<float> in(480 * kMaxCh);
            double acc = 0;
            uint64_t last_in = 0;
            DWORD t0 = GetTickCount();
            while (!g_quit) {
                Sleep(10);
                int nch;
                { std::lock_guard<std::mutex> lock(g_mu); nch = g_ring_ch; }
                size_t got = ring_pull(in.data(), nch, 480, primed);
                for (size_t i = 0; i < got; ++i) acc += (double)in[i * nch] * in[i * nch];
                if (GetTickCount() - t0 >= 1000) {
                    std::FILE *lg = nullptr;
                    fopen_s(&lg, "ksf-null.log", "a");
                    if (lg) std::fprintf(lg, "in=%llu frames/s  rms(L)=%.4f  underruns=%llu  client=%d  all=%d heights=%d\n",
                                (unsigned long long)(g_frames_in - last_in), std::sqrt(acc / kOutRate),
                                (unsigned long long)g_underruns.load(), g_client_connected.load() ? 1 : 0,
                                g_set.all.load() ? 1 : 0, g_set.heights.load() ? 1 : 0);
                    if (lg) std::fclose(lg);
                    acc = 0; last_in = g_frames_in; t0 = GetTickCount();
                }
            }
            break;
        }
        bool ran = run_spatial_once();
        if (!ran) {
            { std::lock_guard<std::mutex> lock(g_mu); g_spatial_ok = false; }
            g_info_version++;
        }
        for (int i = 0; i < 20 && !g_quit; ++i) Sleep(100);   // retry every 2 s (a device may appear)
    }
    CoUninitialize();
}

// ---------------------------------------------------------------- self-update
constexpr UINT WM_APP_QUIT = WM_APP + 2;

bool streaming_now() {                                      // audio flowing in the last few seconds?
    uint64_t a = g_frames_in;
    Sleep(3000);
    return g_frames_in != a;
}

void update_thread() {
    bool first = true;
    for (;;) {
        // first check 30 s after start, then every 6 hours, or at once when asked from the tray
        DWORD wait = first ? 30000 : 6 * 3600 * 1000;
        first = false;
        DWORD w = WaitForSingleObject(g_update_now, wait);
        if (g_quit) return;
        bool manual = (w == WAIT_OBJECT_0);
        if (!g_auto_update && !manual) continue;
        std::string last_err;
        bool any_ok = false, applied = false;
        for (const auto &src : g_update_sources) {
            upd::Found f;
            std::string err;
            int r = upd::check_source(src, kVersion, f, err);
            if (r < 0) { last_err = err; continue; }
            any_ok = true;
            if (r == 0) continue;
            set_status("Update " + f.version + " ready");
            while (!g_quit && !manual && streaming_now()) {}   // never cut the sound: wait for a pause (a manual check applies now)
            if (g_quit) return;
            std::string ierr;
            if (upd::install_and_relaunch(f.exe, ierr)) {
                set_status("Updated to " + f.version + ", restarting");
                g_quit = true;
                if (g_hwnd) PostMessageW(g_hwnd, WM_APP_QUIT, 0, 0);
                applied = true;
            } else { last_err = ierr; set_status("Update failed: " + ierr); }
            break;
        }
        if (applied) return;
        if (manual) set_status(any_ok && last_err.empty() ? std::string("Up to date (") + kVersion + ")" : "Update check failed: " + last_err);
    }
}

// ---------------------------------------------------------------- tray icon
constexpr UINT WM_TRAY = WM_USER + 1;
constexpr UINT ID_QUIT = 1, ID_AUTOSTART = 2, ID_UPDATE = 3;
const wchar_t *kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const wchar_t *kRunName = L"KSF Spatial Bridge";

bool autostart_on() {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
    bool on = RegQueryValueExW(k, kRunName, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
    RegCloseKey(k);
    return on;
}

void set_autostart(bool on) {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_WRITE, &k) != ERROR_SUCCESS) return;
    if (on) {
        wchar_t path[MAX_PATH];
        GetModuleFileNameW(nullptr, path, MAX_PATH);
        std::wstring v = L"\"" + std::wstring(path) + L"\"";
        RegSetValueExW(k, kRunName, 0, REG_SZ, (const BYTE *)v.c_str(), (DWORD)((v.size() + 1) * sizeof(wchar_t)));
    } else RegDeleteValueW(k, kRunName);
    RegCloseKey(k);
}

LRESULT CALLBACK wnd_proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_TRAY && (l == WM_RBUTTONUP || l == WM_LBUTTONUP)) {
        std::string st;
        { std::lock_guard<std::mutex> lock(g_mu); st = g_status; }
        std::wstring ws(st.begin(), st.end());
        HMENU menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING | MF_DISABLED, 0, (L"KSF Spatial Bridge " + upd::widen(kVersion) + L": " + ws).c_str());
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING | (autostart_on() ? MF_CHECKED : 0), ID_AUTOSTART, L"Start with Windows");
        AppendMenuW(menu, MF_STRING, ID_UPDATE, L"Check for updates now");
        AppendMenuW(menu, MF_STRING, ID_QUIT, L"Quit");
        POINT pt;
        GetCursorPos(&pt);
        SetForegroundWindow(h);
        UINT cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, h, nullptr);
        DestroyMenu(menu);
        if (cmd == ID_QUIT) { g_quit = true; PostQuitMessage(0); }
        else if (cmd == ID_AUTOSTART) set_autostart(!autostart_on());
        else if (cmd == ID_UPDATE) { set_status("Checking for updates"); SetEvent(g_update_now); }
        return 0;
    }
    if (m == WM_APP_QUIT) { PostQuitMessage(0); return 0; }
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(h, m, w, l);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    std::FILE *fp_ = nullptr;
    int port = 47321;
    DWORD after_update_pid = 0;
    std::vector<std::string> origins;
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    auto narrow = [](const wchar_t *w) {
        char b[1024]{};
        WideCharToMultiByte(CP_UTF8, 0, w, -1, b, sizeof(b), nullptr, nullptr);
        return std::string(b);
    };
    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];
        if (a == L"--port" && i + 1 < argc) port = _wtoi(argv[++i]);
        else if (a == L"--origin" && i + 1 < argc) origins.push_back(narrow(argv[++i]));
        else if (a == L"--null") g_null = true;
        else if (a == L"--normal-priority") g_normal_priority = true;
        else if (a == L"--update-url" && i + 1 < argc) g_update_sources.push_back(narrow(argv[++i]));
        else if (a == L"--update-github" && i + 1 < argc) g_update_sources.push_back("https://github.com/" + narrow(argv[++i]) + "/releases/latest/download/latest.json");
        else if (a == L"--no-update") g_auto_update = false;
        else if (a == L"--after-update" && i + 1 < argc) after_update_pid = (DWORD)_wtoi(argv[++i]);
        else if (a == L"--help") {
            if (AttachConsole(ATTACH_PARENT_PROCESS)) freopen_s(&fp_, "CONOUT$", "w", stdout);
            std::printf("ksf-spatial-bridge [--port N] [--origin URL] [--null] [--normal-priority] [--update-url URL] [--update-github OWNER/REPO] [--no-update]\n");
            return 0;
        }
    }
    if (g_null) {
        if (AttachConsole(ATTACH_PARENT_PROCESS)) { freopen_s(&fp_, "CONOUT$", "w", stdout); }
    }
    // Settings that must survive the autostart (which carries no arguments): spatial-bridge.conf next to the exe,
    // lines  update-url=https://...  |  update-github=owner/repo  |  update=off  |  origin=https://...
    {
        wchar_t self[MAX_PATH];
        GetModuleFileNameW(nullptr, self, MAX_PATH);
        std::wstring conf = self;
        size_t cut = conf.find_last_of(L'\\');
        conf = conf.substr(0, cut + 1) + L"spatial-bridge.conf";
        std::FILE *cf = nullptr;
        _wfopen_s(&cf, conf.c_str(), L"r");
        if (cf) {
            char line[1024];
            while (std::fgets(line, sizeof(line), cf)) {
                std::string l = line;
                while (!l.empty() && (l.back() == '\n' || l.back() == '\r' || l.back() == ' ')) l.pop_back();
                size_t eq = l.find('=');
                if (l.empty() || l[0] == '#' || eq == std::string::npos) continue;
                std::string k = l.substr(0, eq), v = l.substr(eq + 1);
                if (k == "update-url") g_update_sources.push_back(v);
                else if (k == "update-github") g_update_sources.push_back("https://github.com/" + v + "/releases/latest/download/latest.json");
                else if (k == "update" && v == "off") g_auto_update = false;
                else if (k == "origin") origins.push_back(v);
            }
            std::fclose(cf);
        }
        if (g_update_sources.empty()) g_update_sources.push_back(kDefaultUpdateSource);
    }
    upd::wait_for_predecessor(after_update_pid);          // a restart after an update: let the old copy end first
    upd::remove_old_copy();
    // One copy only.
    HANDLE single = CreateMutexW(nullptr, TRUE, L"Local\\KsfSpatialBridge");
    if (GetLastError() == ERROR_ALREADY_EXISTS && !g_null) return 0;
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    set_status("Waiting for the music page");

    std::thread net(net_thread, port, origins);
    std::thread audio(audio_thread);
    g_update_now = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    std::thread updater(update_thread);

    if (g_null) {                                           // no tray: run until killed
        while (!g_quit) Sleep(200);
    } else {
        WNDCLASSW wc{};
        wc.lpfnWndProc = wnd_proc;
        wc.hInstance = inst;
        wc.lpszClassName = L"KsfSpatialBridgeWnd";
        RegisterClassW(&wc);
        HWND hwnd = g_hwnd = CreateWindowW(wc.lpszClassName, L"KSF Spatial Bridge", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, inst, nullptr);
        NOTIFYICONDATAW nid{};
        nid.cbSize = sizeof(nid);
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        wcscpy_s(nid.szTip, L"KSF Spatial Bridge");
        Shell_NotifyIconW(NIM_ADD, &nid);
        MSG msg;
        while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }
    g_quit = true;
    SetEvent(g_update_now);
    net.join();
    audio.join();
    updater.join();
    WSACleanup();
    if (single) CloseHandle(single);
    return 0;
}
