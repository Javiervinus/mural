"""Prueba de PARIDAD DE CAPACIDAD: ¿gpt-live-1-codex (V3), hablando SU dialecto correcto,
hace lo mismo que la API pública de GPT-Live? No mide nombres de la API vieja; usa los
comandos que el backend declaró soportados y verifica la CAPACIDAD.

Capacidades que Mural necesita y que aquí se comprueban una por una:
  1. arranque con voz + historial previo   -> initialItems + voice
  2. saludo hablado + transcripción         -> capturar eventos de transcript
  3. inyectar contexto/instrucciones vivas   -> session.update
  4. forzar que el modelo diga algo          -> response.create (equivale a commentary.append)
  5. pausar/reanudar micrófono               -> input_audio.pause / input_audio.resume
  6. cierre limpio                            -> session.close
Sin micrófono real: pista de audio silenciosa. Guarda evidencia en probe2-result/.
"""
import asyncio
import json
import os
import pathlib
import sys
import time
import uuid

import av  # noqa: F401
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "probe2-result"
OUT.mkdir(exist_ok=True)

MODEL = "gpt-live-1-codex"
VOICE = "cove"
HISTORY = [
    {"role": "user", "text": "Mi color favorito es verde."},
    {"role": "assistant", "text": "Anotado: tu color favorito es verde."},
]
PROMPT = ("Prueba técnica en español. Al conectarte, di una sola frase corta saludando. "
          "Luego obedece las órdenes que lleguen por el canal de eventos. No uses herramientas.")


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    begun = time.monotonic()
    pending = {}
    counter = 0
    dc_types = {}          # tipo evento data channel -> {count, sample}
    transcripts = []       # (fuente, texto)
    errors = []            # errores del data channel
    events_seq = []        # orden de tipos, para ver el flujo
    sdp_ready = asyncio.Event()
    dc_open = asyncio.Event()
    closed = asyncio.Event()
    answer = {"sdp": None}
    thread_id = None

    def log(kind, **d):
        print(json.dumps({"t": round(time.monotonic() - begun, 2), "kind": kind, **d}, ensure_ascii=False)[:300], flush=True)

    async def rpc(method, params, timeout=25):
        nonlocal counter
        counter += 1
        rid = counter
        fut = asyncio.get_running_loop().create_future()
        pending[rid] = fut
        proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())
        await proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout)
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
                    if "error" in item:
                        fut.set_exception(RuntimeError(json.dumps(item["error"], ensure_ascii=False)))
                    else:
                        fut.set_result(item.get("result"))
                continue
            method = item.get("method", "")
            p = item.get("params") or {}
            if "id" in item:
                proc.stdin.write((json.dumps({"id": item["id"], "error": {"code": -32601, "message": "probe"}}) + "\n").encode())
                await proc.stdin.drain()
                continue
            if method == "thread/realtime/sdp":
                answer["sdp"] = p["sdp"]; sdp_ready.set()
            elif method == "thread/realtime/closed":
                log("realtime_closed", reason=p.get("reason")); closed.set()
            elif method == "thread/realtime/error":
                log("realtime_error", message=p.get("message"))

    async def drain_stderr():
        while await proc.stderr.readline():
            pass

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel = pc.createDataChannel("oai-events")

    @channel.on("open")
    def on_open():
        dc_open.set(); log("dc_open")

    @channel.on("message")
    def on_message(raw):
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        t = ev.get("type", "?")
        events_seq.append(t)
        slot = dc_types.setdefault(t, {"count": 0, "sample": None})
        slot["count"] += 1
        if slot["sample"] is None:
            slot["sample"] = json.dumps(ev, ensure_ascii=False)[:500]
        # Recolectar cualquier cosa que parezca transcripción, sea cual sea el nombre.
        low = t.lower()
        if "transcript" in low or t == "turn.done":
            text = ""
            for path in (("item", "text"), ("turn", "transcript"), ("delta",), ("text",), ("transcript",)):
                cur = ev
                for k in path:
                    cur = cur.get(k) if isinstance(cur, dict) else None
                if isinstance(cur, str) and cur.strip():
                    text = cur; break
            role = ev.get("role") or (ev.get("item") or {}).get("role") or (ev.get("turn") or {}).get("role") or "?"
            if text:
                transcripts.append((f"{t}[{role}]", text))
                log("transcript", type=t, role=role, text=text[:80])
        if t == "error":
            errors.append(ev.get("error"))
            log("dc_error", msg=(ev.get("error") or {}).get("message", "")[:120])

    @pc.on("track")
    def on_track(track):
        async def sink():
            try:
                while True:
                    await track.recv()
            except Exception:
                pass
        asyncio.create_task(sink())

    stdout_task = asyncio.create_task(reader())
    stderr_task = asyncio.create_task(drain_stderr())
    caps = {}   # capacidad -> resultado

    async def send(ev, label):
        """Envía un evento y espera a ver si aparece un error que lo referencie."""
        eid = str(uuid.uuid4())
        ev = {**ev, "event_id": eid}
        before_errors = len(errors)
        channel.send(json.dumps(ev))
        log("sent", type=ev["type"], label=label)
        await asyncio.sleep(3.5)
        # ¿hubo un error nuevo que cite este comando?
        for e in errors[before_errors:]:
            if isinstance(e, dict) and (e.get("event_id") == eid or eid in json.dumps(e)):
                return {"accepted": False, "error": e.get("message", "")[:160]}
        return {"accepted": True}

    result = {"model": MODEL}
    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe2", "title": "probe2", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        acc = await rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (acc.get("account") or {}).get("type")
        thread = await rpc("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": "Prueba de audio, sin herramientas.",
            "config": {"features.realtime_conversation": True}})
        thread_id = thread["thread"]["id"]
        pc.addTrack(AudioStreamTrack())
        await pc.setLocalDescription(await pc.createOffer())
        await rpc("thread/realtime/start", {
            "threadId": thread_id, "version": "v3", "model": MODEL, "outputModality": "audio",
            "includeStartupContext": False, "clientManagedHandoffs": True, "prompt": PROMPT,
            "voice": VOICE, "initialItems": HISTORY,
            "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}})
        caps["1_start_voice_history"] = "OK (start aceptado con voice + initialItems)"
        await asyncio.wait_for(sdp_ready.wait(), 25)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        await asyncio.wait_for(dc_open.wait(), 20)

        # 2) Saludo hablado + transcripción: esperar a ver transcripts del arranque.
        await asyncio.sleep(9)
        greet = [x for x in transcripts]
        caps["2_greeting_transcript"] = f"OK, {len(greet)} segmento(s)" if greet else "sin transcript en 9s"

        # 3) Inyectar contexto en vivo (equivale a instructions/thinking.append).
        caps["3_session_update"] = await send(
            {"type": "session.update", "session": {"instructions": "Responde SIEMPRE en una sola frase muy corta."}},
            "session.update instructions")

        # 4) Forzar que hable bajo demanda (equivale a commentary.append): item + response.create.
        n_before = len(transcripts)
        r_item = await send({"type": "response.item.create",
                             "item": {"type": "message", "role": "user",
                                      "content": [{"type": "input_text", "text": "Di en una frase cuál es mi color favorito."}]}},
                            "response.item.create")
        r_resp = await send({"type": "response.create"}, "response.create")
        await asyncio.sleep(6)
        spoke = len(transcripts) > n_before
        caps["4_force_speak"] = {"item_create": r_item, "response_create": r_resp,
                                 "modelo_habló_después": spoke,
                                 "nuevos_transcripts": [t for t in transcripts[n_before:]][:4]}

        # 5) Pausar / reanudar micrófono (equivale a input_audio.mute/unmute).
        caps["5_mic_pause"] = await send({"type": "input_audio.pause"}, "input_audio.pause")
        caps["5_mic_resume"] = await send({"type": "input_audio.resume"}, "input_audio.resume")

        # 6) Cierre limpio.
        channel.send(json.dumps({"type": "session.close", "event_id": str(uuid.uuid4())}))
        log("sent", type="session.close", label="close")
        try:
            await asyncio.wait_for(closed.wait(), 6)
            caps["6_session_close"] = "OK (thread/realtime/closed)"
        except asyncio.TimeoutError:
            caps["6_session_close"] = "no cerró en 6s"
        result["success"] = True
    except Exception as exc:
        result["success"] = False
        result["error"] = str(exc)[:400]
        log("probe_failed", message=str(exc)[:300])
    finally:
        if thread_id and not closed.is_set():
            try:
                await rpc("thread/realtime/stop", {"threadId": thread_id}, timeout=5)
            except Exception:
                pass
        await pc.close()
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        stdout_task.cancel(); stderr_task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        result.update({"capabilities": caps, "all_transcripts": transcripts,
                       "data_channel_event_types": dc_types,
                       "event_sequence_unique": list(dict.fromkeys(events_seq)),
                       "errors": errors,
                       "duration_seconds": round(time.monotonic() - begun, 2)})
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("\n=== CAPACIDADES ===")
        for k, v in caps.items():
            print(k, "=>", json.dumps(v, ensure_ascii=False)[:400])
        print("\ntranscripts totales:", len(transcripts))
        print("tipos de evento vistos:", list(dc_types.keys()))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
