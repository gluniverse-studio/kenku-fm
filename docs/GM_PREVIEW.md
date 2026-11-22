# GM-only Preview

Kenku FM's GM-only preview lets the GM audition any local playlist track or soundboard sound privately on their own headphones or speakers before the table hears it. Preview audio never enters Kenku FM's Discord broadcast pipeline, the Stream Kit's `music`/`sfx` Voice Room tracks, or any "now playing" report.

## Design goals

During a live session the main risk is **mode confusion**: broadcasting something meant to be previewed, or previewing when trying to fire live audio. Every interaction is designed to make **Live (table hears it)** and **Preview (only you hear it)** impossible to mistake for each other:

1. **Dedicated Preview Deck, physically separate from the Live Player**
   - When a preview is loaded, a separate floating **Preview Deck** appears above the live player with a clear gap between them (never fused into the same card).
   - It uses an unmistakable opaque **amber** surface (`#2b2114`) and amber accent paired with a **Headphones** icon and the explicit label **"PREVIEW · Only you hear this"**.
   - While the Preview Deck is open, the live player card below it displays a matching lavender border and **"LIVE · Table hears this"** header strip so both decks contrast explicitly side by side.
   - When no preview is active, the Preview Deck is hidden so the player stays uncluttered.

2. **Separate Preview triggers that cannot be mistaken for Live Play**
   - **Playlist tracks:** an amber-accented **Headphones** button sits next to the live Play/Pause button with a vertical divider and tooltip *"Preview (only you hear this)"*. While actively previewing that track, the amber button switches to a compact stop glyph.
   - **Soundboard pads:** the amber **Headphones** preview button is placed in the top-right card header next to the menu button, physically separated from the large bottom-right live Play/Stop button so a GM cannot fat-finger live playback when reaching to audition an SFX.
   - **All audio (Library):** an amber outlined **Preview** (or **Stop preview** while playing) button sits beside the **Play** button.
   - Clicking an item's preview button starts previewing it; clicking it again while playing stops and closes preview immediately.
   - Only local library files (`file://`) are previewable; remote `http(s)://` URLs disable the preview button because the hidden Audio Capture window runs unsandboxed for its preload audio worklet and does not load untrusted third-party media.

3. **Preview Deck controls**
   - Shows the item title, source playlist or soundboard name, item kind (`Track` or `Sound`), a scrubbable seek bar with elapsed/remaining timestamps, Play/Pause, Close (`×`), and its own **independent preview volume and mute** (persisted separately from live playlist volume and monitor gain).
   - Previewing always plays once and stops cleanly at 0:00 (it never loops indefinitely), leaving the deck ready to replay or promote.

