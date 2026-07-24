#!/usr/bin/env python3
"""Minimal SSE client for the Queen's /chat endpoint. Usage: chat.py "message" [sessionId]"""
import json
import sys
import urllib.request

msg = sys.argv[1]
body = {"message": msg, "customerId": "aiotlab"}
if len(sys.argv) > 2:
    body["sessionId"] = sys.argv[2]

req = urllib.request.Request(
    "http://localhost:4100/chat",
    data=json.dumps(body).encode(),
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(req, timeout=300) as resp:
    for raw in resp:
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue
        ev = json.loads(line[5:].strip())
        t = ev.get("type")
        if t == "session":
            print(f"[session {ev['sessionId']}]")
        elif t == "planner":
            print(f"[planner {ev['model']} tier{ev['tier']} -> {ev['decision']} ${ev['costUsd']:.4f}]")
        elif t == "plan":
            print(f"[plan] {ev['rationale']}")
            for tk in ev["tasks"]:
                print(f"   - {tk['key']}: {tk['title']} skills={tk['skills']} {tk['sensitivity']}")
        elif t == "task":
            extra = f"tier{ev.get('tier')} {ev.get('runtime')}/{(ev.get('model') or '').split(':')[0]} ${ev.get('costUsd') or 0:.4f}"
            print(f"[task {ev['key']}] {ev['phase']} {extra if ev['phase']!='submitted' else ''}".rstrip())
        elif t == "clarify":
            print(f"[clarify] {ev['question']}")
        elif t == "answer":
            print(f"[answer]\n{ev['text']}")
        elif t == "error":
            print(f"[error] {ev['message']}")
        elif t == "done":
            print("[done]")
