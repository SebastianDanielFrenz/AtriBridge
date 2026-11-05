# KSF Spatial Bridge

A small Windows tray app that lets the media-dl **music page** play through **Windows Spatial Sound**
(Dolby Atmos for Home Theater, DTS:X, Windows Sonic), including the **height speakers**. A browser
is only handed the 7.1 bed of such a device; this app is handed the objects.

```
music page --(ws://127.0.0.1:47321, float32 stereo)--> ksf-spatial-bridge --(ISpatialAudioClient)--> speakers
```

* **Stereo** - the front pair only.
* **All** - every ear-level speaker at the same level (left-side speakers get L, right-side ones R,
  the centre gets (L+R)/2). The **Heights** switch adds the height speakers the same way. LFE stays silent.

## Use

1. Windows Sound settings: pick your AV receiver / TV output and switch on *Dolby Atmos for Home
   Theater* (or DTS:X / Windows Sonic) for it.
2. Run `ksf-spatial-bridge.exe`. A tray icon appears (right-click: status, *Start with Windows*, *Quit*).
   Windows SmartScreen may warn about an unsigned app; the source is here, build it yourself if in doubt.
3. Open the music page. The output button in the player bar changes to e.g. `7.1.4 all`; while the
   app is connected the browser's own output is silent and the app plays.

The app listens on `127.0.0.1` only and accepts connections from `https://media-dl.ksfhost.de`,
`https://music.ksfhost.de` and localhost pages (add more with `--origin URL`).

## Build

Visual Studio 2022 Build Tools (C++ workload), then `build.cmd`. No other dependencies.
`tools/ws_test.py` drives the app in `--null` mode (no audio output) to check receiving and resampling.

## Options

`--port N` (default 47321), `--origin URL`, `--null` (receive and measure only; writes `ksf-null.log`), `--normal-priority`.

## Updates

The app updates itself. Thirty seconds after it starts, and every six hours after that, it reads a small signed
manifest (`latest.json`) from an update source, and if the version there is newer it downloads the exe, checks it,
swaps itself in place and restarts. It waits for a pause in the audio first, so the music is never cut. The tray
menu has *Check for updates now*.

An update source is either

* a **self-hosted AtriHord** server: `--update-url https://your.server/api/public/spatial-bridge/latest.json`
  (the server serves the two files from `web_files/app/spatial-bridge/`), or
* a **GitHub release**: `--update-github OWNER/REPO` (reads `releases/latest/download/latest.json`; attach
  `latest.json` and `ksf-spatial-bridge.exe` to each release).

Sources can also be set in `spatial-bridge.conf` next to the exe (the autostart carries no arguments):

```
update-url=https://your.server/api/public/spatial-bridge/latest.json
update-github=OWNER/REPO
update=off            # never check on its own (the tray item still works)
```

`--no-update` does the same for one run. With no source given the built-in default (`kDefaultUpdateSource` in
`src/main.cpp`) is used: change it before building your own copy.

**Safety.** HTTPS only, and an update is installed only if the exe's SHA-256 matches the manifest *and* the
manifest's ECDSA P-256 signature verifies against the public key compiled into the app (`src/update_pubkey.h`).
A hacked server or release page cannot push code, and older versions are refused. The program folder must be
writable (it is, in your user folder; not in `Program Files`).

**Releasing** (maintainer): bump `kVersion` in `src/main.cpp`, build, then

```
python tools/publish.py --exe out/ksf-spatial-bridge.exe --version X.Y.Z --key PATH/update_private.pem --out release/
```

and put `release/latest.json` + `release/ksf-spatial-bridge.exe` on the server or the GitHub release. Keep the
private key out of the repository and backed up; `tools/make_pubkey_header.py KEY.pem` regenerates the public
half for a new key (apps built with the old key then cannot update to builds signed with the new one).

## Scheduling

The audio thread registers with the Windows Multimedia Class Scheduler (task "Pro Audio", critical priority; falls
back to "Audio", then to plain time-critical thread priority) and the network thread runs above normal, so
heavy load from a game or a render does not make the sound crackle. `--normal-priority` turns that off.

MIT licence.