4. **Promoting a preview to live ("Play live")**
   - The Preview Deck includes a lavender-styled **"Play live"** button (matching the live player's colour so crossing into broadcast is visibly intentional).
   - For a **playlist track**, clicking **"Play live"** (labeled *"Play live from M:SS"* once scrubbed past 0:00) immediately stops and closes the preview, starts the track in its playlist queue, and begins live playback from that same position. If that track is already live:
     - Scrubbed past 0:00: stops preview, jumps the live track to that position, and resumes if paused.
     - At 0:00 / ended while paused: labeled **"Resume live"** and un-pauses live playback without restarting at 0:00.
     - At 0:00 / ended while already playing: disabled and labeled **"Already live"** so clicking it can never accidentally restart the table's music.
   - For a **soundboard sound**, clicking **"Play live"** (or **"Restart live"** when that sound is already playing live) immediately stops and closes the preview and triggers the sound live from the start with its configured volume, fade, and loop settings.

5. **Local monitor ducking (GM headphones only — and OS/browser caveats)**
   - While preview is audibly playing (playing, unmuted, volume > 0), Kenku FM's own local monitor of the live mix smoothly ducks by −12 dB (25% linear gain) so the preview is easy to hear over loud battle music.
   - Ducking happens strictly **after** the broadcast worklet in the Audio Capture window: it never touches Discord, the Stream Kit, or the output level meters.
   - It never touches OS mixer levels, communications/ducking APIs, or microphone capture, and uses standard shared-mode playback (`latencyHint: "playback"`), so player voices coming from Discord or an external Stream Kit Voice Room client are never ducked, interrupted, or switched out of high-quality audio profiles.
   - *Caveat:* if the GM listens to player voices inside a **Kenku FM browser tab** (e.g. Discord web or a web Voice Room opened inside Kenku), those voices are part of Kenku's own live monitor and will duck alongside live music while **Duck live** is on. Toggle **Duck live: Off** on the Preview Deck (or open voice chat outside Kenku) to avoid ducking them.
   - Preview works identically whether active live audio is routed to **This Computer**, **Discord**, **Stream Kit**, or any combination (including browser tabs like YouTube/Spotify playing live while previewing a library track).

6. **Dedicated Preview Device & OS-level desktop capture caveat**
   - In **Monitor Settings** (gear icon beside **This Computer**), a separate **Preview Device** selector defaults to **Same as Monitor** (which follows the Monitor device / System Default) and lets the GM pin previews to a dedicated headphones device.
   - *OS-level capture caveat:* Kenku FM itself never mixes preview into Discord or Stream Kit. However, if you capture system/desktop audio at the OS level — for example via OBS desktop audio, Discord Go Live, or a loopback external input in Kenku (`Stereo Mix`, PipeWire `Monitor of …`, VB-Cable) — audio sent to that same OS output device will be picked up by that capture. In those setups, select a dedicated **Preview Device** in Monitor Settings (Monitor Settings also warns when an active external input looks like a loopback source).

7. **Keyboard and focus behaviour**
   - Pressing **Escape** (when no dialog, menu, or text field is active) immediately stops and closes the preview deck.
   - Inside the Preview Deck, **Space** toggles preview play/pause when focus is on the deck container itself (never live playback, and never double-toggling focused buttons, chips, or sliders); arrow keys on the seek slider scrub only the preview.
   - Pointer-down propagation is stopped on row/card Preview buttons so drag-and-drop reordering does not swallow preview clicks.
   - **"Play live"** has no bare single-key shortcut, preventing accidental broadcasts.
   - OS hardware media keys (`MediaSession`) remain bound strictly to live playlist playback and never show or control preview audio.

8. **Previewing the currently live track or sound**
   - Allowed and completely non-destructive: starting, seeking, or stopping a preview never interrupts live playback.
   - Both states remain visibly marked on the item (lavender live highlight + amber preview stripe), and the Preview Deck shows an **"Also playing live"** badge.

## Audio routing and isolation

Anything the Player view (`src/player/`) outputs through its `AudioContext`, Howler, or `<audio>` elements is captured by Chromium tab capture (`chromeMediaSource: "tab"`) into the Discord broadcast, and anything hitting `outputBuses` (`music` / `sfx`) is published to LiveKit by `StreamKitVoice`.

Preview playback therefore **never runs inside the Player view**:

```
Player View (tab-captured -> Discord; outputBuses -> Stream Kit)
  │  IPC: PLAYER_PREVIEW_* (authorized to registered player main frame only)
  ▼
Main Process (PreviewManager)
  │  accepts file:// only -> resolves kenku-media://local/<token>/...
  │  stops preview on player navigation / reload / crash / re-register
  │  forwards to hidden Audio Capture window
  ▼
Audio Capture Window (not tab-captured)
  ├── Live Capture Graph (unchanged):
  │     views + inputs -> PCMStream AudioWorklet -> Opus/PCM (Discord) + AUDIO_CAPTURE_LEVELS
  │                            └─> _monitorGainNode -> _monitorDuckGainNode -> _audioOutputElement
  │                                                      (muted when "This Computer" is unticked)
  └── PreviewAudioEngine (separate AudioContext, never connected to PCMStream):
        kenku-media:// -> <audio crossOrigin="anonymous">
          -> GainNode (preview volume/mute)
          -> AnalyserNode
          -> MediaStreamAudioDestinationNode
          -> _outputElement (<audio>, setSinkId = previewDeviceId || monitorDeviceId, never muted by loopback)
```

Because `PreviewAudioEngine` runs in the uncaptured Audio Capture window on its own `AudioContext` and outputs through its own `_outputElement` with `setSinkId(previewDeviceId || monitorDeviceId)`:

- **Discord broadcast & meter (`AUDIO_CAPTURE_LEVELS`):** zero samples from preview ever enter `_pcmStreamNode`.
- **Stream Kit (`music` / `sfx` bus taps):** zero samples from preview ever enter the Player view's `AudioContext` or `Howler`.
- **"This Computer" unticked (`loopback = false`):** only `_audioOutputElement` (the live monitor) is muted; `_outputElement` stays unmuted and routed to the chosen Preview/Monitor device, so a GM monitoring the live mix through the Voice Room still hears previews clearly.
- **Now-playing / HTTP remote / Stream Deck:** preview state lives in its own `preview` Redux slice (`src/player/features/preview/previewSlice.ts`) and is never read by `StreamKitBridge`, `PlaylistRemote`, `SoundboardRemote`, or `PlaylistMediaSession`.
- **Media protocol & sandbox security:** `PreviewManager` (`src/main/managers/PreviewManager.ts`) accepts preview commands only from the registered player `webContents` main frame, rejects every scheme except `file:`, and resolves `file://` paths to `kenku-media://` capability URLs in the main process before forwarding them solely to the hidden Audio Capture window.

## Verification

Run type checking and the unit test suite:

```sh
./node_modules/.bin/tsc --noEmit
node --test tests/gm-preview.test.cjs tests/library-audio.test.cjs tests/stream-kit-client.test.cjs tests/stream-kit-manager.test.cjs
```
