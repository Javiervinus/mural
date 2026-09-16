"""Bounded Codex ChatGPT/WebRTC V3 smoke test; no API key or microphone."""
import asyncio
from array import array
import json
import os
import pathlib
import sys
import time
import wave

import av
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "result"
OUT.mkdir(exist_ok=True)


async def main():
    env = {k: v for k, v in os.environ.items() if k not in (
        "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pending = {}
    events = []
    counter = 0
    thread_id = None
    sdp_ready = asyncio.Event()
    failed = asyncio.Event()
    closed = asyncio.Event()
    voiced = asyncio.Event()
    answer = None
    errors = []
    transcripts = []
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    audio_tasks = []
    frames = 0
    audible_samples = 0
    first_audio_at = None
    begun = time.monotonic()
    wav = wave.open(str(OUT / "received.wav"), "wb")
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(24000)

    def log(event_name, **data):
        entry = {"seconds": round(time.monotonic() - begun, 3), "event": event_name, **data}
        events.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

    async def rpc(method, params, timeout=25):
        nonlocal counter
        counter += 1
        request_id = counter
        future = asyncio.get_running_loop().create_future()
        pending[request_id] = future
        proc.stdin.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
        await proc.stdin.drain()
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            pending.pop(request_id, None)

    async def reader():
        nonlocal answer
        while line := await proc.stdout.readline():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if "id" in item and "method" not in item:
                fut = pending.get(item["id"])
                if fut and not fut.done():
                    if "error" in item:
                        fut.set_exception(RuntimeError(json.dumps(item["error"])))
                    else:
                        fut.set_result(item.get("result"))
                continue
            method = item.get("method", "")
            p = item.get("params", {})
            if "id" in item:
                # No tool execution or approval is part of this audio test.
                proc.stdin.write((json.dumps({"id": item["id"], "error": {
                    "code": -32601, "message": "Unsupported in audio smoke test"}}) + "\n").encode())
                await proc.stdin.drain()
            if method == "thread/realtime/sdp":
                answer = p["sdp"]
                log("remote_sdp_received")
                sdp_ready.set()
            elif method == "thread/realtime/error":
                errors.append(p.get("message", "unknown"))
                log("realtime_error", message=errors[-1])
                failed.set()
            elif method == "thread/realtime/closed":
                log("realtime_closed", reason=p.get("reason"))
                closed.set()
            elif method == "thread/realtime/started":
                log("realtime_started", version=p.get("version"))
            elif method == "thread/realtime/transcriptDone":
                transcripts.append({"role": p.get("role"), "text": p.get("text")})
                log("transcript", **transcripts[-1])
            elif method == "error":
                message = p.get("error", {}).get("message", "unknown error")
                errors.append(message)
                log("error", message=message)
                failed.set()

    async def drain_stderr():
        # Drain without persisting diagnostics that can contain local configuration.
        while await proc.stderr.readline():
            pass

    async def consume(track):
        nonlocal frames, audible_samples, first_audio_at
        resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)
        try:
            while True:
                frame = await track.recv()
                for converted in resampler.resample(frame):
                    data = bytes(converted.planes[0])[:converted.samples * 2]
                    wav.writeframes(data)
                    frames += 1
                    audible_samples += sum(abs(sample) > 100 for sample in array("h", data))
                    if first_audio_at is None:
                        first_audio_at = round(time.monotonic() - begun, 3)
                        log("first_audio_frame", sample_rate=24000)
                    if audible_samples >= 12000:
                        voiced.set()
        except Exception as exc:
            if pc.connectionState not in ("closed", "failed"):
                log("audio_track_ended", reason=type(exc).__name__)

    @pc.on("track")
    def on_track(track):
        log("remote_track", kind=track.kind)
        if track.kind == "audio":
            audio_tasks.append(asyncio.create_task(consume(track)))

    @pc.on("connectionstatechange")
    async def on_connection():
        log("peer_state", state=pc.connectionState)

    channel = pc.createDataChannel("oai-events")

    @channel.on("open")
    def on_open():
        log("data_channel_open")

    @channel.on("message")
    def on_message(raw):
        try:
            item = json.loads(raw)
        except (ValueError, TypeError):
            return
        kind = item.get("type", "unknown")
        if kind == "output_transcript.added":
            text = item.get("item", {}).get("text", "")
            if text:
                transcripts.append({"role": "assistant", "text": text})
                log("audio_transcript", text=text)
        elif kind == "error":
            error = item.get("error", {})
            log("data_channel_error", message=error)
        elif kind in ("session.started", "turn.done", "delegation.created"):
            log("data_channel_event", type=kind)

    stdout_task = asyncio.create_task(reader())
    stderr_task = asyncio.create_task(drain_stderr())
    result = {"success": False, "api_key_used": False, "model": "gpt-live-1-codex", "transport": "webrtc", "version": "v3"}
    try:
        init = await rpc("initialize", {
            "clientInfo": {"name": "mural_audio_smoke", "title": "Mural audio smoke test", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        log("initialized")
        proc.stdin.write(b'{"method":"initialized"}\n')
        await proc.stdin.drain()
        account = await rpc("account/read", {"refreshToken": False})
        account_type = (account.get("account") or {}).get("type")
        result["auth_type"] = account_type
        log("authentication", type=account_type)
        if account_type != "chatgpt":
            raise RuntimeError("Smoke test requires saved ChatGPT authentication")
        thread = await rpc("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": "This is an audio connectivity test. Do not use any tools or access any files.",
            "config": {"features.realtime_conversation": True}})
        thread_id = thread["thread"]["id"]
        log("ephemeral_thread_created")
        # aiortc's base track produces silence; no device microphone is opened.
        pc.addTrack(AudioStreamTrack())
        await pc.setLocalDescription(await pc.createOffer())
        log("local_sdp_ready")
        await rpc("thread/realtime/start", {
            "threadId": thread_id, "version": "v3", "model": "gpt-live-1-codex",
            "outputModality": "audio", "includeStartupContext": False,
            "clientManagedHandoffs": True,
            "prompt": "Esta es una prueba breve de audio. Habla en español. Al conectarte, di exactamente: Hola Javier, la conexión de voz funciona. Después espera en silencio. No delegues tareas ni uses herramientas.",
            "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}})
        waiter = asyncio.create_task(sdp_ready.wait())
        error_waiter = asyncio.create_task(failed.wait())
        done, waiting = await asyncio.wait([waiter, error_waiter], timeout=25, return_when=asyncio.FIRST_COMPLETED)
        for task in waiting:
            task.cancel()
        if not sdp_ready.is_set():
            raise RuntimeError(errors[-1] if errors else "No remote SDP within 25 seconds")
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        await asyncio.wait_for(voiced.wait(), 25)
        # Keep a few seconds of the response, then close the call.
        await asyncio.sleep(4)
        result["success"] = True
    except Exception as exc:
        result["error"] = str(exc)
        log("test_failed", message=str(exc))
    finally:
        if thread_id:
            try:
                await rpc("thread/realtime/stop", {"threadId": thread_id}, timeout=5)
                await asyncio.wait_for(closed.wait(), 5)
            except Exception as exc:
                result["close_note"] = type(exc).__name__ + ": " + str(exc)
        await pc.close()
        for task in audio_tasks:
            task.cancel()
        await asyncio.gather(*audio_tasks, return_exceptions=True)
        wav.close()
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate()
            await proc.wait()
        stdout_task.cancel()
        stderr_task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        result.update({"audio_frames": frames, "audible_samples": audible_samples,
            "first_audio_seconds": first_audio_at, "closed_notification": closed.is_set(),
            "transcripts": transcripts, "duration_seconds": round(time.monotonic() - begun, 3)})
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        (OUT / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
