#!/usr/bin/env python3
"""
Gemma 4 chat CLI using Google's OpenAI-compatible endpoint.

Reads configuration from environment variables:

  GEMMA_API_KEY          : your Google AI Studio / Gemini API key (required)
  GEMMA_BASE_URL         : override base URL
                           (default: https://generativelanguage.googleapis.com/v1beta/openai/)
  GEMMA_MODEL            : Gemma 4 model slug
                           (default: gemma-4-31b-it)
  GEMMA_TEMPERATURE      : float, e.g. 0.3 (optional)
  GEMMA_MAX_TOKENS       : int, e.g. 4096 (optional)
  GEMMA_THINKING_LEVEL   : "high" | "medium" | "low" | "minimal" — activate Gemma 4
                           chain-of-thought; omit to use model default (optional)
  SYSTEM_PROMPT          : system message to prepend (optional)
  PROMPT                 : prompt text if no CLI args provided (optional)
  OUTPUT_JSON            : set to 1 to print raw JSON response

Usage:
  python3 gemma_chat.py "Your prompt here"

Requires: pip install openai
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_bool(val: str | None) -> bool | None:
    if val is None:
        return None
    v = val.strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return None


def getenv_float(name: str) -> float | None:
    v = os.getenv(name)
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def getenv_int(name: str) -> int | None:
    v = os.getenv(name)
    if not v:
        return None
    try:
        return int(v)
    except ValueError:
        return None


def load_env_file() -> None:
    """Load environment variables from a .env file if present.

    Existing process-env values win; the file only sets variables that are
    currently unset (so shell exports always override .env values).

    Search order:
      1. Path given by the ENV_FILE environment variable (if set)
      2. .env in the current working directory
    """
    env_path = os.getenv("ENV_FILE")
    candidates: List[Path] = []
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.append(Path.cwd() / ".env")

    target: Path | None = next((p for p in candidates if p.exists()), None)
    if not target:
        return

    # Prefer python-dotenv when available.
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv(target, override=False)
        return
    except Exception:
        pass

    # Minimal fallback parser.
    try:
        for raw in target.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        return  # non-fatal


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    load_env_file()

    api_key = os.getenv("GEMMA_API_KEY", "").strip()
    if not api_key:
        sys.stderr.write(
            "Error: set GEMMA_API_KEY with your Google AI Studio key.\n"
            "  Get one at https://aistudio.google.com/app/apikey\n"
        )
        return 1

    base_url = os.getenv(
        "GEMMA_BASE_URL",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
    ).strip()
    model = os.getenv("GEMMA_MODEL", "gemma-4-31b-it").strip()
    temperature = getenv_float("GEMMA_TEMPERATURE")
    max_tokens = getenv_int("GEMMA_MAX_TOKENS")
    thinking_level = os.getenv("GEMMA_THINKING_LEVEL", "").strip() or None
    debug = os.getenv("GEMMA_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}

    # Prompt
    if len(sys.argv) > 1:
        prompt = " ".join(sys.argv[1:]).strip()
    else:
        prompt = os.getenv("PROMPT", "").strip()
        if not prompt:
            sys.stderr.write("Usage: python3 gemma_chat.py \"Your prompt here\"\n")
            return 64

    system_prompt = os.getenv("SYSTEM_PROMPT", "").strip()

    # Build messages
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    # Optional Gemma 4 thinking via extra_body
    extra_body: Dict[str, Any] = {}
    if thinking_level:
        valid = {"high", "medium", "low", "minimal"}
        if thinking_level.lower() not in valid:
            sys.stderr.write(
                f"Warning: GEMMA_THINKING_LEVEL='{thinking_level}' not in {valid}; ignoring.\n"
            )
        else:
            extra_body["google"] = {
                "thinking_config": {"thinking_level": thinking_level.lower()}
            }

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        sys.stderr.write("Missing dependency: pip install openai\n")
        return 2

    if debug:
        redacted = (api_key[:10] + "…") if len(api_key) > 10 else api_key
        sys.stderr.write(
            f"Debug: base_url={base_url}\n"
            f"       model={model}\n"
            f"       key_len={len(api_key)} prefix={redacted}\n"
            f"       thinking_level={thinking_level or '(default)'}\n"
        )

    client = OpenAI(api_key=api_key, base_url=base_url)

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_body=extra_body or None,
        )
    except Exception as e:
        err = str(e)
        # Retry via raw httpx POST if the SDK auth path failed.
        should_retry = (
            os.getenv("GEMMA_FORCE_HTTPX", "").strip().lower() in {"1", "true", "yes", "on"}
            or "401" in err
            or "No auth credentials" in err
        )
        if not should_retry:
            sys.stderr.write(f"Request failed: {e}\n")
            return 1

        try:
            import httpx  # type: ignore
        except ImportError:
            sys.stderr.write(f"Request failed: {e}\n")
            return 1

        if debug:
            sys.stderr.write("Debug: falling back to httpx POST /chat/completions\n")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload: Dict[str, Any] = {"model": model, "messages": messages}
        if extra_body:
            payload.update(extra_body)
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        try:
            r = httpx.post(
                base_url.rstrip("/") + "/chat/completions",
                headers=headers,
                json=payload,
                timeout=120,
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e2:
            sys.stderr.write(f"Request failed (httpx fallback): {e2}\n")
            return 1

        # Wrap httpx response in a duck-typed object to share the print logic.
        class _Msg:
            def __init__(self, content: str):
                self.content = content

        class _Choice:
            def __init__(self, message: _Msg):
                self.message = message

        class _Resp:
            def __init__(self, raw: Dict[str, Any]):
                self._raw = raw
                try:
                    content = raw["choices"][0]["message"]["content"]
                except Exception:
                    content = json.dumps(raw)
                self.choices = [_Choice(_Msg(content))]

            def model_dump_json(self, indent: int = 2) -> str:
                return json.dumps(self._raw, indent=indent)

        resp = _Resp(data)  # type: ignore[assignment]

    if os.getenv("OUTPUT_JSON") == "1":
        print(resp.model_dump_json(indent=2))
    else:
        try:
            content = resp.choices[0].message.content  # type: ignore[attr-defined]
        except Exception:
            content = None
        if content:
            print(content)
        else:
            print(resp.model_dump_json(indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
