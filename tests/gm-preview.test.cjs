const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const EventEmitter = require("node:events");
const ts = require("typescript");

function loadTs(file, overrides = {}, globals = {}) {
  const absolute = path.resolve(file);
  const dir = path.dirname(absolute);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (name) => {
      if (name in overrides) {
        return overrides[name];
      }
      if (name.startsWith(".")) {
        const resolved = path.resolve(dir, name);
        for (const candidate of [
          resolved,
          `${resolved}.ts`,
          `${resolved}.tsx`,
          `${resolved}.js`,
          path.join(resolved, "index.ts"),
        ]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
              return loadTs(candidate, overrides, globals);
            }
            return require(candidate);
          }
        }
      }
      return require(name);
    },
    console,
    Buffer,
    URL,
    Float32Array,
    Int16Array,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...globals,
  };
  vm.runInNewContext(code, sandbox, { filename: absolute });
  return moduleObj.exports;
}

class FakeAudioElement {
  constructor() {
    this.src = "";
    this.srcObject = null;
    this.crossOrigin = null;
    this.preload = "";
    this.loop = false;
    this.volume = 1;
    this.muted = false;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 120;
    this.readyState = 4;
    this.sinkId = "";
    this.sinkHistory = [];
    this._listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  dispatch(type) {
    for (const fn of this._listeners.get(type) ?? []) {
      fn();
    }
  }

  load() {}

  removeAttribute(name) {
    if (name === "src") {
      this.src = "";
    }
  }

  play() {
    this.paused = false;
    this.ended = false;
    this.dispatch("play");
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatch("pause");
    }
  }

  async setSinkId(id) {
    this.sinkId = id;
    this.sinkHistory.push(id);
  }
}

class FakeAudioParam {
  constructor(initial = 1) {
    this.value = initial;
    this.targets = [];
  }

  setTargetAtTime(target, startTime, timeConstant) {
    this.value = target;
    this.targets.push({ target, startTime, timeConstant });
  }
}

class FakeNode {
  constructor(type, context) {
    this.type = type;
    this.context = context;
    this.connections = [];
    this.disconnected = false;
  }

  connect(dest, outputIndex, inputIndex) {
    this.connections.push({ dest, outputIndex, inputIndex });
    return dest;
  }

  disconnect() {
    this.disconnected = true;
    this.connections = [];
  }
}

class FakeAudioContext {
  constructor(options = {}) {
    this.options = options;
    this.sampleRate = options.sampleRate ?? 48000;
    this.currentTime = 1;
    this.state = "running";
    this.closed = false;
    this.createdNodes = [];
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = new FakeNode("gain", this);
    node.gain = new FakeAudioParam(1);
    this.createdNodes.push(node);
    return node;
  }

  createAnalyser() {
    const node = new FakeNode("analyser", this);
    node.fftSize = 256;
    node.sampleValue = 0.42;
    node.getFloatTimeDomainData = (arr) => {
      arr.fill(node.sampleValue);
    };
    this.createdNodes.push(node);
    return node;
  }

  createMediaStreamDestination() {
    const node = new FakeNode("destination", this);
    node.stream = { id: `stream-${this.createdNodes.length}` };
    this.createdNodes.push(node);
    return node;
  }

