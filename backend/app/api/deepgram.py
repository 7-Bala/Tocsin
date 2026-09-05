"""
Deepgram live-transcription proxy.

Captures the OPERATOR's own voice for the evidence record. This is a separate
concern from Agora's ConvoAI pipeline: Agora's `composed_tools` pipeline already
uses Deepgram internally for the AGENT's own speech (see agora.py's module
docstring) via Agora-managed credentials, which never touch this codebase and
have no bearing on this file. What this endpoint captures is the human
commander's side of the conversation, previously attempted via the browser's
local Web Speech API (unreliable: discrete non-overlapping segments, no
growing-partial signal, and duplicate transcription against Agora's own RTM
stream -- see frontend/src/app/voice-test/page.tsx's TurnSettler history).

Why a server-side proxy rather than the browser talking to Deepgram directly:
the API key must never reach client-side JavaScript. This route is a thin
relay -- audio bytes forwarded one way, transcript JSON forwarded the other --
with the only privileged step (the Authorization header) happening here.

Official source: developers.deepgram.com, live-streaming reference, checked
2026-09-05. WebSocket URL wss://api.deepgram.com/v1/listen, header
`Authorization: Token <key>` (the `Token` scheme, not `Bearer`), server
messages shaped `{"type": "Results", "is_final": bool, "speech_final": bool,
"channel": {"alternatives": [{"transcript": "..."}]}}`.
"""

import logging
import os

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("tocsin.api.deepgram")
router = APIRouter(prefix="/api/deepgram", tags=["Deepgram"])

DEEPGRAM_LISTEN_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3"
    "&language=en"
    "&encoding=linear16"
    "&sample_rate=16000"
    "&interim_results=true"
    "&punctuate=true"
    "&smart_format=true"
    # Default endpointing is documented as a very short 10ms -- far shorter
    # than a natural mid-sentence breath, let alone this project's established
    # 2-second sentence-boundary convention (TurnSettler's stableMs everywhere
    # else). Raised here so Deepgram's own utterance boundary tracks a real
    # pause instead of a breath. The frontend's TurnSettler-based accumulation
    # is still the backstop -- see page.tsx -- not a redundant safety net.
    "&endpointing=2000"
    "&vad_events=true"
)


@router.websocket("/stream")
async def deepgram_stream_proxy(client_ws: WebSocket) -> None:
    """
    Relay raw PCM audio from the browser to Deepgram's live-streaming API, and
    relay Deepgram's transcript JSON back. Holds no state of its own -- one
    proxied connection per voice-test session, torn down when either side
    disconnects.
    """
    await client_ws.accept()

    api_key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not api_key:
        # Matches this project's convention of a visible, honest failure over a
        # silent one (see CLAUDE.md: "Integration failure must be visible").
        await client_ws.send_json({
            "type": "Error",
            "error": "DEEPGRAM_API_KEY is not configured on the backend.",
        })
        await client_ws.close(code=1011)
        return

    try:
        async with websockets.connect(
            DEEPGRAM_LISTEN_URL,
            additional_headers={"Authorization": f"Token {api_key}"},
        ) as dg_ws:
            logger.info("Deepgram stream proxy connected")

            async def browser_to_deepgram() -> None:
                try:
                    while True:
                        # receive_bytes() raises if a text frame ever arrives --
                        # confirmed live: it crashed the whole proxy on the
                        # first control message sent this way. The browser
                        # sends audio as binary and Deepgram control messages
                        # (e.g. its own "CloseStream") as text; both must be
                        # handled, not just the audio path.
                        message = await client_ws.receive()
                        if message.get("type") == "websocket.disconnect":
                            break
                        if (data := message.get("bytes")) is not None:
                            await dg_ws.send(data)
                        elif (text := message.get("text")) is not None:
                            await dg_ws.send(text)
                except (WebSocketDisconnect, ConnectionClosed):
                    pass
                finally:
                    # Deepgram's own close handshake, not just dropping the
                    # socket -- lets it flush any final in-flight transcript.
                    try:
                        await dg_ws.send('{"type": "CloseStream"}')
                    except ConnectionClosed:
                        pass

            async def deepgram_to_browser() -> None:
                try:
                    async for message in dg_ws:
                        if isinstance(message, (bytes, bytearray)):
                            continue  # Deepgram's control frames are text/JSON only
                        await client_ws.send_text(message)
                except ConnectionClosed:
                    pass

            forward_task = None
            try:
                import asyncio

                forward_task = asyncio.create_task(deepgram_to_browser())
                await browser_to_deepgram()
            finally:
                if forward_task:
                    forward_task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 -- must reach the client, not vanish server-side
        logger.error(f"Deepgram stream proxy error: {exc}")
        try:
            await client_ws.send_json({"type": "Error", "error": str(exc)})
        except Exception:  # noqa: BLE001 -- client socket may already be gone
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:  # noqa: BLE001
            pass
