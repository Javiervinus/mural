"""Paridad de capacidad, ronda 2. Dos hallazgos de la ronda 1 guían esta prueba:
  - 'response.create requires a session with Responses delegation' => la capacidad EXISTE,
    está detrás del modo de delegación. clientManagedHandoffs=false debería habilitarla.
  - No llegó ninguna transcripción por el data channel => probablemente viajan por las
    notificaciones JSON-RPC del app-server (thread/realtime/transcript/*).

Corre DOS sesiones y captura TODO (data channel + JSON-RPC), sin mandar comandos
inválidos que maten la sesión:
  A) delegation de servidor (clientManagedHandoffs=false): probar response.item.create + response.create
  B) delegation de cliente (clientManagedHandoffs=true): sesión tranquila para ver de dónde salen las transcripciones
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
OUT = ROOT / "probe3-result"
OUT.mkdir(exist_ok=True)

MODEL = "gpt-live-1-codex"
VOICE = "cove"
HISTORY = [
    {"role": "user", "text": "Mi color favorito es verde."},
    {"role": "assistant", "text": "Anotado: tu color favorito es verde."},
]


class Session:
    def __init__(self, proc, label, client_managed):
        self.proc = proc
        self.label = label
        self.client_managed = client_managed
        self.pending = {}
        self.counter = 0
        self.dc_types = {}
        self.rpc_notifs = {}
        self.transcripts = []       # (origen, role, texto)
        self.errors = []
        self.sdp_ready = asyncio.Event()
        self.dc_open = asyncio.Event()
        self.closed = asyncio.Event()
        self.answer = None
        self.begun = time.monotonic()

    def log(self, kind, **d):
        print(json.dumps({"s": self.label, "t": round(time.monotonic() - self.begun, 2), "kind": kind, **d},
                         ensure_ascii=False)[:280], flush=True)

    async def rpc(self, method, params, timeout=25):
        self.counter += 1
        rid = f"{self.label}-{self.counter}"
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())
        await self.proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(rid, None)

    def on_rpc_notification(self, method, p):
        self.rpc_notifs[method] = self.rpc_notifs.get(method, 0) + 1
        if method == "thread/realtime/sdp":
            self.answer = p["sdp"]; self.sdp_ready.set()
        elif method == "thread/realtime/closed":
            self.log("realtime_closed", reason=p.get("reason")); self.closed.set()
        elif method == "thread/realtime/error":
            self.log("realtime_error", message=(p.get("message") or "")[:160])
        elif "transcript" in method:
            text = p.get("text") or p.get("delta") or ""
            role = p.get("role", "?")
            if text:
                self.transcripts.append(("rpc:" + method, role, text))
                self.log("transcript_rpc", method=method, role=role, text=text[:70])
        elif method.startswith("thread/realtime/"):
            self.log("rpc_other", method=method, params=json.dumps(p, ensure_ascii=False)[:150])

    def on_dc_message(self, raw):
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        t = ev.get("type", "?")
        slot = self.dc_types.setdefault(t, {"count": 0, "sample": None})
        slot["count"] += 1
        if slot["sample"] is None:
            slot["sample"] = json.dumps(ev, ensure_ascii=False)[:450]
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
                self.transcripts.append(("dc:" + t, role, text))
                self.log("transcript_dc", type=t, role=role, text=text[:70])
        if t == "error":
            self.errors.append(ev.get("error"))
            self.log("dc_error", msg=((ev.get("error") or {}).get("message") or "")[:140])


async def run_session(proc, reader_router, label, client_managed, prompt, commands, quiet_seconds):
    s = Session(proc, label, client_managed)
    reader_router[label] = s
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel = pc.createDataChannel("oai-events")

    @channel.on("open")
    def on_open():
        s.dc_open.set(); s.log("dc_open")

    @channel.on("message")
    def on_message(raw):
        s.on_dc_message(raw)

    @pc.on("track")
    def on_track(track):
        async def sink():
            try:
                while True:
                    await track.recv()
            except Exception:
                pass
        asyncio.create_task(sink())

    out = {"label": label, "clientManagedHandoffs": client_managed}
    thread_id = None
    try:
        thread = await s.rpc("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": "Prueba de audio, sin herramientas.",
            "config": {"features.realtime_conversation": True}})
        thread_id = thread["thread"]["id"]
        s.thread_id = thread_id
        pc.addTrack(AudioStreamTrack())
        await pc.setLocalDescription(await pc.createOffer())
        await s.rpc("thread/realtime/start", {
            "threadId": thread_id, "version": "v3", "model": MODEL, "outputModality": "audio",
            "includeStartupContext": False, "clientManagedHandoffs": client_managed,
            "prompt": prompt, "voice": VOICE, "initialItems": HISTORY,
            "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp}})
        await asyncio.wait_for(s.sdp_ready.wait(), 25)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=s.answer, type="answer"))
        await asyncio.wait_for(s.dc_open.wait(), 20)
        out["started"] = True

        # Escuchar en silencio para ver el saludo y de dónde salen las transcripciones.
        await asyncio.sleep(quiet_seconds)
        out["transcripts_after_greeting"] = list(s.transcripts)

        # Ejecutar los comandos de esta variante.
        out["commands"] = []
        for label_cmd, ev in commands:
            eid = str(uuid.uuid4())
            n_before = len(s.errors)
            n_tr = len(s.transcripts)
            channel.send(json.dumps({**ev, "event_id": eid}))
            s.log("sent", type=ev["type"], label=label_cmd)
            await asyncio.sleep(6)
            err = None
            for e in s.errors[n_before:]:
                if isinstance(e, dict):
                    err = (e.get("message") or "")[:200]; break
            out["commands"].append({"label": label_cmd, "type": ev["type"],
                                    "accepted": err is None, "error": err,
                                    "new_transcripts": s.transcripts[n_tr:][:3]})
        channel.send(json.dumps({"type": "session.close", "event_id": str(uuid.uuid4())}))
        try:
            await asyncio.wait_for(s.closed.wait(), 6)
            out["closed_cleanly"] = True
        except asyncio.TimeoutError:
            out["closed_cleanly"] = False
    except Exception as exc:
        out["error"] = str(exc)[:300]
        s.log("session_failed", message=str(exc)[:200])
    finally:
        if thread_id and not s.closed.is_set():
            try:
                await s.rpc("thread/realtime/stop", {"threadId": thread_id}, timeout=5)
            except Exception:
                pass
        await pc.close()
        out.update({"all_transcripts": s.transcripts, "dc_event_types": s.dc_types,
                    "rpc_notifications": s.rpc_notifs, "errors": s.errors})
    return out


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    router = {}
    boot = {"counter": 0, "pending": {}}

    async def reader():
        while line := await proc.stdout.readline():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if "id" in item and "method" not in item:
                rid = item["id"]
                fut = boot["pending"].pop(rid, None)
                if fut is None:
                    for s in router.values():
                        if rid in s.pending:
                            fut = s.pending.get(rid); break
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
            tid = p.get("threadId")
            target = None
            for s in router.values():
                if getattr(s, "thread_id", None) == tid:
                    target = s; break
            if target is None and len(router) == 1:
                target = next(iter(router.values()))
            if target:
                target.on_rpc_notification(method, p)

    async def boot_rpc(method, params, timeout=25):
        boot["counter"] += 1
        rid = f"boot-{boot['counter']}"
        fut = asyncio.get_running_loop().create_future()
        boot["pending"][rid] = fut
        proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())
        await proc.stdin.drain()
        return await asyncio.wait_for(fut, timeout)

    async def drain_stderr():
        while await proc.stderr.readline():
            pass

    stdout_task = asyncio.create_task(reader())
    stderr_task = asyncio.create_task(drain_stderr())
    result = {"model": MODEL}
    try:
        await boot_rpc("initialize", {"clientInfo": {"name": "mural_probe3", "title": "probe3", "version": "0.1.0"},
                                      "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        acc = await boot_rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (acc.get("account") or {}).get("type")

        prompt_a = ("Prueba en español. Al conectarte di una frase corta de saludo. "
                    "Luego responde a lo que te pidan por el canal de eventos. No uses herramientas.")
        cmds_a = [
            ("inyectar mensaje de usuario", {"type": "response.item.create",
                                             "item": {"type": "message", "role": "user",
                                                      "content": [{"type": "input_text",
                                                                   "text": "Di en una sola frase cuál es mi color favorito."}]}}),
            ("pedir respuesta hablada", {"type": "response.create"}),
            ("añadir contexto en vivo", {"type": "session.context.append",
                                         "content": "Dato: el usuario vive en Ecuador."}),
        ]
        result["A_responses_delegation"] = await run_session(
            proc, router, "A", False, prompt_a, cmds_a, quiet_seconds=12)

        await asyncio.sleep(2)
        prompt_b = ("Prueba en español. Al conectarte di una frase corta de saludo mencionando mi color favorito. "
                    "Después quédate en silencio. No uses herramientas.")
        cmds_b = [("añadir contexto en vivo", {"type": "session.context.append",
                                               "content": "Dato: el usuario vive en Ecuador."})]
        result["B_client_delegation"] = await run_session(
            proc, router, "B", True, prompt_b, cmds_b, quiet_seconds=14)
        result["success"] = True
    except Exception as exc:
        result["success"] = False
        result["error"] = str(exc)[:400]
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        stdout_task.cancel(); stderr_task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        for key in ("A_responses_delegation", "B_client_delegation"):
            r = result.get(key) or {}
            print(f"\n===== {key} (clientManagedHandoffs={r.get('clientManagedHandoffs')}) =====")
            print("iniciada:", r.get("started"), "| cierre limpio:", r.get("closed_cleanly"))
            for c in r.get("commands", []):
                print(f"  - {c['label']} [{c['type']}] -> {'ACEPTADO' if c['accepted'] else 'RECHAZADO: ' + str(c['error'])}")
                for t in c.get("new_transcripts", []):
                    print("      transcript:", t)
            print("  transcripciones totales:", len(r.get("all_transcripts", [])))
            for t in (r.get("all_transcripts") or [])[:6]:
                print("     ", t)
            print("  eventos data channel:", list((r.get("dc_event_types") or {}).keys()))
            print("  notificaciones JSON-RPC:", r.get("rpc_notifications"))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