  createMediaElementSource(element) {
    const node = new FakeNode("element-source", this);
    node.element = element;
    this.createdNodes.push(node);
    return node;
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}
FakeAudioContext.instances = [];

test("PreviewManager authorizes only registered player main frame, refuses remote URLs, and stops on lifecycle changes", () => {
  const ipcMain = new EventEmitter();
  const sentToPlayer = [];
  const captureCalls = [];
  const audioCaptureManager = new EventEmitter();
  audioCaptureManager.previewLoad = (cmd) => captureCalls.push(["load", cmd]);
  audioCaptureManager.previewPlay = () => captureCalls.push(["play"]);
  audioCaptureManager.previewPause = () => captureCalls.push(["pause"]);
  audioCaptureManager.previewStop = () => captureCalls.push(["stop"]);
  audioCaptureManager.previewSeek = (to) => captureCalls.push(["seek", to]);
  audioCaptureManager.previewSetVolume = (v) => captureCalls.push(["volume", v]);
  audioCaptureManager.previewSetMuted = (m) => captureCalls.push(["muted", m]);
  audioCaptureManager.previewSetDuck = (d) => captureCalls.push(["duck", d]);

  const playerMainFrame = { id: "main-frame" };
  const playerSubFrame = { id: "sub-frame" };
  const playerView = new EventEmitter();
  playerView.id = 42;
  playerView.mainFrame = playerMainFrame;
  playerView.isDestroyed = () => false;
  playerView.send = (channel, payload) => sentToPlayer.push([channel, payload]);

  const playerManager = {
    registeredViewId: 42,
    getView: () => playerView,
  };

  const { PreviewManager, resolvePreviewURL } = loadTs(
    "src/main/managers/PreviewManager.ts",
    {
      electron: {
        ipcMain,
        webContents: {
          fromId: (id) => (id === 42 ? playerView : undefined),
        },
      },
      "../mediaProtocol": {
        getMediaURL: (filePath) =>
          `kenku-media://local/secret-token/${encodeURIComponent(filePath)}`,
      },
    },
  );

  // Only local file:// URLs resolve; remote http(s) and other schemes are refused
  assert.equal(
    resolvePreviewURL("file://%2Fmusic%2Fbattle%20theme.mp3"),
    "kenku-media://local/secret-token/%2Fmusic%2Fbattle%20theme.mp3",
  );
  assert.equal(resolvePreviewURL("https://example.com/audio.mp3"), null);
  assert.equal(resolvePreviewURL("http://example.com/audio.mp3"), null);
  assert.equal(resolvePreviewURL("javascript:alert(1)"), null);
  assert.equal(resolvePreviewURL("data:audio/wav;base64,AAAA"), null);

  const manager = new PreviewManager(playerManager, audioCaptureManager);

  // Untrusted tab must be ignored
  const tabEvent = {
    sender: { id: 99, mainFrame: playerMainFrame },
    senderFrame: playerMainFrame,
  };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", tabEvent, {
    url: "file://%2Fetc%2Fpasswd",
    volume: 1,
    muted: false,
    duckLiveMonitor: true,
    requestId: 1,
  });
  assert.equal(captureCalls.length, 0);

  // Subframe inside player must also be ignored
  const subFrameEvent = { sender: playerView, senderFrame: playerSubFrame };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", subFrameEvent, {
    url: "file://%2Fmusic%2Ftrack.flac",
    volume: 1,
    muted: false,
    duckLiveMonitor: true,
    requestId: 2,
  });
  assert.equal(captureCalls.length, 0);

  // Registered player main frame succeeds for local files
  const playerEvent = { sender: playerView, senderFrame: playerMainFrame };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", playerEvent, {
    url: "file://%2Fmusic%2Ftavern.flac",
    volume: 0.75,
    muted: false,
    duckLiveMonitor: true,
    requestId: 3,
  });
  assert.equal(captureCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(captureCalls[0])), [
    "load",
    {
      url: "kenku-media://local/secret-token/%2Fmusic%2Ftavern.flac",
      volume: 0.75,
      muted: false,
      duckLiveMonitor: true,
      requestId: 3,
    },
  ]);

  // Remote URL from player returns an error state and does not reach unsandboxed capture window
  ipcMain.emit("PLAYER_PREVIEW_LOAD", playerEvent, {
    url: "https://example.com/remote.mp3",
    volume: 0.75,
    muted: false,
    duckLiveMonitor: true,
    requestId: 4,
  });
  assert.equal(captureCalls.length, 1);
  assert.equal(sentToPlayer[0][0], "PLAYER_PREVIEW_STATE");
  assert.equal(sentToPlayer[0][1].requestId, 4);
  assert.match(sentToPlayer[0][1].error, /local audio files/i);

  // Subframe navigation does NOT stop preview, but main-frame navigation / crash / re-register DO
  playerView.emit("did-start-navigation", {}, "https://sub", false, false);
  assert.equal(captureCalls.length, 1);
  playerView.emit("did-start-navigation", {}, "file:///player", false, true);
  assert.equal(captureCalls[1][0], "stop");
  playerView.emit("render-process-gone", {});
  assert.equal(captureCalls[2][0], "stop");
  ipcMain.emit("PLAYER_REGISTER_VIEW", {}, 42);
  assert.equal(captureCalls[3][0], "stop");
  playerView.emit("destroyed");
  assert.equal(captureCalls[4][0], "stop");

  // Engine state from AudioCaptureManagerMain forwards to player view
  const engineState = {
    requestId: 3,
    loading: false,
    playing: true,
    progress: 12.5,
    duration: 180,
    ended: false,
    level: 0.5,
  };
  audioCaptureManager.emit("previewState", engineState);
  assert.deepEqual(sentToPlayer[1], ["PLAYER_PREVIEW_STATE", engineState]);

  manager.destroy();
  const countBefore = captureCalls.length;
  ipcMain.emit("PLAYER_PREVIEW_STOP", playerEvent);
  assert.equal(captureCalls.length, countBefore);
});

