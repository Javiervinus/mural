"""Descubrir qué métodos experimentales `thread/realtime/*` acepta el app-server.

Los métodos de realtime NO aparecen en el esquema generado (son experimentales), pero
`thread/realtime/start` y `/stop` sí funcionan. Se distingue así:
  - método inexistente  -> JSON-RPC -32601 "method not found"
  - método existente    -> otro error (-32600 campos faltantes, o error de estado)
No se abre ninguna sesión de voz: cero consumo de cuota.

Esto decide la arquitectura del proxy: si existe un método para ENVIAR eventos de la
sesión (mute, contexto, cierre), el proxy puede mediar TODO el control y la app no
necesita hablar el dialecto V3 en su data channel.
"""
import asyncio
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "probe6-result"
OUT.mkdir(exist_ok=True)

CANDIDATES = [
    # conocidos, como control positivo
    "thread/realtime/start",
    "thread/realtime/stop",
    # envío de eventos de sesión
    "thread/realtime/sendEvent",
    "thread/realtime/send",
    "thread/realtime/event",
    "thread/realtime/clientEvent",
    "thread/realtime/command",
    "thread/realtime/sendClientEvent",
    # audio de entrada (para transporte websocket)
    "thread/realtime/appendAudio",
    "thread/realtime/inputAudio/append",
    "thread/realtime/audio/append",
    "thread/realtime/inputAudio",
    # texto y contexto
    "thread/realtime/appendText",
    "thread/realtime/sendText",
    "thread/realtime/context/append",
    "thread/realtime/appendContext",
    # control de micrófono y turno
    "thread/realtime/mute",
    "thread/realtime/pause",
    "thread/realtime/interrupt",
    "thread/realtime/update",
    # varios
    "thread/realtime/status",
    "thread/realtime/read",
    "thread/realtime/voices",
    "thread/realtime/listVoices",
    # control negativo: no debe existir
    "thread/realtime/estoNoExiste",
]


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pending = {}
    counter = {"n": 0}

    async def rpc_raw(method, params, timeout=12):
        """Devuelve ('ok', result) o ('error', {code, message})."""
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
                    if "error" in item:
                        fut.set_result(("error", item["error"]))
                    else:
                        fut.set_result(("ok", item.get("result")))
                continue
            if "id" in item:
                proc.stdin.write((json.dumps({"id": item["id"], "error": {"code": -32601, "message": "probe"}}) + "\n").encode())
                await proc.stdin.drain()

    async def drain():
        while await proc.stderr.readline():
            pass

    t1 = asyncio.create_task(reader()); t2 = asyncio.create_task(drain())
    findings = []
    try:
        await rpc_raw("initialize", {"clientInfo": {"name": "mural_probe6", "title": "probe6", "version": "0.1.0"},
                                     "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        for method in CANDIDATES:
            kind, payload = await rpc_raw(method, {})
            code = payload.get("code") if isinstance(payload, dict) else None
            msg = (payload.get("message") if isinstance(payload, dict) else "") or ""
            # -32601 = method not found => no existe. Cualquier otro error => existe.
            exists = not (code == -32601 and "not found" in msg.lower() or code == -32601 and "method" in msg.lower())
            if kind == "ok":
                exists = True
            findings.append({"method": method, "exists": exists, "code": code, "message": msg[:200], "kind": kind})
            mark = "EXISTE " if exists else "no     "
            print(f"{mark} {method:42s} code={code} {msg[:110]}", flush=True)
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        t1.cancel(); t2.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
        (OUT / "result.json").write_text(json.dumps(findings, ensure_ascii=False, indent=2) + "\n")
        existing = [f["method"] for f in findings if f["exists"]]
        print("\n=== MÉTODOS QUE EXISTEN ===")
        for m in existing:
            print(" -", m)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
