#!/usr/bin/env python3
"""
Simple OpenRouter chat script using the OpenAI Python SDK.

Reads configuration from environment variables:

- OPENAI_API_KEY or OPENROUTER_API_KEY: your OpenRouter API key (required)
- OPENROUTER_BASE_URL: override base URL (default: https://openrouter.ai/api/v1)
- OPENROUTER_MODEL: model slug (default: openai/gpt-oss-120b)
- OPENROUTER_SITE_URL: sets HTTP-Referer header (recommended by OpenRouter)
- OPENROUTER_APP_NAME: sets X-Title header (recommended by OpenRouter)
- OPENROUTER_ORDER: comma-separated provider order (optional)
- OPENROUTER_ALLOW_FALLBACKS: true/false (optional)
- OPENROUTER_ROUTE_JSON: JSON string for advanced routing (optional)
- OPENROUTER_TEMPERATURE: float (optional)
- OPENROUTER_MAX_TOKENS: int (optional)
- SYSTEM_PROMPT: system message to prepend (optional)
- PROMPT: prompt text if no CLI args provided (optional)
- OUTPUT_JSON: when set to 1, prints raw JSON response

Usage:
  python3 openrouter_chat.py "Your prompt here"

Requires: pip install openai
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List


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

    Precedence: existing process env wins. This loader only sets vars that are
    currently unset, to allow shell exports to override file values.
    
    Order:
      1. ENV_FILE env var path (if set)
      2. .env in CWD (if present)
    """
    # Use python-dotenv if available; otherwise use a tiny fallback parser.
    env_path = os.getenv("ENV_FILE")
    candidate_paths: List[Path] = []
    if env_path:
        candidate_paths.append(Path(env_path).expanduser())
    candidate_paths.append(Path.cwd() / ".env")

    target: Path | None = next((p for p in candidate_paths if p.exists()), None)
    if not target:
        return

    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(target, override=False)
        return
    except Exception:
        pass

    # Fallback simple parser
    try:
        for raw in target.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            # Strip surrounding quotes if present
            if (value.startswith("\"") and value.endswith("\"")) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        # Non-fatal: ignore parse errors
        return


