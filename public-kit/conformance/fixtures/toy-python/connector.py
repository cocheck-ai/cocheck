# Toy notes connector in Python (standard library only): line-JSON over stdio. Methods: hello, diff({before, after}) over two notes-store state files.
# Same product and same answers as ../toy/connector.mjs, whatever the language.
import json
import sys


def read_state(path):
    with open(path, encoding="utf8") as f:
        raw = f.read()
    if raw.strip() == "":
        return {}  # a side that does not exist is an empty file
    state = json.loads(raw)
    if not isinstance(state, dict) or not isinstance(state.get("notes"), list):
        raise ValueError("not a notes state: " + path)
    return {n["id"]: n["text"] for n in state["notes"]}


def diff(before, after):
    b = read_state(before)
    a = read_state(after)
    changes = []
    for id_, value in a.items():
        if id_ not in b:
            changes.append({"id": id_, "mark": "added", "label": "Note " + id_, "after": value})
        elif b[id_] != value:
            changes.append({"id": id_, "mark": "changed", "label": "Note " + id_, "before": b[id_], "after": value})
    for id_, value in b.items():
        if id_ not in a:
            changes.append({"id": id_, "mark": "removed", "label": "Note " + id_, "before": value})
    return {"spec": "cocheck.changes/1", "changes": changes}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        try:
            if msg.get("method") == "hello":
                reply = {"result": {"spec": "cocheck.connector/1", "level": 1, "methods": ["diff"]}}
            elif msg.get("method") == "diff":
                reply = {"result": diff(msg["params"]["before"], msg["params"]["after"])}
            else:
                reply = {"error": {"code": "unknown-method", "message": str(msg.get("method"))}}
        except Exception as err:
            reply = {"error": {"code": "bad-product-response", "message": str(err)}}
        sys.stdout.write(json.dumps({"id": msg.get("id"), **reply}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


main()
