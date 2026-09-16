"""Aislar qué parámetro rompe el habla/transcripción en V3, y confirmar la inyección de
contexto en vivo con la forma correcta.

La prueba de humo conocida-buena NO pasaba `voice` ni `initialItems` y sí habló.
Mis pruebas pasaban ambos y el modelo nunca habló. Aquí se prueban 4 variantes cortas:
  V1 base            -> ni voice ni initialItems   (control, debe hablar)
  V2 voice           -> solo voice
  V3 initialItems    -> solo historial previo       (= campo `input` de la API pública)
  V4 ambos
En la variante que hable, además se prueba `session.context.append` con content como
array de objetos (la forma que exigió el backend) = equivalente a instructions/thinking.append.
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
OUT = ROOT / "probe4-result"
OUT.mkdir(exist_ok=True)
MODEL = "gpt-live-1-codex"
HISTORY = [
    {"role": "user", "text": "Mi color favorito es verde."},
    {"role": "assistant", "text": "Anotado: tu color favorito es verde."},
]
PROMPT = ("Prueba en español. Al conectarte di exactamente: Hola, la conexión funciona. "
          "Después quédate en silencio salvo que te pidan algo. No uses herramientas.")


async def variant(proc, rpc_boot, name, extra, try_context_append):
    state = {"sdp": None, "thread_id": None}
    sdp_ready = asyncio.Event(); dc_open = asyncio.Event(); closed = asyncio.Event()
    dc_types = {}; transcripts = []; errors = []; rpc_notifs = {}
    begun = time.monotonic()

    def log(kind, **d):
        print(json.dumps({"v": name, "t": round(time.monotonic() - begun, 2), "kind": kind, **d}, ensure_ascii=False)[:260], flush=True)

    def handle_rpc(method, p):
        rpc_notifs[method] = rpc_notifs.get(method, 0) + 1
        if method == "thread/realtime/sdp":
            state["sdp"] = p["sdp"]; sdp_ready.set()
        elif method == "thread/realtime/closed":
            log("closed", reason=p.get("reason")); closed.set()
        elif method == "thread/realtime/error":
            log("rt_error", message=(p.get("message") or "")[:150])
        elif "transcript" in method:
            txt = p.get("text") or p.get("delta") or ""
            if txt:
                transcripts.append(("rpc:" + method, p.get("role", "?"), txt))
                log("transcript_rpc", method=method, text=txt[:60])

    def handle_dc(raw):
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        t = ev.get("type", "?")
        slot = dc_types.setdefault(t, {"count": 0, "sample": None})
        slot["count"] += 1
        if slot["sample"] is None:
            slot["sample"] = json.dumps(ev, ensure_ascii=False)[:400]
        if "transcript" in t.lower() or t == "turn.done":
            txt = ""
            for path in (("item", "text"), ("turn", "transcript"), ("delta",), ("text",)):
                cur = ev
                for k in path:
                    cur = cur.get(k) if isinstance(cur, dict) else None
                if isinstance(cur, str) and cur.strip():
                    txt = cur; break
            if txt:
                role = ev.get("role") or (ev.get("item") or {}).get("role") or (ev.get("turn") or {}).get("role") or "?"
                transcripts.append(("dc:" + t, role, txt))
                log("transcript_dc", type=t, text=txt[:60])
        if t == "error":
            errors.append(ev.get("error"))
            log("dc_error", msg=((ev.get("error") or {}).get("message") or "")[:130])

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel = pc.createDataChannel("oai-events")
    channel.on("open")(lambda: (dc_open.set(), log("dc_open")))
    channel.on("message")(handle_dc)

    @pc.on("track")
    def on_track(track):
        async def sink():
            try:
                while True:
                    await track.recv()
            except Exception:
                pass
        asyncio.create_task(sink())

    out = {"variant": name, "extra_params": list(extra.keys())}
    try:
        thread = await rpc_boot("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": "Prueba de audio, sin herramientas.",
            "config": {"features.realtime_conversation": True}})
        state["thread_id"] = thread["thread"]["id"]
        handlers[state["thread_id"]] = handle_rpc
        pc.addTrack(AudioStreamTrack())
        await pc.setLocalDescription(await pc.createOffer())
        await rpc_boot("thread/realtime/start", {
            "threadId": state["thread_id"], "version": "v3", "model": MODEL, "outputModality": "audio",
            "includeStartupContext": False, "clientManagedHandoffs": True, "prompt": PROMPT,
            "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}, **extra})
        await asyncio.wait_for(sdp_ready.wait(), 25)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=state["sdp"], type="answer"))
        await asyncio.wait_for(dc_open.wait(), 20)
        # Esperar el saludo.
        for _ in range(28):
            if transcripts:
                break
            await asyncio.sleep(0.5)
        out["spoke"] = bool(transcripts)
        out["greeting_transcripts"] = list(transcripts)
        out["seconds_to_first_transcript"] = round(time.monotonic() - begun, 2) if transcripts else None

        if try_context_append and transcripts:
            n = len(errors)
            channel.send(json.dumps({"type": "session.context.append", "event_id": str(uuid.uuid4()),
                                     "content": [{"type": "input_text", "text": "Dato: el usuario vive en Ecuador."}]}))
            log("sent", type="session.context.append")
            await asyncio.sleep(5)
            err = next((((e or {}).get("message") or "")[:180] for e in errors[n:] if isinstance(e, dict)), None)
            out["context_append"] = {"accepted": err is None, "error": err}
    except Exception as exc:
        out["error"] = str(exc)[:250]
        log("failed", message=str(exc)[:200])
    finally:
        try:
            channel.send(json.dumps({"type": "session.close", "event_id": str(uuid.uuid4())}))
            await asyncio.wait_for(closed.wait(), 5)
        except Exception:
            if state["thread_id"] and not closed.is_set():
                try:
                    await rpc_boot("thread/realtime/stop", {"threadId": state["thread_id"]}, timeout=5)
                except Exception:
                    pass
        await pc.close()
        out.update({"dc_event_types": list(dc_types.keys()), "all_transcripts": transcripts,
                    "errors": errors, "rpc_notifications": rpc_notifs})
    return out


handlers = {}


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pending = {}; counter = {"n": 0}

    async def rpc(method, params, timeout=25):
        counter["n"] += 1
        rid = counter["n"]
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
            method = item.get("method", ""); p = item.get("params") or {}
            if "id" in item:
                proc.stdin.write((json.dumps({"id": item["id"], "error": {"code": -32601, "message": "probe"}}) + "\n").encode())
                await proc.stdin.drain(); continue
            h = handlers.get(p.get("threadId"))
            if h:
                h(method, p)

    async def drain():
        while await proc.stderr.readline():
            pass

    t1 = asyncio.create_task(reader()); t2 = asyncio.create_task(drain())
    result = {"model": MODEL}
    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe4", "title": "probe4", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        acc = await rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (acc.get("account") or {}).get("type")
        variants = [
            ("V1_base", {}, True),
            ("V2_voice", {"voice": "cove"}, False),
            ("V3_initialItems", {"initialItems": HISTORY}, False),
            ("V4_ambos", {"voice": "cove", "initialItems": HISTORY}, False),
        ]
        result["variants"] = []
        for name, extra, ctx in variants:
            result["variants"].append(await variant(proc, rpc, name, extra, ctx))
            await asyncio.sleep(2)
        result["success"] = True
    except Exception as exc:
        result["success"] = False; result["error"] = str(exc)[:300]
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        t1.cancel(); t2.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("\n===== RESUMEN =====")
        for v in result.get("variants", []):
            print(f"\n{v['variant']} (extra: {v['extra_params']})")
            print("  ¿habló?:", v.get("spoke"), "| seg. al primer transcript:", v.get("seconds_to_first_transcript"))
            for t in (v.get("greeting_transcripts") or [])[:3]:
                print("   ", t)
            print("  eventos DC:", v.get("dc_event_types"))
            rt = {k: c for k, c in (v.get("rpc_notifications") or {}).items() if "realtime" in k}
            print("  notif. realtime:", rt)
            if v.get("context_append"):
                print("  session.context.append:", v["context_append"])
            if v.get("errors"):
                print("  errores:", [((e or {}).get("message") or "")[:100] for e in v["errors"]][:3])
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
