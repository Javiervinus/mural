"""¿Puede el PROXY controlar la sesión de voz sin tocar el data channel de la app?

Lista real de métodos realtime del app-server (extraída del propio servidor):
  thread/realtime/start, appendAudio, appendText, appendSpeech, stop, listVoices

Si `appendText` y `appendSpeech` funcionan por JSON-RPC, entonces el proxy puede:
  - inyectar contexto      (appendText  ~ session.thinking.append)
  - hacerlo hablar         (appendSpeech ~ session.commentary.append)
  - recibir transcripciones (notificaciones thread/realtime/transcript/*)
...y la app nunca necesita hablar el dialecto V3. Solo cambia POR DÓNDE le llegan
los eventos, no cómo se llaman.

Fase 1: descubrir la firma de cada método.
Fase 2: sesión real de voz, controlada SOLO por JSON-RPC, sin enviar nada por el data channel.
"""
import asyncio
import json
import os
import pathlib
import sys
import time

import av  # noqa: F401
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "probe7-result"
OUT.mkdir(exist_ok=True)
MODEL = "gpt-live-1-codex"


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pending = {}
    counter = {"n": 0}
    begun = time.monotonic()
    rpc_transcripts = []   # SOLO lo que llega por JSON-RPC (lo que vería el proxy)
    dc_events = []         # lo que llega por data channel (solo para comparar)
    sdp_ready = asyncio.Event(); dc_open = asyncio.Event(); closed = asyncio.Event()
    state = {"sdp": None, "thread_id": None}

    def log(kind, **d):
        print(json.dumps({"t": round(time.monotonic() - begun, 2), "kind": kind, **d}, ensure_ascii=False)[:280], flush=True)

    async def rpc(method, params, timeout=20):
        counter["n"] += 1
        rid = counter["n"]
        fut = asyncio.get_running_loop().create_future()
        pending[rid] = fut
        proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())
        await proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return ("timeout", {})
        finally:
            pending.pop(rid, None)

    async def reader():
        while line := await proc.stdout.readline():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if "id" in item and "method" not in item:
                fut = pending.get(item["id"])
                if fut and not fut.done():
                    fut.set_result(("error", item["error"]) if "error" in item else ("ok", item.get("result")))
                continue
            method = item.get("method", ""); p = item.get("params") or {}
            if "id" in item:
                proc.stdin.write((json.dumps({"id": item["id"], "error": {"code": -32601, "message": "probe"}}) + "\n").encode())
                await proc.stdin.drain(); continue
            if method == "thread/realtime/sdp":
                state["sdp"] = p["sdp"]; sdp_ready.set()
            elif method == "thread/realtime/closed":
                log("closed", reason=p.get("reason")); closed.set()
            elif method == "thread/realtime/error":
                log("rt_error", message=(p.get("message") or "")[:150])
            elif "transcript" in method:
                txt = p.get("text") or p.get("delta") or ""
                if txt:
                    rpc_transcripts.append({"method": method, "role": p.get("role", "?"), "text": txt})
                    if method.endswith("/done"):
                        log("transcript_done_rpc", role=p.get("role"), text=txt[:90])

    async def drain():
        while await proc.stderr.readline():
            pass

    t1 = asyncio.create_task(reader()); t2 = asyncio.create_task(drain())
    result = {}
    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe7", "title": "probe7", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        acc = await rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (acc[1].get("account") or {}).get("type") if acc[0] == "ok" else None

        # --- Fase 1: descubrir firmas (sin sesión activa; el error revela los campos) ---
        sig = {}
        for m in ["thread/realtime/appendText", "thread/realtime/appendSpeech", "thread/realtime/appendAudio"]:
            probe_params = {"threadId": "00000000-0000-0000-0000-000000000000"}
            kind, payload = await rpc(m, probe_params)
            sig[m] = {"con_solo_threadId": (payload or {}).get("message", "")[:200] if kind == "error" else kind}
            log("firma", method=m, msg=str(sig[m])[:160])
        result["signatures"] = sig

        # --- Fase 2: sesión real, controlada SOLO por JSON-RPC ---
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        channel = pc.createDataChannel("oai-events")
        channel.on("open")(lambda: (dc_open.set(), log("dc_open")))

        @channel.on("message")
        def on_msg(raw):
            try:
                ev = json.loads(raw)
            except (ValueError, TypeError):
                return
            dc_events.append(ev.get("type"))

        @pc.on("track")
        def on_track(track):
            async def sink():
                try:
                    while True:
                        await track.recv()
                except Exception:
                    pass
            asyncio.create_task(sink())

        kind, thread = await rpc("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": "Prueba de audio, sin herramientas.",
            "config": {"features.realtime_conversation": True}})
        state["thread_id"] = thread["thread"]["id"]
        pc.addTrack(AudioStreamTrack())
        await pc.setLocalDescription(await pc.createOffer())
        kind, _ = await rpc("thread/realtime/start", {
            "threadId": state["thread_id"], "version": "v3", "model": MODEL, "outputModality": "audio",
            "includeStartupContext": False, "clientManagedHandoffs": True,
            "prompt": ("Prueba en español. Al conectarte di solo: Listo. "
                       "Luego responde brevemente a lo que te llegue. No uses herramientas."),
            "voice": "cove",
            "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}})
        await asyncio.wait_for(sdp_ready.wait(), 25)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=state["sdp"], type="answer"))
        await asyncio.wait_for(dc_open.wait(), 20)
        await asyncio.sleep(6)
        result["greeting_via_rpc"] = [t for t in rpc_transcripts if t["method"].endswith("/done")]

        # appendText: inyectar un mensaje como si el usuario hablara (equivale a context/thinking)
        n = len(rpc_transcripts)
        kind, payload = await rpc("thread/realtime/appendText", {
            "threadId": state["thread_id"], "text": "¿De qué color es el cielo? Responde en tres palabras."})
        result["appendText"] = {"kind": kind, "payload": json.dumps(payload, ensure_ascii=False)[:250]}
        log("appendText", res=kind, payload=json.dumps(payload, ensure_ascii=False)[:150])
        await asyncio.sleep(9)
        result["appendText_respuesta"] = [t for t in rpc_transcripts[n:] if t["method"].endswith("/done")]

        # appendSpeech: hacer que diga algo textual (equivale a commentary.append)
        n = len(rpc_transcripts)
        kind, payload = await rpc("thread/realtime/appendSpeech", {
            "threadId": state["thread_id"], "text": "Esto lo dijo el proxy, no el usuario."})
        result["appendSpeech"] = {"kind": kind, "payload": json.dumps(payload, ensure_ascii=False)[:250]}
        log("appendSpeech", res=kind, payload=json.dumps(payload, ensure_ascii=False)[:150])
        await asyncio.sleep(9)
        result["appendSpeech_respuesta"] = [t for t in rpc_transcripts[n:] if t["method"].endswith("/done")]

        # stop por JSON-RPC, sin usar el data channel
        kind, _ = await rpc("thread/realtime/stop", {"threadId": state["thread_id"]}, timeout=8)
        try:
            await asyncio.wait_for(closed.wait(), 6)
            result["stop_via_rpc"] = "cerró"
        except asyncio.TimeoutError:
            result["stop_via_rpc"] = "no cerró en 6s"
        await pc.close()
        result["success"] = True
    except Exception as exc:
        result["success"] = False; result["error"] = str(exc)[:300]
        log("failed", message=str(exc)[:250])
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        t1.cancel(); t2.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
        result["todas_transcripciones_rpc"] = rpc_transcripts
        result["tipos_data_channel"] = sorted(set(x for x in dc_events if x))
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("\n===== ¿PUEDE EL PROXY CONTROLAR TODO POR JSON-RPC? =====")
        print("saludo recibido por JSON-RPC:", [t["text"][:60] for t in result.get("greeting_via_rpc", [])])
        print("appendText  ->", result.get("appendText"))
        print("  respuesta :", [t["text"][:70] for t in result.get("appendText_respuesta", [])])
        print("appendSpeech->", result.get("appendSpeech"))
        print("  respuesta :", [t["text"][:70] for t in result.get("appendSpeech_respuesta", [])])
        print("stop por JSON-RPC:", result.get("stop_via_rpc"))
        print("tipos vistos en data channel:", result.get("tipos_data_channel"))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
