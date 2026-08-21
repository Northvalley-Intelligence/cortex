#!/usr/bin/env python3
"""Probe whether the local Ollama runtime silently truncates oversized prompts.

Mission link: MISSION.md requires Cortex to enforce a context-window floor and fail
clearly instead of truncating. This probe checks whether the local provider's default
behaviour honours that. A PASS here means overflow is visible; a FAIL means Cortex
cannot trust provider defaults and must set and verify num_ctx per call.
"""
import json
import urllib.request

MODEL = "llama3.2:3b"
ENDPOINT = "http://localhost:11434/api/generate"
NEEDLE = "The secret passphrase is BLUE-HERON-42. Remember it.\n"
FILLER = "The quick brown fox jumps over the lazy dog. " * 1200


def probe(num_ctx=None):
    prompt = NEEDLE + FILLER + "\nWhat is the secret passphrase? Answer with just the passphrase."
    payload = {"model": MODEL, "prompt": prompt, "stream": False}
    if num_ctx:
        payload["options"] = {"num_ctx": num_ctx}
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    r = json.load(urllib.request.urlopen(req, timeout=300))
    return r.get("prompt_eval_count"), r.get("response", "")[:120]


if __name__ == "__main__":
    for ctx in (None, 16384):
        evaluated, answer = probe(ctx)
        recalled = "BLUE-HERON-42" in answer
        print(f"num_ctx={ctx or 'default'}: evaluated={evaluated} recalled_needle={recalled}")
        print(f"  answer: {answer!r}")
