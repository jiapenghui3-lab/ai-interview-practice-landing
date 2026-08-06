#!/usr/bin/env python3
"""End-to-end smoke test for Volcengine Realtime Dialogue.

Uses the vendor binary protocol and a 16 kHz mono PCM WAV input. Credentials
are read from the environment and are never written to disk.
"""

import argparse
import asyncio
import gzip
import json
import os
import struct
import uuid
import wave
from pathlib import Path

import websockets


URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"


def packet(event, payload, session_id=None, audio=False):
    raw = payload if audio else json.dumps(payload, ensure_ascii=False).encode()
    raw = gzip.compress(raw)
    message_type = 0x2 if audio else 0x1
    header = bytes((0x11, (message_type << 4) | 0x4, (0x0 if audio else 0x1) << 4 | 0x1, 0x00))
    optional = struct.pack(">I", event)
    if session_id is not None:
        encoded_id = session_id.encode()
        optional += struct.pack(">I", len(encoded_id)) + encoded_id
    return header + optional + struct.pack(">I", len(raw)) + raw


def parse_packet(data):
    if isinstance(data, str):
        raise RuntimeError(f"Expected binary frame, received text: {data[:300]}")
    message_type = data[1] >> 4
    flags = data[1] & 0x0F
    serialization = data[2] >> 4
    compression = data[2] & 0x0F
    offset = (data[0] & 0x0F) * 4
    result = {"message_type": message_type}
    if message_type == 0xF:
        result["error_code"] = int.from_bytes(data[offset:offset + 4], "big")
        offset += 4
    elif flags & 0x4:
        result["event"] = int.from_bytes(data[offset:offset + 4], "big")
        offset += 4
    if message_type in (0x9, 0xB):
        session_size = int.from_bytes(data[offset:offset + 4], "big")
        offset += 4
        result["session_id"] = data[offset:offset + session_size].decode(errors="replace")
        offset += session_size
    payload_size = int.from_bytes(data[offset:offset + 4], "big")
    offset += 4
    payload = data[offset:offset + payload_size]
    if compression == 0x1 and payload:
        payload = gzip.decompress(payload)
    if serialization == 0x1 and payload:
        payload = json.loads(payload.decode())
    result["payload"] = payload
    return result


async def receive_until(ws, terminal_events, timeout=30):
    audio = bytearray()
    transcript = []
    reply = []
    events = []
    while True:
        parsed = parse_packet(await asyncio.wait_for(ws.recv(), timeout))
        event = parsed.get("event")
        events.append(event)
        payload = parsed.get("payload")
        if parsed.get("error_code"):
            raise RuntimeError(f"Volcengine error {parsed['error_code']}: {payload}")
        if parsed["message_type"] == 0xB and isinstance(payload, bytes):
            audio.extend(payload)
        elif event == 451 and isinstance(payload, dict):
            transcript.extend(item.get("text", "") for item in payload.get("results", []) if not item.get("is_interim"))
        elif event == 550 and isinstance(payload, dict):
            reply.append(payload.get("content", ""))
        if event in terminal_events:
            return audio, transcript, reply, events


async def run(args):
    session_id = str(uuid.uuid4())
    connect_args = {"ping_interval": None, "max_size": None}
    if args.url == URL:
        connect_args["extra_headers"] = {
            "X-Api-App-ID": os.environ["DOUBAO_APP_ID"],
            "X-Api-Access-Key": os.environ["DOUBAO_ACCESS_KEY"],
            "X-Api-Resource-Id": "volc.speech.dialog",
            "X-Api-App-Key": os.environ["DOUBAO_APP_KEY_SECRET"],
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
    else:
        connect_args["origin"] = "https://jiapenghui3-lab.github.io"
    async with websockets.connect(args.url, **connect_args) as ws:
        await ws.send(packet(1, {}))
        connection = parse_packet(await asyncio.wait_for(ws.recv(), 10))
        if connection.get("event") != 50:
            raise RuntimeError(f"StartConnection failed: {connection}")

        start = {
            "asr": {"extra": {"end_smooth_window_ms": 2000}},
            "tts": {
                "speaker": "zh_male_yunzhou_jupiter_bigtts",
                "audio_config": {"channel": 1, "format": "pcm_s16le", "sample_rate": 24000},
            },
            "dialog": {
                "bot_name": "AI面试官",
                "system_role": "你是一名严谨的中文面试官，整场对话只能扮演面试官，绝不能代替候选人回答问题或编造候选人的经历。即使候选人反问你，也只需简短澄清后继续提出面试问题。核验简历真实性并判断能力是否匹配岗位。每次只问一个问题，同一主题最多追问两层。",
                "speaking_style": "专业、简短、自然，语速适中。",
                "extra": {"strict_audit": True, "recv_timeout": 30, "input_mod": "audio_file", "model": "1.2.1.1"},
            },
        }
        await ws.send(packet(100, start, session_id))
        session = parse_packet(await asyncio.wait_for(ws.recv(), 10))
        if session.get("event") != 150:
            raise RuntimeError(f"StartSession failed: {session}")

        with wave.open(str(args.input), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError("Input must be mono, PCM int16, 16 kHz WAV")
            frames_per_chunk = 320
            while chunk := wav.readframes(frames_per_chunk):
                await ws.send(packet(200, chunk, session_id, audio=True))
                await asyncio.sleep(frames_per_chunk / 16000)

        audio, transcript, reply, events = await receive_until(ws, {359}, timeout=45)
        args.output.write_bytes(audio)
        await ws.send(packet(102, {}, session_id))
        _, _, _, finish_events = await receive_until(ws, {152, 153}, timeout=10)
        if 153 in finish_events:
            raise RuntimeError("FinishSession failed with SessionFailed event")
        await ws.send(packet(2, {}))

    result = {
        "heard_text": "".join(transcript),
        "reply_text": "".join(reply),
        "audio_bytes": len(audio),
        "output": str(args.output),
        "events": [event for event in events if event is not None],
    }
    print(json.dumps(result, ensure_ascii=False))
    if not result["heard_text"] or not result["reply_text"] or not audio:
        raise RuntimeError("Smoke test did not prove both audio input and audio output")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=URL)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
