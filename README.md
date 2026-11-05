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

## Scheduling

The audio thread registers with the Windows Multimedia Class Scheduler (task "Pro Audio", critical priority; falls
back to "Audio", then to plain time-critical thread priority) and the network thread runs above normal, so
heavy load from a game or a render does not make the sound crackle. `--normal-priority` turns that off.

MIT licence.