def main() -> int:
    # Load .env if present
    load_env_file()
    # Mirror key variables so either name works
    if ("OPENROUTER_API_KEY" not in os.environ) and os.getenv("OPENAI_API_KEY"):
        os.environ["OPENROUTER_API_KEY"] = os.getenv("OPENAI_API_KEY", "")
    if ("OPENAI_API_KEY" not in os.environ) and os.getenv("OPENROUTER_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.getenv("OPENROUTER_API_KEY", "")
    try:
        from openai import OpenAI  # type: ignore
    except Exception as e:  # pragma: no cover
        sys.stderr.write(
            "Missing dependency: install the OpenAI SDK with 'pip install openai'\n"
        )
        return 2

    # Base configuration
    api_key = (os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        sys.stderr.write(
            "Error: set OPENAI_API_KEY (or OPENROUTER_API_KEY) with your OpenRouter key.\n"
        )
        return 1

    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    model = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-120b")

    # Prompt handling
    if len(sys.argv) > 1:
        prompt = " ".join(sys.argv[1:]).strip()
    else:
        prompt = (os.getenv("PROMPT") or "").strip()
        if not prompt:
            sys.stderr.write(
                "Usage: python3 openrouter_chat.py \"Your prompt here\"\n"
            )
            return 64

    system_prompt = os.getenv("SYSTEM_PROMPT", "")
    debug = os.getenv("OPENROUTER_DEBUG") in {"1", "true", "TRUE", "yes", "on"}

    # Optional headers recommended by OpenRouter
    site_url = os.getenv("OPENROUTER_SITE_URL")
    app_name = os.getenv("OPENROUTER_APP_NAME")
    extra_headers: Dict[str, str] = {}
    if site_url:
        extra_headers["HTTP-Referer"] = site_url
    if app_name:
        extra_headers["X-Title"] = app_name

    # Optional provider routing metadata
    extra_body: Dict[str, Any] = {}
    order_csv = os.getenv("OPENROUTER_ORDER")
    allow_fallbacks = parse_bool(os.getenv("OPENROUTER_ALLOW_FALLBACKS"))
    route_json = os.getenv("OPENROUTER_ROUTE_JSON")
    if order_csv or allow_fallbacks is not None:
        provider: Dict[str, Any] = {}
        if order_csv:
            provider["order"] = [s.strip() for s in order_csv.split(",") if s.strip()]
        if allow_fallbacks is not None:
            provider["allow_fallbacks"] = allow_fallbacks
        extra_body["provider"] = provider
    if route_json:
        try:
            extra_body["route"] = json.loads(route_json)
        except json.JSONDecodeError:
            sys.stderr.write("Warning: OPENROUTER_ROUTE_JSON is not valid JSON; ignoring.\n")

    # Optional generation params
    temperature = getenv_float("OPENROUTER_TEMPERATURE")
    max_tokens = getenv_int("OPENROUTER_MAX_TOKENS")

    # Always include Authorization in case the SDK/environment combo fails to attach it
    extra_headers["Authorization"] = f"Bearer {api_key}"

    client = OpenAI(base_url=base_url, api_key=api_key)

    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    try:
        if debug:
            key_source = "OPENROUTER_API_KEY" if os.getenv("OPENROUTER_API_KEY") else "OPENAI_API_KEY"
            redacted = (api_key[:10] + "…") if len(api_key) > 10 else api_key
            sys.stderr.write(
                "Debug: making request with settings\n"
                f"  base_url={base_url}\n"
                f"  model={model}\n"
                f"  key_source={key_source} key_len={len(api_key)} prefix={redacted}\n"
                f"  site_header={'set' if 'HTTP-Referer' in extra_headers else 'absent'}\n"
                f"  app_header={'set' if 'X-Title' in extra_headers else 'absent'}\n"
                f"  auth_header={'set' if 'Authorization' in extra_headers else 'absent'}\n"
            )

        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            extra_headers=extra_headers if extra_headers else None,
            extra_body=extra_body if extra_body else None,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except Exception as e:  # pragma: no cover
        # Fall back to a direct HTTP call if the SDK/auth path failed
        err_text = str(e)
        should_fallback = (
            os.getenv("OPENROUTER_FORCE_HTTPX") in {"1", "true", "TRUE", "yes", "on"}
            or "401" in err_text
            or "No auth credentials" in err_text
        )
        if not should_fallback:
            sys.stderr.write(f"Request failed: {e}\n")
            return 1
        try:
            import httpx  # type: ignore
        except Exception:
            sys.stderr.write(f"Request failed: {e}\n")
            return 1

        if debug:
            sys.stderr.write(
                "Debug: falling back to HTTPX POST /chat/completions with explicit Authorization header\n"
            )

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        for k in ("HTTP-Referer", "X-Title"):
            if k in extra_headers:
                headers[k] = extra_headers[k]

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
                timeout=60,
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e2:
            sys.stderr.write(f"Request failed (fallback): {e2}\n")
            return 1

        class _Msg:
            def __init__(self, content: str):
                self.content = content

        class _Choice:
            def __init__(self, message: _Msg):
                self.message = message

        class _Resp:
            def __init__(self, data: Dict[str, Any]):
                self._data = data
                try:
                    content = data["choices"][0]["message"]["content"]
                except Exception:
                    content = json.dumps(data)
                self.choices = [_Choice(_Msg(content))]
            def model_dump_json(self, indent: int = 2) -> str:
                return json.dumps(self._data, indent=indent)

        resp = _Resp(data)

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
            # Fallback to raw JSON if structure isn't as expected
            print(resp.model_dump_json(indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