test("PreviewAudioEngine isolates local preview, refuses non-local URLs, handles rapid switching, and unducks when muted or volume=0", async () => {
  FakeAudioContext.instances = [];
  const createdElements = [];
  const states = [];
  const audibleChanges = [];

  const { PreviewAudioEngine } = loadTs(
    "src/preload/managers/PreviewAudioEngine.ts",
    {},
    {
      AudioContext: FakeAudioContext,
      HTMLMediaElement: { HAVE_NOTHING: 0 },
      DOMException: class FakeDOMException extends Error {},
      document: {
        createElement: (tag) => {
          assert.equal(tag, "audio");
          const el = new FakeAudioElement();
          createdElements.push(el);
          return el;
        },
      },
    },
  );

  const engine = new PreviewAudioEngine({
    onState: (s) => states.push(s),
    onPlayingChange: (a) => audibleChanges.push(a),
  });

  await engine.setMonitorDevice("gm-headphones");

  engine.load({
    url: "kenku-media://local/tok/%2Fmusic%2Fboss.flac",
    volume: 0.6,
    muted: false,
    duckLiveMonitor: true,
    requestId: 10,
  });

  assert.equal(FakeAudioContext.instances.length, 1);
  const firstSourceEl = createdElements[0];
  const outputEl = createdElements[1];
  assert.equal(firstSourceEl.crossOrigin, "anonymous");
  assert.equal(outputEl.muted, false);
  assert.equal(outputEl.sinkId, "gm-headphones");
  assert.deepEqual(audibleChanges, [true]);
  assert.ok(engine.getDiagnostics().peakLevel > 0.4);

  // Muting releases audible/duck state and drops peakLevel to 0; unmuting restores it
  engine.setMuted(true);
  assert.deepEqual(audibleChanges, [true, false]);
  assert.equal(engine.getDiagnostics().peakLevel, 0);
  engine.setMuted(false);
  assert.deepEqual(audibleChanges, [true, false, true]);

  // Setting volume to 0 also releases audible/duck state
  engine.setVolume(0);
  assert.deepEqual(audibleChanges, [true, false, true, false]);
  engine.setVolume(0.8);
  assert.deepEqual(audibleChanges, [true, false, true, false, true]);

  // Switching device updates output sink immediately
  await engine.setMonitorDevice("usb-dac");
  assert.equal(outputEl.sinkId, "usb-dac");

  // Pending seek before metadata is held and applied on loadedmetadata
  firstSourceEl.readyState = 0;
  engine.seek(35);
  firstSourceEl.readyState = 4;
  firstSourceEl.dispatch("loadedmetadata");
  assert.equal(firstSourceEl.currentTime, 35);

  // Rapid switch to a second track tears down the first element so stale events are ignored
  engine.load({
    url: "kenku-media://local/tok/%2Fmusic%2Ftavern.flac",
    volume: 0.8,
    muted: false,
    duckLiveMonitor: true,
    requestId: 11,
  });
  const secondSourceEl = createdElements[2];
  const stateCountBeforeStale = states.length;
  firstSourceEl.dispatch("ended");
  firstSourceEl.dispatch("error");
  assert.equal(states.length, stateCountBeforeStale);

  // An error on the active element releases audible/duck state
  secondSourceEl.paused = true;
  secondSourceEl.dispatch("error");
  assert.equal(audibleChanges[audibleChanges.length - 1], false);

  // Refuses non-kenku-media URLs directly in the engine as defense-in-depth
  engine.load({
    url: "https://example.com/ambience.mp3",
    volume: 0.5,
    muted: false,
    duckLiveMonitor: true,
    requestId: 12,
  });
  assert.match(states[states.length - 1].error, /local audio files/i);

  engine.destroy();
  assert.equal(FakeAudioContext.instances[0].closed, true);
});

