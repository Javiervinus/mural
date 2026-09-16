"""Dos preguntas abiertas:
  A) ¿La versión v2 del protocolo es peor que v3? ¿Acepta la voz `marin` de Mural?
  B) ¿Por qué el turno de texto tardó 14.5 s? Hipótesis: hereda del config global
     `model = gpt-6-astra` y `model_reasoning_effort = high`. Se mide con effort bajo.
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
OUT = ROOT / "probe8-result"
OUT.mkdir(exist_ok=True)
MODEL = "gpt-live-1-codex"

SCHEMA = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["success", "partial", "breakdown", "uncertain"]},
        "suggestedLevel": {"type": "integer", "minimum": 0, "maximum": 5},
        "nextGoal": {"type": "string"},
    },
    "required": ["outcome", "suggestedLevel", "nextGoal"],
    "additionalProperties": False,
}
TEXT_INPUT = ("Evalúa esta réplica de un estudiante de español:\n"
              "Profesor: ¿Qué hiciste el fin de semana?\n"
              "Estudiante: Yo fui a la playa con mis amigo y comimos pescado muy rico.\n"
              "Devuelve la evaluación en el esquema pedido.")


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
    routes = {}          # threadId -> callback de notificaciones
    turn_events = {}     # threadId -> {"done": Event, "text": []}

    def log(kind, **d):
        print(json.dumps({"t": round(time.monotonic() - begun, 2), "k": kind, **d}, ensure_ascii=False)[:260], flush=True)

    async def rpc(method, params, timeout=180):
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
            tid = p.get("threadId")
            cb = routes.get(tid)
            if cb:
                cb(method, p)
            te = turn_events.get(tid)
            if te:
                if method == "item/completed":
                    it = p.get("item") or {}
                    if it.get("type") in ("agentMessage", "assistantMessage"):
                        txt = it.get("text") or it.get("content") or ""
                        if isinstance(txt, str) and txt:
                            te["text"].append(txt)
                elif method == "turn/completed":
                    te["done"].set()
                elif method == "error":
                    te["error"] = json.dumps(p, ensure_ascii=False)[:200]
                    te["done"].set()

    async def drain():
        while await proc.stderr.readline():
            pass

    t1 = asyncio.create_task(reader()); t2 = asyncio.create_task(drain())
    result = {}
    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe8", "title": "probe8", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}}, timeout=30)
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()

        # ---------- A) versión v2 con la voz marin de Mural ----------
        async def voice_session(version, voice):
            out = {"version": version, "voice": voice}
            sdp_ready = asyncio.Event(); closed = asyncio.Event(); dc_open = asyncio.Event()
            st = {"sdp": None}
            transcripts = []; dc_types = set(); rt_error = {"msg": None}

            def cb(method, p):
                if method == "thread/realtime/sdp":
                    st["sdp"] = p["sdp"]; sdp_ready.set()
                elif method == "thread/realtime/closed":
                    closed.set()
                elif method == "thread/realtime/error":
                    rt_error["msg"] = p.get("message"); log("rt_error", v=version, msg=(p.get("message") or "")[:130])
                elif "transcript" in method and method.endswith("/done"):
                    txt = p.get("text") or ""
                    if txt:
                        transcripts.append(txt); log("transcript", v=version, text=txt[:70])

            kind, thread = await rpc("thread/start", {
                "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
                "environments": [], "selectedCapabilityRoots": [],
                "baseInstructions": "Prueba de audio, sin herramientas.",
                "config": {"features.realtime_conversation": True}}, timeout=30)
            if kind != "ok":
                out["error"] = str(thread)[:200]; return out
            tid = thread["thread"]["id"]
            routes[tid] = cb
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            ch = pc.createDataChannel("oai-events")
            ch.on("open")(lambda: dc_open.set())

            @ch.on("message")
            def on_msg(raw):
                try:
                    dc_types.add(json.loads(raw).get("type"))
                except (ValueError, TypeError):
                    pass

            @pc.on("track")
            def on_track(track):
                async def sink():
                    try:
                        while True:
                            await track.recv()
                    except Exception:
                        pass
                asyncio.create_task(sink())

            pc.addTrack(AudioStreamTrack())
            await pc.setLocalDescription(await pc.createOffer())
            kind, payload = await rpc("thread/realtime/start", {
                "threadId": tid, "version": version, "model": MODEL, "outputModality": "audio",
                "includeStartupContext": False, "clientManagedHandoffs": True,
                "prompt": "Prueba en español. Al conectarte di solo: Hola. Después silencio.",
                "voice": voice,
                "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}}, timeout=30)
            out["start_rpc"] = kind
            if kind != "ok":
                out["start_error"] = json.dumps(payload, ensure_ascii=False)[:250]
                await pc.close(); routes.pop(tid, None); return out
            try:
                await asyncio.wait_for(sdp_ready.wait(), 20)
                await pc.setRemoteDescription(RTCSessionDescription(sdp=st["sdp"], type="answer"))
                await asyncio.wait_for(dc_open.wait(), 15)
                await asyncio.sleep(8)
                out["spoke"] = bool(transcripts)
                out["transcripts"] = transcripts[:3]
            except asyncio.TimeoutError:
                out["spoke"] = False
                out["timeout"] = True
            out["realtime_error"] = rt_error["msg"]
            out["dc_types"] = sorted(x for x in dc_types if x)
            try:
                await rpc("thread/realtime/stop", {"threadId": tid}, timeout=8)
                await asyncio.wait_for(closed.wait(), 5)
            except Exception:
                pass
            await pc.close(); routes.pop(tid, None)
            return out

        result["v2_marin"] = await voice_session("v2", "marin")
        await asyncio.sleep(2)
        result["v3_marin"] = await voice_session("v3", "marin")
        await asyncio.sleep(2)

        # ---------- B) latencia del turno de texto según effort ----------
        async def text_turn(label, extra):
            kind, thread = await rpc("thread/start", {
                "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
                "environments": [], "selectedCapabilityRoots": [],
                "baseInstructions": ("Eres un evaluador de idiomas. No uses herramientas ni leas archivos. "
                                     "Responde solo el JSON pedido.")}, timeout=30)
            tid = thread["thread"]["id"]
            turn_events[tid] = {"done": asyncio.Event(), "text": []}
            started = time.monotonic()
            await rpc("turn/start", {
                "threadId": tid,
                "input": [{"type": "text", "text": TEXT_INPUT, "text_elements": []}],
                "outputSchema": SCHEMA, "approvalPolicy": "never",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False}, **extra}, timeout=180)
            try:
                await asyncio.wait_for(turn_events[tid]["done"].wait(), 180)
            except asyncio.TimeoutError:
                pass
            secs = round(time.monotonic() - started, 2)
            raw = "\n".join(turn_events[tid]["text"]).strip()
            ok = False
            try:
                parsed = json.loads(raw)
                ok = set(SCHEMA["required"]).issubset(set(parsed))
            except Exception:
                pass
            log("text_turn", label=label, seconds=secs, json_ok=ok)
            turn_events.pop(tid, None)
            return {"label": label, "extra": extra, "seconds": secs, "json_ok": ok, "chars": len(raw)}

        result["texto"] = []
        for label, extra in [
            ("config global (gpt-6-astra, effort high)", {}),
            ("effort low", {"effort": "low"}),
            ("effort minimal", {"effort": "minimal"}),
        ]:
            result["texto"].append(await text_turn(label, extra))
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
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("\n===== A) VERSIÓN v2 vs v3 con la voz marin =====")
        for k in ("v2_marin", "v3_marin"):
            r = result.get(k) or {}
            print(f"{k}: start={r.get('start_rpc')} habló={r.get('spoke')} error={str(r.get('realtime_error'))[:110]}")
            print("   transcripciones:", r.get("transcripts"))
            print("   eventos data channel:", r.get("dc_types"))
        print("\n===== B) LATENCIA DEL TURNO DE TEXTO =====")
        for t in result.get("texto", []):
            print(f"  {t['label']:42s} {t['seconds']:6.2f}s  json_ok={t['json_ok']}")
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
