#!/usr/bin/env python3
"""Build the static Desk replay for GitHub Pages.

    python3 tools/build-demo.py video/sessions/<session>.jsonl

Writes docs/demo/session.json (state changes, actions and scene marks; no ticks)
and copies desk/index.html to docs/demo/desk.html. The page is a replay of a
recorded live run: every transaction hash in it can be checked on Diana.
"""
import json, shutil, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1])
rows = [json.loads(l) for l in src.read_text().splitlines() if l.strip()]
meta = next(r for r in rows if r["type"] == "meta")
events = []
for r in rows:
    if r["type"] == "state":
        state = dict(r["state"], recording=False, busy=None)  # the replay itself is not recording
        events.append({"t": r["t"], "type": "state", "state": state})
    elif r["type"] == "mark":
        events.append({"t": r["t"], "type": "mark", "label": r["label"]})
    elif r["type"] in ("action-start", "action-end") and r.get("action") != "mark":
        e = {"t": r["t"], "type": r["type"], "action": r["action"]}
        if "result" in r:
            e["result"] = {k: v for k, v in r["result"].items() if k in ("hash", "code", "height", "error")}
        events.append(e)
end = max(r["t"] for r in rows)
out = root / "docs" / "demo"
out.mkdir(parents=True, exist_ok=True)
(out / "session.json").write_text(json.dumps({
    "meta": {k: meta[k] for k in ("started", "chainId", "rollupId")},
    "start": rows[0]["t"], "end": end, "events": events,
}, separators=(",", ":")))
shutil.copyfile(root / "desk" / "index.html", out / "desk.html")
print(f"{len(events)} events, {(out / 'session.json').stat().st_size} bytes -> {out}")
