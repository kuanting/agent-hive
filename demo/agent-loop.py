#!/usr/bin/env python3
"""One agent loop against the hive, the way a real client would run one.

    python3 demo/agent-loop.py LM358N [customerId]

Declares two tools, posts a chat completion, executes whatever the model asks for
*itself*, appends the results and posts again — the loop any OpenAI client runs.
The hive never runs these tools: a caller's `digikey_search` searches the
caller's world, so tool calls come back for the caller to execute. That is the
whole reason this file exists rather than a `--tools` flag on the hive.

What it leaves behind is the point. Every turn is a task, the tool calls are
recorded in call order, and the turns of one loop share a loopId — so afterwards
`npm run breed -- flows` can say that this procedure ran, how often, and what it
cost, without anyone having instrumented anything.

Standard library only, like demo/chat.py.
"""
import json
import sys
import urllib.request

QUEEN = "http://localhost:4100"
MODEL = "hive/auto"

# The caller's own tools. Deliberately a different vocabulary from the hive's
# `digikey-price`: these are the client's, and the hive cannot know that
# `digikey_search` means a part database rather than somebody's filesystem.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "digikey_search",
            "description": "Find a distributor SKU for a manufacturer part number.",
            "parameters": {
                "type": "object",
                "properties": {"part": {"type": "string"}},
                "required": ["part"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_price",
            "description": "Current unit price and stock for a distributor SKU.",
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string"}},
                "required": ["sku"],
            },
        },
    },
]

# The caller's own data, which is exactly the point: this lives on the client.
CATALOG = {
    "LM358N": "296-1395-5-ND",
    "NE555P": "296-1857-5-ND",
    "ATMEGA328P-PU": "ATMEGA328P-PU-ND",
    "STM32F103C8T6": "497-6063-ND",
    "ESP32-WROOM-32E": "1965-ESP32-WROOM-32E-ND",
    "RC0402FR-0710KL": "311-10.0KLRCT-ND",
    "GRM188R71H104KA93D": "490-1524-1-ND",
    "1N4148": "1N4148FS-ND",
    "IRLZ44N": "IRLZ44NPBF-ND",
    "MCP3008-I/P": "MCP3008-I/P-ND",
    "DS18B20": "DS18B20+-ND",
    "SN74HC595N": "296-1600-5-ND",
}


def run_tool(name, args):
    """The caller executing its own tools, on the caller's machine."""
    if name == "digikey_search":
        sku = CATALOG.get(str(args.get("part", "")).upper())
        return json.dumps({"sku": sku} if sku else {"error": "not found"})
    if name == "get_price":
        return json.dumps({"sku": args.get("sku"), "usd": 2.41, "stock": 4132})
    return json.dumps({"error": "unknown tool"})


def post(messages, customer):
    body = json.dumps(
        {"model": MODEL, "messages": messages, "tools": TOOLS, "user": "demo-buyer", "customerId": customer}
    ).encode()
    req = urllib.request.Request(
        f"{QUEEN}/v1/chat/completions", data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main():
    part = sys.argv[1] if len(sys.argv) > 1 else "LM358N"
    customer = sys.argv[2] if len(sys.argv) > 2 else "breeder"
    messages = [{"role": "user", "content": f"What does a {part} cost right now?"}]

    for turn in range(1, 5):
        try:
            res = post(messages, customer)
        except Exception as e:  # noqa: BLE001 - a demo says what went wrong and stops
            print(f"   turn {turn}: {e}")
            return 1

        choice = res["choices"][0]
        hive = choice.get("x_hive") or res.get("x_hive") or {}
        calls = choice["message"].get("tool_calls") or []
        print(
            "   turn %d: tier=%s model=%s $%.4f %s"
            % (
                turn,
                hive.get("tier", "?"),
                hive.get("model") or hive.get("runtime", "?"),
                hive.get("cost_usd", 0.0),
                ("-> " + ", ".join(c["function"]["name"] for c in calls)) if calls else "-> answer",
            )
        )

        if not calls:
            text = (choice["message"].get("content") or "").strip()
            if text:
                print("   " + text.splitlines()[0][:120])
            return 0

        # The caller runs its own tools and hands the results back.
        messages.append({"role": "assistant", "content": "", "tool_calls": calls})
        for c in calls:
            args = json.loads(c["function"]["arguments"] or "{}")
            messages.append(
                {"role": "tool", "tool_call_id": c["id"], "content": run_tool(c["function"]["name"], args)}
            )

    print("   (loop did not converge in 4 turns)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
