# Paridad entre `gpt-live-1` (API pública) y `gpt-live-1-codex` (Codex V3)

Pruebas corridas el 15 de septiembre de 2026 con Codex CLI 0.153.4, cuenta ChatGPT Plus,
sin ninguna API key (las sondas borran `OPENAI_API_KEY`, `CODEX_API_KEY` y
`CODEX_ACCESS_TOKEN` del entorno del proceso hijo).

**Contra qué se probó.** Las sondas no usan `experiments/live-web/server.mjs`. Cada una lanza
su propio `codex app-server --stdio` y le habla por JSON-RPC; los comandos de voz viajan por
el data channel WebRTC directo al backend de OpenAI. Los rechazos que aparecen abajo los
respondió OpenAI para el modelo `gpt-live-1-codex`, no un wrapper local.

> Estas conclusiones ya están implementadas en [`services/codex-proxy`](../../../services/codex-proxy/README.md)
> y consumidas por [`apps/web`](../../../apps/web/README.md). Un hallazgo posterior (16 de septiembre):
> con el prompt completo de Mural, el encuadre del preámbulo decide si el modelo actúa sobre una
> instrucción inyectada; el proxy usa la redacción verificada.

## Conclusión de arquitectura

Un proxy en el Mac puede controlar la sesión de voz **entera** por JSON-RPC, sin que la app
toque el dialecto V3 del data channel. El app-server expone exactamente seis métodos
experimentales de realtime (lista extraída del propio servidor, probe6):

| Método | Parámetros | Verificado |
|---|---|---|
| `thread/realtime/start` | `threadId`, `version`, `model`, `prompt`, `voice`, `initialItems`, `transport` | sí |
| `thread/realtime/appendText` | `threadId`, `text` | sí, el modelo respondió (probe7) |
| `thread/realtime/appendSpeech` | `threadId`, `text` | sí, el modelo respondió (probe7) |
| `thread/realtime/appendAudio` | `threadId`, `audio` | firma confirmada, no ejercitado |
| `thread/realtime/stop` | `threadId` | sí |
| `thread/realtime/listVoices` | ninguno | sí |

Las transcripciones llegan por notificaciones JSON-RPC `thread/realtime/transcript/delta` y
`thread/realtime/transcript/done`, así que el proxy las recibe sin depender del data channel.
Silenciar el micrófono es local en WebRTC (`track.enabled = false`), no necesita al servidor.

Con eso, el proxy puede exponer la **misma forma** que el API público: `POST live/sessions`
para crear la sesión, un canal de eventos con los nombres públicos (`session.input_transcript.delta`,
`session.output_transcript.delta`, `session.usage.updated`, `session.closed`) y los comandos
públicos (`session.commentary.append`, `session.thinking.append`, `session.close`). La app solo
cambia la URL base y por dónde le llegan los eventos, no los nombres ni la lógica.

## Qué sí hace `gpt-live-1-codex`

| Capacidad | Cómo se pide en V3 | Evidencia |
|---|---|---|
| Voz seleccionable | `voice` en `thread/realtime/start` | probe4 V2 habló en 2.6 s |
| Historial previo | `initialItems` con `role` y `text` | probe4 V3/V4 aceptados |
| Transcripción | data channel `output_transcript.added`, `turn.done`; JSON-RPC `transcript/delta` y `/done` | probe4, probe7 |
| Inyectar texto en vivo | JSON-RPC `appendText`; o data channel `session.context.append` con `content` array | probe7, probe4 |
| Pausar y reanudar micrófono | `input_audio.pause` / `input_audio.resume` | probe1 |
| Cierre limpio | JSON-RPC `stop` o data channel `session.close` | probe1, probe7 |
| Medición de uso | `session.usage.updated` con `audio_duration_ms` | probe1 |
| JSON estructurado de texto | `turn/start` con `outputSchema` | probe5, probe8, probe9 |

## Qué no hace o difiere

| Límite | Mensaje exacto del backend |
|---|---|
| Versión v2 no disponible | `AVAS realtime calls require realtime v1 or v3` |
| Voz `marin` no existe en v3 | `realtime voice 'marin' is not supported for v3; supported voices: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove` |
| Instrucciones no editables en vivo | `Instructions cannot be updated after initialization.` |
| `response.create` bloqueado | `requires a session with Responses delegation.` `clientManagedHandoffs: false` no la habilita. |
| Handoff voz→agente sin respuesta hablada | Con `clientManagedHandoffs: true` Codex corre el turno del agente pero NO devuelve la respuesta a la voz ("Let me check that." y silencio). Con `clientManagedHandoffs: false` + `codexResponseHandoffMode: "commentary"` la voz lee la respuesta (probe15, 15-sep-2026); con `"thinking"` queda como contexto mudo. |
| Historial suprime el saludo automático | Con `initialItems` el modelo espera al usuario en vez de hablar primero |
| Un comando inválido cierra la sesión | Codex emite `thread/realtime/closed` con `reason: error` |

`listVoices` reporta dos generaciones de voces. La generación "v2" incluye `marin` y `cedar`
pero ninguna versión de protocolo disponible la usa aquí.

## Latencia de los turnos de texto

Mismo prompt de evaluación con `outputSchema`, medido desde `turn/start` hasta `turn/completed`.

| Modelo y esfuerzo | Segundos | JSON válido |
|---|---|---|
| `gpt-6-astra`, effort high (config global de Codex) | 12.5 a 14.5 | sí |
| `gpt-6-astra`, effort low | 8.2 | sí |
| `gpt-6-astra`, effort minimal | 4.1 | no, esquema incompleto |
| `gpt-5.6-luna`, effort low (lo que usa Mural por API) | 5.6 a 10.1 | sí |
| `gpt-5.6-luna`, effort medium | 8.0 | sí |

El primer turno de cada proceso es más lento que el segundo. Desactivar los MCP servers con
`-c mcp_servers={}` no redujo la latencia. El resto del sobrecosto frente a una llamada directa
al API es el andamiaje del agente: instrucciones base de Codex, definiciones de herramientas y
razonamiento previo a la respuesta.

## Consumo de cuota

Plan Plus, ventana primaria de 300 minutos. Una sesión de unos 110 segundos movió la
ventana de 5 horas de 0 % a 1 %. La ventana semanal no se movió. El backend reporta el
porcentaje como entero, así que sesiones cortas no mueven el contador. `audio_duration_ms`
cuenta sesión abierta, no solo habla.

## Correr de nuevo

```sh
python3 -m venv .venv
.venv/bin/pip install aiortc==1.15.0 av==17.1.0
.venv/bin/python probe7-control-por-rpc.py
```

Cada corrida hace llamadas de voz reales y consume cuota de la cuenta. Ninguna sonda abre
el micrófono; todas mandan una pista de audio silenciosa. Ninguna modifica la configuración
ni los archivos de autenticación de Codex. `probe6-metodos-rpc.py` no abre sesión de voz y
no consume cuota.
