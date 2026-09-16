"""Sonda de compatibilidad: ¿acepta gpt-live-1-codex (Codex V3) los comandos/eventos
del API público de GPT-Live que usa Mural? Sesión corta, pista de audio silenciosa,
sin micrófono. Guarda evidencia en probe-result/."""
import asyncio
import json
import os
import pathlib
import sys
import time
import uuid

import av  # noqa: F401  (aiortc lo necesita)
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "probe-result"
OUT.mkdir(exist_ok=True)

MODEL = os.environ.get("PROBE_MODEL", "gpt-live-1-codex")
VOICE = os.environ.get("PROBE_VOICE", "cove")  # `marin` (la de Mural) fue rechazada por V3 en la corrida 1
HISTORY = [
    {"role": "user", "text": "Mi color favorito es verde."},
    {"role": "assistant", "text": "¡Qué bien! El verde es un color muy bonito."},
]
PROMPT = (
    "Prueba técnica breve. Habla en español. Al conectarte di exactamente una frase: "
    "'Conexión lista. Tu color favorito es' seguido del color que aparece en la conversación previa. "
    "Después espera en silencio y obedece cualquier comentario que se te pida decir. "
    "No uses herramientas ni delegues tareas."
)

# Comandos del API público que Mural envía por el data channel (LiveTransport/ConversationCoordinator).
PUBLIC_COMMANDS = [
    ("session.input_audio.mute", {}),
    ("session.input_audio.unmute", {}),
    ("session.instructions.append", {"content": "A partir de ahora responde con frases muy cortas."}),
    ("session.thinking.append", {"content": "Dato de contexto: el usuario vive en Ecuador."}),
    ("session.commentary.append", {"content": "Di exactamente: prueba de comentario recibida."}),
]


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
    timeline = []            # todo lo observable, en orden
    dc_types = {}            # tipo de evento data channel -> {count, sample}
    rpc_methods = {}         # notificación JSON-RPC -> count
    transcripts = []
    acks = {}                # event_id -> evento de respuesta (ack o error)
    sdp_ready = asyncio.Event()
    realtime_error = asyncio.Event()
    last_error = {"message": None}
    dc_open = asyncio.Event()
    closed = asyncio.Event()
    turn_done = asyncio.Event()
    answer = {"sdp": None}
    thread_id = None
    marks = {"dc_open_at": None, "closed_at": None}
    limit_updates = []       # notificaciones account/rateLimits/updated durante la sesión

    def summarize_limits(snapshot):
        """Reduce una respuesta de account/rateLimits/read a {bucket: {primary%, secondary%}}."""
        out = {}
        if not isinstance(snapshot, dict):
            return out
        buckets = dict(snapshot.get("rateLimitsByLimitId") or {})
        buckets.setdefault("_default", snapshot.get("rateLimits"))
        for name, rl in buckets.items():
            if not isinstance(rl, dict):
                continue
            entry = {"planType": rl.get("planType")}
            for win in ("primary", "secondary"):
                w = rl.get(win) or {}
                entry[win] = {"usedPercent": w.get("usedPercent"), "windowDurationMins": w.get("windowDurationMins"), "resetsAt": w.get("resetsAt")}
            out[name] = entry
        return out

    def log(kind, **data):
        entry = {"t": round(time.monotonic() - begun, 3), "kind": kind, **data}
        timeline.append(entry)
        print(json.dumps(entry, ensure_ascii=False)[:400], flush=True)

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
            if "id" in item:  # petición del servidor (tools/approvals): rechazar
                proc.stdin.write((json.dumps({"id": item["id"], "error": {"code": -32601, "message": "probe"}}) + "\n").encode())
                await proc.stdin.drain()
                log("server_request_rejected", method=method)
                continue
            rpc_methods[method] = rpc_methods.get(method, 0) + 1
            if method == "thread/realtime/sdp":
                answer["sdp"] = p["sdp"]; sdp_ready.set(); log("rpc", method=method)
            elif method == "thread/realtime/closed":
                marks["closed_at"] = time.monotonic()
                log("rpc", method=method, reason=p.get("reason")); closed.set()
            elif method == "account/rateLimits/updated":
                limit_updates.append({"t": round(time.monotonic() - begun, 3), "limits": summarize_limits(p)})
                log("rpc", method=method, limits=json.dumps(limit_updates[-1]["limits"], ensure_ascii=False)[:300])
            elif method == "thread/realtime/error":
                last_error["message"] = p.get("message"); realtime_error.set()
                log("rpc", method=method, message=p.get("message"))
            elif method == "error":
                log("rpc", method=method, message=(p.get("error") or {}).get("message"))
            elif method.startswith("thread/realtime/"):
                log("rpc", method=method, params=json.dumps(p, ensure_ascii=False)[:200])

    async def drain_stderr():
        while await proc.stderr.readline():
            pass

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel = pc.createDataChannel("oai-events")

    @channel.on("open")
    def on_open():
        marks["dc_open_at"] = time.monotonic()
        log("dc_open"); dc_open.set()

    @channel.on("message")
    def on_message(raw):
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        t = ev.get("type", "?")
        slot = dc_types.setdefault(t, {"count": 0, "sample": None})
        slot["count"] += 1
        if slot["sample"] is None:
            slot["sample"] = json.dumps(ev, ensure_ascii=False)[:600]
        cid = ev.get("client_event_id") or (ev.get("error") or {}).get("client_event_id")
        if cid:
            acks[cid] = {"type": t, "raw": json.dumps(ev, ensure_ascii=False)[:500]}
        if t in ("output_transcript.added", "session.output_transcript.delta"):
            text = (ev.get("item") or {}).get("text") or ev.get("delta") or ""
            if text:
                transcripts.append(("assistant", text))
        if t == "turn.done":
            turn_done.set()
            tr = (ev.get("turn") or {}).get("transcript")
            if tr:
                transcripts.append(("turn:" + str((ev.get("turn") or {}).get("role")), tr))
        if t == "error":
            log("dc_error", raw=json.dumps(ev, ensure_ascii=False)[:400])
        else:
            log("dc", type=t)

    @pc.on("track")
    def on_track(track):
        log("remote_track", track_kind=track.kind)

        async def sink():
            try:
                while True:
                    await track.recv()
            except Exception:
                pass
        asyncio.create_task(sink())

    stdout_task = asyncio.create_task(reader())
    stderr_task = asyncio.create_task(drain_stderr())
    result = {"model": MODEL, "voice_requested": VOICE, "history_sent": True}

    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe", "title": "Mural probe", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        account = await rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (account.get("account") or {}).get("type")
        try:
            before = await rpc("account/rateLimits/read", {})
            result["limits_before"] = summarize_limits(before)
            log("limits_before", limits=json.dumps(result["limits_before"], ensure_ascii=False)[:300])
        except Exception as exc:
            result["limits_before_error"] = str(exc)[:200]
        async def new_thread():
            thread = await rpc("thread/start", {
                "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
                "environments": [], "selectedCapabilityRoots": [],
                "baseInstructions": "Prueba de audio. No uses herramientas ni accedas a archivos.",
                "config": {"features.realtime_conversation": True}})
            return thread["thread"]["id"]

        pc.addTrack(AudioStreamTrack())  # silencio
        await pc.setLocalDescription(await pc.createOffer())

        base = {"version": "v3", "model": MODEL, "outputModality": "audio",
                "includeStartupContext": False, "clientManagedHandoffs": True, "prompt": PROMPT,
                "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}}
        # Variantes: voz + historial (equivalentes a audio.output.voice e input del API público).
        attempts = [
            ("voice+initialItems", {**base, "voice": VOICE, "initialItems": HISTORY}),
            ("initialItems", {**base, "initialItems": HISTORY}),
            ("voice", {**base, "voice": VOICE}),
            ("base", base),
        ]
        result["start_attempts"] = []
        for name, params in attempts:
            thread_id = await new_thread()
            realtime_error.clear(); closed.clear()
            try:
                await rpc("thread/realtime/start", {**params, "threadId": thread_id})
            except Exception as exc:
                result["start_attempts"].append({"variant": name, "accepted": False, "error": str(exc)[:300]})
                log("realtime_start_rejected", variant=name, error=str(exc)[:200])
                continue
            # Aceptado a nivel RPC; el rechazo real llega asíncrono como thread/realtime/error.
            waiters = [asyncio.create_task(sdp_ready.wait()), asyncio.create_task(realtime_error.wait())]
            done, rest = await asyncio.wait(waiters, timeout=25, return_when=asyncio.FIRST_COMPLETED)
            for t in rest:
                t.cancel()
            if sdp_ready.is_set():
                result["start_attempts"].append({"variant": name, "accepted": True})
                result["start_variant_used"] = name
                log("realtime_start_accepted", variant=name)
                break
            err = last_error["message"] or "sin SDP en 25 s"
            result["start_attempts"].append({"variant": name, "accepted": False, "error": err[:300]})
            log("realtime_start_failed_async", variant=name, error=err[:200])
            try:
                await rpc("thread/realtime/stop", {"threadId": thread_id}, timeout=5)
            except Exception:
                pass
        else:
            raise RuntimeError("thread/realtime/start falló en todas las variantes: " + str(last_error["message"]))
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        await asyncio.wait_for(dc_open.wait(), 20)

        # Esperar a que termine el saludo (turn.done) o 15 s.
        try:
            await asyncio.wait_for(turn_done.wait(), 15)
        except asyncio.TimeoutError:
            log("greeting_timeout")

        # Probar cada comando público que Mural envía.
        result["commands"] = []
        for cmd, extra in PUBLIC_COMMANDS:
            eid = str(uuid.uuid4())
            channel.send(json.dumps({"type": cmd, "event_id": eid, **extra}))
            log("sent", type=cmd, event_id=eid)
            wait = 8 if cmd == "session.commentary.append" else 3
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline and eid not in acks:
                await asyncio.sleep(0.1)
            if cmd == "session.commentary.append":
                await asyncio.sleep(max(0, deadline - time.monotonic()))
            result["commands"].append({"command": cmd, "response": acks.get(eid, "sin respuesta (ni ack ni error)")})

        # Mantener la llamada viva un rato, con el modelo hablando, para que el consumo de cuota sea medible.
        hold = float(os.environ.get("PROBE_HOLD_SECONDS", "75"))
        hold_end = time.monotonic() + hold
        n = 0
        while time.monotonic() < hold_end:
            n += 1
            channel.send(json.dumps({"type": "session.commentary.append", "event_id": str(uuid.uuid4()),
                                     "content": f"Di una frase corta y distinta sobre el color verde, número {n}."}))
            log("hold_commentary", n=n)
            await asyncio.sleep(min(20, max(0, hold_end - time.monotonic())))

        # Cierre por data channel, como hace Mural (session.close).
        eid = str(uuid.uuid4())
        channel.send(json.dumps({"type": "session.close", "event_id": eid}))
        log("sent", type="session.close", event_id=eid)
        try:
            await asyncio.wait_for(closed.wait(), 6)
            result["session_close_via_data_channel"] = "cerró la sesión (thread/realtime/closed)"
        except asyncio.TimeoutError:
            result["session_close_via_data_channel"] = "NO cerró en 6 s; respuesta: " + json.dumps(acks.get(eid, "ninguna"), ensure_ascii=False)
        result["success"] = True
    except Exception as exc:
        result["success"] = False
        result["error"] = str(exc)[:500]
        log("probe_failed", message=str(exc)[:300])
    finally:
        if thread_id and not closed.is_set():
            try:
                await rpc("thread/realtime/stop", {"threadId": thread_id}, timeout=5)
                await asyncio.wait_for(closed.wait(), 5)
                result["fallback_stop"] = "thread/realtime/stop cerró la sesión"
            except Exception as exc:
                result["fallback_stop"] = f"{type(exc).__name__}: {exc}"[:200]
        await pc.close()
        # Medición de cuota: releer límites varias veces, el backend tarda en reflejar el consumo.
        if marks["dc_open_at"]:
            end = marks["closed_at"] or time.monotonic()
            result["voice_seconds"] = round(end - marks["dc_open_at"], 1)
        result["limits_after_reads"] = []
        for wait_s in (0, 10, 20, 30):
            await asyncio.sleep(wait_s)
            try:
                after = await rpc("account/rateLimits/read", {}, timeout=15)
                result["limits_after_reads"].append({"t": round(time.monotonic() - begun, 1), "limits": summarize_limits(after)})
                log("limits_after", limits=json.dumps(result["limits_after_reads"][-1]["limits"], ensure_ascii=False)[:300])
            except Exception as exc:
                result["limits_after_reads"].append({"t": round(time.monotonic() - begun, 1), "error": str(exc)[:200]})
        result["limit_updates_during_session"] = limit_updates
        # Delta por bucket y ventana, usando la última lectura válida.
        deltas = {}
        before_l = result.get("limits_before") or {}
        after_l = next((r["limits"] for r in reversed(result["limits_after_reads"]) if "limits" in r), {})
        for bucket, b in before_l.items():
            a = after_l.get(bucket) or {}
            deltas[bucket] = {}
            for win in ("primary", "secondary"):
                bp = (b.get(win) or {}).get("usedPercent"); ap = (a.get(win) or {}).get("usedPercent")
                if isinstance(bp, (int, float)) and isinstance(ap, (int, float)):
                    d = round(ap - bp, 3)
                    per_min = round(d * 60 / result["voice_seconds"], 3) if result.get("voice_seconds") else None
                    deltas[bucket][win] = {"before": bp, "after": ap, "delta_percent": d, "percent_per_voice_minute": per_min,
                                           "windowDurationMins": (b.get(win) or {}).get("windowDurationMins")}
        result["quota_deltas"] = deltas
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        stdout_task.cancel(); stderr_task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        result.update({
            "data_channel_event_types": dc_types,
            "rpc_notifications": rpc_methods,
            "transcripts": transcripts,
            "history_honored": any("verde" in t.lower() for _, t in transcripts),
            "commentary_spoken": any("comentario" in t.lower() for _, t in transcripts),
            "duration_seconds": round(time.monotonic() - begun, 3),
        })
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        (OUT / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n")
        print("\n=== RESULT ===\n" + json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