test("AudioCaptureManagerPreload keeps preview graph completely isolated, supports dedicated preview device, and ducks only post-worklet when audible", async () => {
  FakeAudioContext.instances = [];
  const createdElements = [];
  const sentIpc = [];
  const ipcRenderer = {
    send: (channel, ...args) => sentIpc.push([channel, ...args]),
    once: () => {},
  };

  const { AudioCaptureManagerPreload } = loadTs(
    "src/preload/managers/AudioCaptureManagerPreload.ts",
    {
      electron: { ipcRenderer },
      "./PCMStream.worklet": "mock-worklet.js",
    },
    {
      AudioContext: FakeAudioContext,
      HTMLMediaElement: { HAVE_NOTHING: 0 },
      DOMException: class FakeDOMException extends Error {},
      document: {
        createElement: () => {
          const el = new FakeAudioElement();
          createdElements.push(el);
          return el;
        },
      },
    },
  );

  const capture = new AudioCaptureManagerPreload();
  capture._audioContext = new FakeAudioContext();
  capture._pcmStreamNode = new FakeNode("pcm-worklet", capture._audioContext);
  await capture._setupLoopback();

  const liveOutputElement = capture._audioOutputElement;
  const monitorGainNode = capture._monitorGainNode;
  const duckGainNode = capture._monitorDuckGainNode;

  // Topology: _pcmStreamNode -> _monitorGainNode -> _monitorDuckGainNode -> mediaDestination
  assert.equal(capture._pcmStreamNode.connections[0].dest, monitorGainNode);
  assert.equal(monitorGainNode.connections[0].dest, duckGainNode);
  assert.equal(duckGainNode.gain.value, 1);

  // Untick "This Computer", route Monitor to virtual cable, and route Preview to dedicated headset
  capture.setLoopback(false);
  await capture.setMonitorDevice("vb-cable");
  await capture.setPreviewDevice("gm-headset");
  assert.equal(liveOutputElement.muted, true);
  assert.equal(liveOutputElement.sinkId, "vb-cable");

  capture.previewLoad({
    url: "kenku-media://local/tok/%2Fmusic%2Fcheck.flac",
    volume: 0.9,
    muted: false,
    duckLiveMonitor: true,
    requestId: 1,
  });

  // Preview plays on its dedicated headset, unmuted, even while loopback is muted on vb-cable
  const previewDiag = capture._previewEngine.getDiagnostics();
  assert.equal(previewDiag.playing, true);
  assert.equal(previewDiag.outputMuted, false);
  assert.equal(previewDiag.sinkId, "gm-headset");
  assert.equal(liveOutputElement.muted, true);
  assert.equal(duckGainNode.gain.value, 0.25);

  // Explicit isolation check: no node created on the preview AudioContext connects
  // to the capture AudioContext or `_pcmStreamNode`
  assert.equal(FakeAudioContext.instances.length, 2);
  const captureCtx = FakeAudioContext.instances[0];
  const previewCtx = FakeAudioContext.instances[1];
  assert.notEqual(captureCtx, previewCtx);
  const captureNodeSet = new Set([
    ...captureCtx.createdNodes,
    capture._pcmStreamNode,
  ]);
  for (const node of previewCtx.createdNodes) {
    for (const conn of node.connections) {
      assert.equal(
        captureNodeSet.has(conn.dest),
        false,
        "Preview graph node must never connect to live capture graph",
      );
    }
  }

  // Muting preview releases live monitor ducking; unmuting re-ducks
  capture.previewSetMuted(true);
  assert.equal(duckGainNode.gain.value, 1);
  capture.previewSetMuted(false);
  assert.equal(duckGainNode.gain.value, 0.25);

  // Clearing dedicated preview device falls back to monitor device
  await capture.setPreviewDevice("");
  assert.equal(capture._previewEngine.getDiagnostics().sinkId, "vb-cable");

  // Stopping preview restores duck gain to 1
  capture.previewStop();
  assert.equal(duckGainNode.gain.value, 1);

  capture._previewEngine.destroy();
});

