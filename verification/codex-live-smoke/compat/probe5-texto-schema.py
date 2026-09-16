"""¿Puede un hilo de TEXTO de Codex sustituir a POST /v1/responses con json_schema?
Mural lo usa para las evaluaciones del profesor (schema estricto), traducciones y lookup.
Aquí se manda un turno de texto con outputSchema y se revisa si vuelve JSON válido.
"""
import asyncio
import json
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "probe5-result"
OUT.mkdir(exist_ok=True)

SCHEMA = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["success", "partial", "breakdown", "uncertain"]},
        "suggestedLevel": {"type": "integer", "minimum": 0, "maximum": 5},
        "nextGoal": {"type": "string"},
        "words": {"type": "array", "maxItems": 5, "items": {
            "type": "object",
            "properties": {"lemma": {"type": "string"}, "meaning": {"type": "string"}},
            "required": ["lemma", "meaning"], "additionalProperties": False}},
    },
    "required": ["outcome", "suggestedLevel", "nextGoal", "words"],
    "additionalProperties": False,
}

INPUT = ("Evalúa esta réplica de un estudiante de español:\n"
         "Profesor: ¿Qué hiciste el fin de semana?\n"
         "Estudiante: Yo fui a la playa con mis amigo y comimos pescado muy rico.\n"
         "Devuelve la evaluación en el esquema pedido.")


async def main():
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")}
    env["RUST_LOG"] = "error"
    proc = await asyncio.create_subprocess_exec(
        "codex", "app-server", "--stdio", cwd=ROOT, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pending = {}; counter = {"n": 0}
    begun = time.monotonic()
    agent_text = []
    items = []
    turn_done = asyncio.Event()
    turn_result = {}

    def log(kind, **d):
        print(json.dumps({"t": round(time.monotonic() - begun, 2), "kind": kind, **d}, ensure_ascii=False)[:300], flush=True)

    async def rpc(method, params, timeout=120):
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
                await proc.stdin.drain()
                log("server_request_rejected", method=method)
                continue
            if method == "item/completed":
                it = p.get("item") or {}
                items.append(it.get("type"))
                if it.get("type") in ("agentMessage", "assistantMessage"):
                    txt = it.get("text") or it.get("content") or ""
                    if isinstance(txt, str) and txt:
                        agent_text.append(txt)
                        log("agent_message", chars=len(txt))
            elif method == "turn/completed":
                turn_result.update(p or {})
                log("turn_completed")
                turn_done.set()
            elif method == "error":
                log("error", message=json.dumps(p, ensure_ascii=False)[:200])
                turn_done.set()

    async def drain():
        while await proc.stderr.readline():
            pass

    t1 = asyncio.create_task(reader()); t2 = asyncio.create_task(drain())
    result = {}
    try:
        await rpc("initialize", {"clientInfo": {"name": "mural_probe5", "title": "probe5", "version": "0.1.0"},
                                 "capabilities": {"experimentalApi": True, "requestAttestation": False}})
        proc.stdin.write(b'{"method":"initialized"}\n'); await proc.stdin.drain()
        acc = await rpc("account/read", {"refreshToken": False})
        result["auth_type"] = (acc.get("account") or {}).get("type")
        thread = await rpc("thread/start", {
            "cwd": str(ROOT), "ephemeral": True, "approvalPolicy": "never", "sandbox": "read-only",
            "environments": [], "selectedCapabilityRoots": [],
            "baseInstructions": ("Eres un evaluador de aprendizaje de idiomas. No uses herramientas, "
                                 "no leas archivos, no ejecutes comandos. Responde solo con el JSON pedido.")})
        thread_id = thread["thread"]["id"]
        started = time.monotonic()
        await rpc("turn/start", {
            "threadId": thread_id,
            "input": [{"type": "text", "text": INPUT, "text_elements": []}],
            "outputSchema": SCHEMA,
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
        }, timeout=120)
        await asyncio.wait_for(turn_done.wait(), 120)
        result["seconds"] = round(time.monotonic() - started, 2)
        raw = "\n".join(agent_text).strip()
        result["raw_output"] = raw[:1500]
        result["item_types"] = items
        try:
            parsed = json.loads(raw)
            result["valid_json"] = True
            result["parsed"] = parsed
            keys = set(parsed) if isinstance(parsed, dict) else set()
            result["schema_keys_present"] = sorted(keys & set(SCHEMA["required"]))
            result["schema_complete"] = set(SCHEMA["required"]).issubset(keys)
        except Exception as exc:
            result["valid_json"] = False
            result["parse_error"] = str(exc)[:200]
        result["success"] = True
    except Exception as exc:
        result["success"] = False
        result["error"] = str(exc)[:400]
        log("failed", message=str(exc)[:300])
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.terminate(); await proc.wait()
        t1.cancel(); t2.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
        (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("\n===== HILO DE TEXTO CON outputSchema =====")
        print("auth:", result.get("auth_type"), "| segundos:", result.get("seconds"))
        print("JSON válido:", result.get("valid_json"), "| esquema completo:", result.get("schema_complete"))
        print("claves presentes:", result.get("schema_keys_present"))
        print("salida:", (result.get("raw_output") or result.get("error", ""))[:700])
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
