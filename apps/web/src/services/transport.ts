/**
 * Port of apps/ios/App/LiveTransport.swift for the browser.
 *
 * Audio always travels over WebRTC straight to OpenAI. Session events and commands use the
 * public vocabulary either way; they travel on the WebRTC data channel (OpenAI directly) or on
 * the WebSocket the Codex proxy names in its session response. The coordinator never knows which.
 */
import { APIClient, APIError, type Connection } from "./api";

export type ConnectionState = "idle" | "connecting" | "active" | "closing" | "ended" | "failed";

export type LiveEvent = Record<string, unknown> & { type: string };

export class TransportError extends Error {
  kind: "microphone" | "connection" | "timeout" | "insecure";
  constructor(kind: TransportError["kind"]) {
    super({
      microphone: "Allow microphone access in your browser or system settings to start a conversation.",
      connection: "The voice connection couldn’t be established. Check your connection and try again.",
      timeout: "The voice connection took too long. Please try again.",
      insecure: "The microphone needs a secure page. Open Mural from localhost, HTTPS or the desktop app.",
    }[kind]);
    this.kind = kind;
  }
}

interface EventChannel {
  send(event: LiveEvent): boolean;
  close(): void;
}

export class LiveTransport {
  onEvent: ((event: LiveEvent) => void) | null = null;
  onLevels: ((input: number, output: number) => void) | null = null;
  onFailure: ((message: string) => void) | null = null;
  readonly audio: HTMLAudioElement;
  private peer: RTCPeerConnection | null = null;
  private channel: EventChannel | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private inputMeter: (() => number) | null = null;
  private outputMeter: (() => number) | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private lastInput = 0;
  private lastOutput = 0;
  /** Events held back until the media path is up, so commands never race the WebRTC handshake. */
  private gateOpen = false;
  private held: LiveEvent[] = [];
  started = false;
  isMuted = false;
  private closing = false;

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "true");
    this.audio.hidden = true;
    document.body.append(this.audio);
  }

  async connect(api: APIClient, instructions: string, history: Array<Record<string, unknown>>): Promise<void> {
    this.disconnect();
    this.closing = false;
    this.attempt += 1;
    const token = this.attempt;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new TransportError("insecure");
    const connection = api.current();
    if (!connection || !connection.token) throw new APIError("missingKey");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch {
      throw new TransportError("microphone");
    }
    if (token !== this.attempt) { stream.getTracks().forEach((t) => t.stop()); throw new DOMException("cancelled", "AbortError"); }
    this.stream = stream;
    this.isMuted = false;
    const context = new AudioContext();
    this.context = context;
    void context.resume();
    this.inputMeter = analyser(context, stream);
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    const data = peer.createDataChannel("oai-events", { ordered: true });
    peer.ontrack = (event) => {
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.audio.srcObject = remote;
      this.outputMeter = analyser(context, remote);
      void this.audio.play().catch(() => undefined);
    };
    peer.onconnectionstatechange = () => {
      if (this.closing || peer !== this.peer) return;
      if (peer.connectionState === "failed") this.onFailure?.("The network connection was lost. Tap to start a new conversation.");
    };
    await peer.setLocalDescription(await peer.createOffer({ offerToReceiveAudio: true }));
    await iceComplete(peer, 5000);
    if (token !== this.attempt) throw new DOMException("cancelled", "AbortError");
    const offer = peer.localDescription?.sdp;
    if (!offer) throw new TransportError("connection");

    const result = await api.post("live/sessions", {
      session: {
        model: connection.liveModel,
        instructions,
        input: history,
        store: false,
        delegation: { type: "client" },
        audio: { output: { voice: connection.voice } },
      },
      transport: { type: "webrtc", sdp: offer },
    });
    if (token !== this.attempt) throw new DOMException("cancelled", "AbortError");
    const transport = result["transport"] as Record<string, unknown> | undefined;
    const answer = transport?.["sdp"];
    if (typeof answer !== "string") throw new TransportError("connection");
    const session = result["session"] as Record<string, unknown> | undefined;
    if (session) this.onEvent?.({ type: "mural.session.created", session });

    const events = result["events"] as Record<string, unknown> | undefined;
    if (events?.["type"] === "websocket" && typeof events["url"] === "string") {
      // The proxy delivers events itself. The data channel stays part of the negotiation and its
      // opening tells us the backend's media session is live, which is when the model can be addressed.
      this.channel = this.openWebSocket(events["url"], connection, token);
      // The backend announces on the data channel when its media session is live; only then can the model be addressed.
      data.onmessage = (message) => {
        try {
          if ((JSON.parse(String(message.data)) as { type?: string }).type === "session.started") this.openGate(token);
        } catch { /* not JSON */ }
      };
      data.onopen = () => { setTimeout(() => this.openGate(token), 3_000); };
    } else {
      this.gateOpen = true;
      this.channel = this.wrapDataChannel(data, token);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer });

    const deadline = Date.now() + 20_000;
    while (!this.started) {
      await sleep(100);
      if (token !== this.attempt) throw new DOMException("cancelled", "AbortError");
      if (Date.now() > deadline) throw new TransportError("timeout");
    }
    this.startMetering(token);
  }

  private receive(raw: string, token: number) {
    if (token !== this.attempt) return;
    let event: LiveEvent;
    try {
      event = JSON.parse(raw) as LiveEvent;
    } catch {
      return;
    }
    if (typeof event.type !== "string") return;
    if (!this.gateOpen && event.type !== "error" && event.type !== "session.closed") { this.held.push(event); return; }
    this.deliver(event);
  }

  private deliver(event: LiveEvent) {
    if (event.type === "session.started") this.started = true;
    this.onEvent?.(event);
  }

  private openGate(token: number) {
    if (token !== this.attempt || this.gateOpen) return;
    this.gateOpen = true;
    for (const event of this.held.splice(0)) this.deliver(event);
  }

  private wrapDataChannel(data: RTCDataChannel, token: number): EventChannel {
    data.onmessage = (message) => this.receive(String(message.data), token);
    data.onclose = () => {
      if (token !== this.attempt || this.closing) return;
      this.onFailure?.("The voice connection ended unexpectedly. Your conversation has been saved.");
    };
    return {
      send: (event) => {
        if (data.readyState !== "open") return false;
        data.send(JSON.stringify(event));
        return true;
      },
      close: () => { data.onmessage = null; data.onclose = null; data.close(); },
    };
  }

  private openWebSocket(url: string, connection: Connection, token: number): EventChannel {
    const target = new URL(url);
    target.searchParams.set("token", connection.token);
    const socket = new WebSocket(target.toString());
    const queue: string[] = [];
    socket.onopen = () => { for (const message of queue.splice(0)) socket.send(message); };
    socket.onmessage = (message) => this.receive(String(message.data), token);
    socket.onclose = (event) => {
      if (token !== this.attempt || this.closing) return;
      if (event.code === 1000) { this.onEvent?.({ type: "session.closed", reason: "events_closed" }); return; }
      this.onFailure?.("The connection to the proxy ended unexpectedly. Your conversation has been saved.");
    };
    socket.onerror = () => undefined;
    return {
      send: (event) => {
        const message = JSON.stringify(event);
        if (socket.readyState === WebSocket.OPEN) { socket.send(message); return true; }
        if (socket.readyState === WebSocket.CONNECTING) { queue.push(message); return true; }
        return false;
      },
      close: () => { socket.onmessage = null; socket.onclose = null; socket.close(); },
    };
  }

  send(event: LiveEvent): boolean {
    return this.channel?.send(event) ?? false;
  }

  mute(muted: boolean): void {
    this.isMuted = muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: crypto.randomUUID() });
  }

  close(): void {
    this.closing = true;
    this.isMuted = true;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.send({ type: "session.close", event_id: crypto.randomUUID() });
  }

  disconnect(): void {
    this.attempt += 1;
    this.closing = true;
    this.started = false;
    this.gateOpen = false;
    this.held = [];
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.channel?.close();
    this.channel = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); }
    this.peer = null;
    this.audio.pause();
    this.audio.srcObject = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.inputMeter = null;
    this.outputMeter = null;
    this.lastInput = 0;
    this.lastOutput = 0;
    this.onLevels?.(0, 0);
  }

  private startMetering(token: number) {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      if (token !== this.attempt || !this.started) return;
      const input = Math.min(1, (this.inputMeter?.() ?? 0) * 6);
      const output = Math.min(1, (this.outputMeter?.() ?? 0) * 6);
      this.lastInput = this.lastInput * 0.35 + input * 0.65;
      this.lastOutput = this.lastOutput * 0.35 + output * 0.65;
      this.onLevels?.(this.isMuted ? 0 : this.lastInput, this.lastOutput);
    }, 100);
  }
}

function analyser(context: AudioContext, stream: MediaStream): () => number {
  const node = context.createAnalyser();
  node.fftSize = 256;
  context.createMediaStreamSource(stream).connect(node);
  const buffer = new Uint8Array(node.fftSize);
  return () => {
    node.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const sample of buffer) { const x = (sample - 128) / 128; sum += x * x; }
    return Math.sqrt(sum / buffer.length);
  };
}

function iceComplete(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", change); resolve(); };
    const change = () => { if (peer.iceGatheringState === "complete") finish(); };
    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", change);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