test("AudioCaptureManagerMain replays settings on reload, reports interrupted preview, and checks sender", () => {
  const ipcMain = new EventEmitter();
  const sentToCapture = [];
  const fakeWebContents = new EventEmitter();
  fakeWebContents.loadURL = () => {};
  fakeWebContents.send = (ch, ...args) => sentToCapture.push([ch, ...args]);
  fakeWebContents.close = () => {};
  fakeWebContents.destroy = () => {};
  fakeWebContents.reload = () => {};

  class FakeBrowserWindow {
    constructor() {
      this.webContents = fakeWebContents;
    }
    isDestroyed() {
      return false;
    }
  }

  const { AudioCaptureManagerMain } = loadTs(
    "src/main/managers/AudioCaptureManagerMain.ts",
    {
      electron: {
        BrowserWindow: FakeBrowserWindow,
        ipcMain,
        MessageChannelMain: class {},
        webContents: { fromId: () => fakeWebContents },
      },
      "prism-media": { opus: { Encoder: class {} } },
    },
    {
      AUDIO_CAPTURE_WINDOW_WEBPACK_ENTRY: "http://capture",
      AUDIO_CAPTURE_WINDOW_PRELOAD_WEBPACK_ENTRY: "preload.js",
      PLAYER_WINDOW_WEBPACK_ENTRY: "http://player",
    },
  );

  const main = new AudioCaptureManagerMain();
  const receivedStates = [];
  main.on("previewState", (s) => receivedStates.push(s));

  ipcMain.emit("AUDIO_CAPTURE_SET_LOOPBACK", {}, false);
  ipcMain.emit("AUDIO_CAPTURE_SET_MONITOR_GAIN", {}, 0.4);
  ipcMain.emit("AUDIO_CAPTURE_SET_MONITOR_DEVICE", {}, "speakers");
  ipcMain.emit("AUDIO_CAPTURE_SET_PREVIEW_DEVICE", {}, "headphones");
  main.previewLoad({
    url: "kenku-media://local/tok/test",
    volume: 0.8,
    muted: false,
    duckLiveMonitor: false,
    requestId: 77,
  });

  // Spoofed AUDIO_CAPTURE_PREVIEW_STATE from another sender is ignored
  ipcMain.emit(
    "AUDIO_CAPTURE_PREVIEW_STATE",
    { sender: { fake: true } },
    { requestId: 77, playing: true },
  );
  assert.equal(receivedStates.length, 0);

  // Capture window reloads (e.g. after crash): replays all monitor/preview settings
  // and emits an interrupted error for the active preview so the player closes the deck
  sentToCapture.length = 0;
  fakeWebContents.emit("did-finish-load");
  assert.deepEqual(
    sentToCapture.map((c) => c[0]),
    [
      "AUDIO_CAPTURE_SET_LOOPBACK",
      "AUDIO_CAPTURE_SET_MONITOR_GAIN",
      "AUDIO_CAPTURE_SET_MONITOR_DEVICE",
      "AUDIO_CAPTURE_SET_PREVIEW_DEVICE",
      "AUDIO_CAPTURE_PREVIEW_SET_DUCK",
    ],
  );
  assert.equal(sentToCapture[3][1], "headphones");
  assert.equal(receivedStates.length, 1);
  assert.equal(receivedStates[0].requestId, 77);
  assert.equal(receivedStates[0].error, "Preview was interrupted");

  main.destroy();
});

test("previewHelpers promote-to-live plans protect already-live tracks and clamp edge positions", () => {
  const { isPreviewableUrl, computePromoteStartAt, planPromoteToLive } = loadTs(
    "src/player/features/preview/previewHelpers.ts",
  );

  assert.equal(isPreviewableUrl("file://%2Fmusic%2Fa.flac"), true);
  assert.equal(isPreviewableUrl("https://example.com/a.mp3"), false);

  assert.equal(computePromoteStartAt(0.4, 120, false), 0);
  assert.equal(computePromoteStartAt(15.7, 120, false), 15.7);
  assert.equal(computePromoteStartAt(119.5, 120, false), 0);
  assert.equal(computePromoteStartAt(40, 120, true), 0);

  const trackItem = {
    id: "t1",
    kind: "track",
    title: "Battle",
    parentId: "p1",
    parentTitle: "Combat",
    url: "file://%2Fbattle.flac",
  };

  // Same track already live & playing at startAt=0 must NOT seek back to 0
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        planPromoteToLive({
          item: trackItem,
          progress: 0.2,
          duration: 120,
          ended: false,
          liveTrackId: "t1",
          liveHasPlayback: true,
          livePlaying: true,
        }),
      ),
    ),
    { type: "none" },
  );

  // Same track live & paused at startAt=0 resumes without restarting
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        planPromoteToLive({
          item: trackItem,
          progress: 0,
          duration: 120,
          ended: true,
          liveTrackId: "t1",
          liveHasPlayback: true,
          livePlaying: false,
        }),
      ),
    ),
    { type: "resume-live-track" },
  );

  // Same track scrubbed to 42.8s seeks live track to 42s
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        planPromoteToLive({
          item: trackItem,
          progress: 42.8,
          duration: 120,
          ended: false,
          liveTrackId: "t1",
          liveHasPlayback: true,
          livePlaying: true,
        }),
      ),
    ),
    { type: "seek-and-resume-live-track", position: 42 },
  );

  // Different track plays in its parent playlist starting from preview position
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        planPromoteToLive({
          item: trackItem,
          progress: 23.4,
          duration: 120,
          ended: false,
          liveTrackId: "t2",
          liveHasPlayback: true,
          livePlaying: true,
        }),
      ),
    ),
    { type: "play-track", trackId: "t1", playlistId: "p1", startAt: 23.4 },
  );

  // Soundboard sound promotes as play-sound
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        planPromoteToLive({
          item: { ...trackItem, id: "s1", kind: "sound" },
          progress: 2,
          duration: 5,
          ended: false,
          liveHasPlayback: false,
          livePlaying: false,
        }),
      ),
    ),
    { type: "play-sound", soundId: "s1" },
  );
});

test("previewSlice tracks active preview, drops stale requestIds, and clamps settings", () => {
  const {
    default: reducer,
    startPreview,
    syncPreviewEngine,
    clearPreview,
    setPreviewVolume,
    setPreviewMuted,
    setPreviewDuckLiveMonitor,
    updatePreviewItemMeta,
  } = loadTs("src/player/features/preview/previewSlice.ts");

  let state = reducer(undefined, { type: "@@INIT" });
  assert.equal(state.item, null);
  assert.equal(state.duckLiveMonitor, true);

  state = reducer(
    state,
    startPreview({
      requestId: 2,
      item: {
        id: "t1",
        kind: "track",
        title: "Tavern",
        parentId: "p1",
        parentTitle: "Town",
        url: "file://%2Ftavern.flac",
      },
    }),
  );
  assert.equal(state.item.title, "Tavern");
  assert.equal(state.loading, true);

  // Stale requestId=1 is ignored
  state = reducer(
    state,
    syncPreviewEngine({
      requestId: 1,
      loading: false,
      playing: true,
      progress: 40,
      duration: 100,
      ended: false,
      level: 0.5,
    }),
  );
  assert.equal(state.playing, false);
  assert.equal(state.progress, 0);

  // Matching requestId=2 updates state
  state = reducer(
    state,
    syncPreviewEngine({
      requestId: 2,
      loading: false,
      playing: true,
      progress: 18,
      duration: 90,
      ended: false,
      level: 0.6,
    }),
  );
  assert.equal(state.playing, true);
  assert.equal(state.progress, 18);
  assert.equal(state.duration, 90);

  state = reducer(
    state,
    updatePreviewItemMeta({ title: "Cozy Tavern", parentTitle: "Village" }),
  );
  assert.equal(state.item.title, "Cozy Tavern");
  assert.equal(state.item.parentTitle, "Village");

  state = reducer(state, setPreviewVolume(1.5));
  assert.equal(state.volume, 1);
  state = reducer(state, setPreviewVolume(-0.2));
  assert.equal(state.volume, 0);
  state = reducer(state, setPreviewMuted(true));
  assert.equal(state.muted, true);
  state = reducer(state, setPreviewDuckLiveMonitor(false));
  assert.equal(state.duckLiveMonitor, false);

  state = reducer(state, clearPreview());
  assert.equal(state.item, null);
  assert.equal(state.playing, false);
  // Persisted preferences survive closing the preview deck
  assert.equal(state.muted, true);
  assert.equal(state.duckLiveMonitor, false);
});
