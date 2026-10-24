#!/usr/bin/env python3
"""
Flask API server powered by Google's Gemma 4 via the OpenAI-compatible endpoint.

Environment variables (set in .env or shell):

  GEMMA_API_KEY        : Google AI Studio API key (required)
  GEMMA_BASE_URL       : override base URL
                         (default: https://generativelanguage.googleapis.com/v1beta/openai/)
  GEMMA_MODEL          : model slug (default: gemma-4-31b-it)
  GEMMA_TEMPERATURE    : float, e.g. 0.7 (optional)
  GEMMA_MAX_TOKENS     : int, e.g. 4096 (optional)
  GEMMA_THINKING_LEVEL : "high" | "medium" | "low" | "minimal" — enable chain-of-thought (optional)
  GEMMA_FORCE_HTTPX    : set to 1 to skip SDK and use httpx directly (optional)

  PORT                 : listening port (default: 8000)
  FLASK_DEBUG          : set to 1 for debug mode
  UPLOAD_DIR           : directory for uploaded files (default: ./uploads)
"""

from __future__ import annotations

import base64
import glob
import json
import mimetypes
import os
import uuid
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.utils import secure_filename

# Reuse the .env loader and helpers from the Gemma CLI companion script.
import gemma_chat as gc

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _ensure_api_key() -> str:
    """Return the GEMMA_API_KEY from the environment, or empty string."""
    return os.getenv("GEMMA_API_KEY", "").strip()


def _default_model() -> str:
    return os.getenv("GEMMA_MODEL", "gemma-4-31b-it").strip()


def _base_url() -> str:
    return os.getenv(
        "GEMMA_BASE_URL",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
    ).strip()


# ---------------------------------------------------------------------------
# File upload utilities
# ---------------------------------------------------------------------------

def _upload_dir() -> str:
    d = os.getenv("UPLOAD_DIR", os.path.join(os.path.dirname(__file__), "uploads"))
    os.makedirs(d, exist_ok=True)
    return d


def _save_upload(fs) -> Dict[str, Any]:
    """Persist a Werkzeug FileStorage object; return metadata dict with id."""
    file_id = uuid.uuid4().hex
    orig_name = fs.filename or "file"
    clean_name = secure_filename(orig_name) or f"upload-{file_id}"
    path = os.path.join(_upload_dir(), f"{file_id}_{clean_name}")
    fs.save(path)
    size = os.path.getsize(path)
    mtype = fs.mimetype or (mimetypes.guess_type(clean_name)[0] or "application/octet-stream")
    return {"id": file_id, "name": orig_name, "size": size, "mimetype": mtype}


def _resolve_upload(file_id: str) -> Optional[Dict[str, Any]]:
    pattern = os.path.join(_upload_dir(), f"{file_id}_*")
    matches = glob.glob(pattern)
    if not matches:
        return None
    path = matches[0]
    basename = os.path.basename(path)
    try:
        _, name = basename.split("_", 1)
    except ValueError:
        name = basename
    size = os.path.getsize(path)
    mtype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {"id": file_id, "name": name, "path": path, "size": size, "mimetype": mtype}


def _resolve_path(path: str) -> Optional[Dict[str, Any]]:
    try:
        apath = os.path.abspath(path)
        if not os.path.exists(apath) or not os.path.isfile(apath):
            return None
        name = os.path.basename(apath)
        size = os.path.getsize(apath)
        mtype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return {"id": None, "name": name, "path": apath, "size": size, "mimetype": mtype}
    except Exception:
        return None


def _normalize_attachment_meta(att: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    fid = att.get("id")
    if fid:
        return _resolve_upload(str(fid))
    path = att.get("path") or att.get("file") or att.get("filepath")
    if isinstance(path, str) and path.strip():
        return _resolve_path(path)
    return None


def _is_text_like(mimetype: str, name: str) -> bool:
    if mimetype.startswith("text/"):
        return True
    if mimetype in {"application/json"}:
        return True
    if any(name.lower().endswith(ext) for ext in (".md", ".csv", ".json", ".txt")):
        return True
    return False


def _model_supports_images(model: Optional[str]) -> bool:
    """Gemma 4 vision-capable slugs contain 'it' suffix and are multimodal by default."""
    if not model:
        return False
    m = model.strip().lower()
    # gemma-4-*-it models are multimodal; also match common vision keywords
    vision_patterns = [
        "gemma-4",
        "gemini",
        "vision",
        "-vl",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-vision",
        "gpt-4-turbo",
        "o4",
        "omni",
        "llava",
        "qwen-vl",
    ]
    return any(p in m for p in vision_patterns)


def _append_attachments_to_messages(
    msgs: List[Dict[str, Any]],
    attachments: Optional[List[Dict[str, Any]]],
    model: Optional[str],
) -> List[Dict[str, Any]]:
    """Inline text attachments and embed images for multimodal models."""
    if not attachments:
        return msgs

    # Find the last user message to append to.
    idx: Optional[int] = None
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get("role") == "user":
            idx = i
            break
    if idx is None:
        return msgs

    new_msgs = list(msgs)
    original_content = new_msgs[idx].get("content", "")
    if not isinstance(original_content, str):
        original_content = str(original_content)

    MAX_TEXT_BYTES = 512 * 1024       # 512 KB
    MAX_TEXT_CHARS = 20_000
    MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

    text_out = original_content
    image_parts: List[Dict[str, Any]] = []
    supports_images = _model_supports_images(model)

    for att in attachments:
        meta = _normalize_attachment_meta(att)
        if not meta:
            continue
        name = meta["name"]
        size = int(meta["size"])
        size_kb = max(1, round(size / 1024))
        mtype = meta["mimetype"]
        path = meta.get("path")

        if _is_text_like(mtype, name) and size <= MAX_TEXT_BYTES and path:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()
            except Exception:
                raw = "[Failed to read file]"
            if len(raw) > MAX_TEXT_CHARS:
                raw = raw[:MAX_TEXT_CHARS] + "\n... [truncated]"
            text_out += f"\n\nAttached file: {name} ({size_kb} KB)\n\n```text\n{raw}\n```"
            continue

        if mtype.startswith("image/") and size <= MAX_IMAGE_BYTES and path:
            if supports_images:
                try:
                    with open(path, "rb") as fh:
                        b64 = base64.b64encode(fh.read()).decode("ascii")
                    image_parts.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mtype};base64,{b64}",
                            "detail": "auto",
                        },
                    })
                    text_out += f"\n\nAttached image: {name} ({size_kb} KB)"
                except Exception:
                    text_out += f"\n\nAttached image: {name} ({size_kb} KB) [failed to read]"
            else:
                text_out += f"\n\nAttached image: {name} ({size_kb} KB) [model not multimodal]"
            continue

        # Non-text or oversized
        notes: List[str] = []
        if not mtype.startswith("image/") and not _is_text_like(mtype, name):
            notes.append("non-text")
        cap = MAX_IMAGE_BYTES if mtype.startswith("image/") else MAX_TEXT_BYTES
        if size > cap:
            notes.append("too large")
        note_s = "; ".join(notes) if notes else "not inlined"
        text_out += f"\n\nAttached file: {name} ({size_kb} KB) [{note_s}]"

    if image_parts and supports_images:
        new_msgs[idx] = {
            **new_msgs[idx],
            "content": [{"type": "text", "text": text_out}] + image_parts,
        }
    else:
        new_msgs[idx] = {**new_msgs[idx], "content": text_out}

    return new_msgs


def _build_messages(
    prompt: Optional[str],
    system_prompt: Optional[str],
    messages: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    if messages and isinstance(messages, list):
        return messages
    seq: List[Dict[str, Any]] = []
    if system_prompt:
        seq.append({"role": "system", "content": system_prompt})
    if prompt:
        seq.append({"role": "user", "content": prompt})
    return seq


def _build_extra_body(thinking_level: Optional[str]) -> Dict[str, Any]:
    """Construct the extra_body dict for Gemma 4 thinking / chain-of-thought."""
    extra_body: Dict[str, Any] = {}
    valid_levels = {"high", "medium", "low", "minimal"}
    if thinking_level and thinking_level.lower() in valid_levels:
        extra_body["google"] = {
            "thinking_config": {"thinking_level": thinking_level.lower()}
        }
    return extra_body


# ---------------------------------------------------------------------------
# Core chat helper (non-streaming)
# ---------------------------------------------------------------------------

def _send_chat(
    *,
    messages: List[Dict[str, Any]],
    model: Optional[str],
    temperature: Optional[float],
    max_tokens: Optional[int],
    thinking_level: Optional[str],
    force_httpx: bool,
) -> Dict[str, Any]:
    gc.load_env_file()
    api_key = _ensure_api_key()
    if not api_key:
        return {"error": "Missing GEMMA_API_KEY"}

    base_url = _base_url()
    resolved_model = (model or _default_model()).strip()
    extra_body = _build_extra_body(thinking_level)

    # Try OpenAI SDK first (Google's endpoint is OpenAI-compatible).
    if not force_httpx:
        try:
            from openai import OpenAI  # type: ignore

            client = OpenAI(api_key=api_key, base_url=base_url)
            resp = client.chat.completions.create(
                model=resolved_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body=extra_body or None,
            )
            content: Optional[str] = None
            try:
                content = resp.choices[0].message.content  # type: ignore[attr-defined]
            except Exception:
                pass
            return {
                "ok": True,
                "model": resolved_model,
                "content": content,
                "raw": json.loads(resp.model_dump_json()),
            }
        except Exception as e:
            err = str(e)
            # Only fall through if it looks like an auth/credential failure.
            if not ("401" in err or "No auth credentials" in err):
                return {"error": f"SDK request failed: {e}"}

    # httpx fallback
    import httpx  # type: ignore

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {"model": resolved_model, "messages": messages}
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
    except Exception as e:
        return {"error": f"HTTP request failed: {e}"}

    data = r.json()
    content = None
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        pass
    return {"ok": True, "model": resolved_model, "content": content, "raw": data}


# ---------------------------------------------------------------------------
# SSE helper
# ---------------------------------------------------------------------------

def _sse(data: Dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health() -> Any:
    gc.load_env_file()
    api_key = _ensure_api_key()
    return jsonify({
        "status": "ok",
        "key_present": len(api_key) > 0,
        "model": _default_model(),
        "provider": "gemma4",
    })


@app.route("/chat", methods=["POST"])
def chat() -> Any:
    body = request.get_json(silent=True) or {}

    prompt = body.get("prompt")
    system_prompt = body.get("system") or body.get("system_prompt")
    messages = body.get("messages")
    model = body.get("model")
    temperature = body.get("temperature")
    max_tokens = body.get("max_tokens")
    thinking_level = body.get("thinking_level") or os.getenv("GEMMA_THINKING_LEVEL", "").strip() or None
    force_httpx = bool(body.get("force_httpx", False)) or _bool_env("GEMMA_FORCE_HTTPX")
    raw = bool(body.get("raw", False))

    msgs = _build_messages(prompt, system_prompt, messages)
    if not msgs:
        return jsonify({"error": "Missing 'prompt' or 'messages'"}), 400

    attachments = body.get("attachments") or []
    if attachments:
        msgs = _append_attachments_to_messages(msgs, attachments, model or _default_model())

    result = _send_chat(
        messages=msgs,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        thinking_level=thinking_level,
        force_httpx=force_httpx,
    )

    status_code = 200 if result.get("ok") else 400
    if result.get("ok") and not raw:
        return jsonify({"content": result.get("content"), "model": result.get("model")}), status_code
    return jsonify(result), status_code


@app.route("/chat/stream", methods=["POST"])
def chat_stream() -> Any:
    body = request.get_json(silent=True) or {}

    prompt = body.get("prompt")
    system_prompt = body.get("system") or body.get("system_prompt")
    messages = body.get("messages")
    model = body.get("model")
    temperature = body.get("temperature")
    max_tokens = body.get("max_tokens")
    thinking_level = body.get("thinking_level") or os.getenv("GEMMA_THINKING_LEVEL", "").strip() or None
    force_httpx = bool(body.get("force_httpx", False)) or _bool_env("GEMMA_FORCE_HTTPX")
    raw = bool(body.get("raw", False))

    msgs = _build_messages(prompt, system_prompt, messages)
    if not msgs:
        return jsonify({"error": "Missing 'prompt' or 'messages'"}), 400

    attachments = body.get("attachments") or []
    if attachments:
        msgs = _append_attachments_to_messages(msgs, attachments, model or _default_model())

    # Resolve credentials once before entering the generator.
    gc.load_env_file()
    api_key = _ensure_api_key()
    if not api_key:
        return jsonify({"error": "Missing GEMMA_API_KEY"}), 400

    base_url = _base_url()
    resolved_model = (model or _default_model()).strip()
    extra_body = _build_extra_body(thinking_level)

    def stream_with_sdk():
        from openai import OpenAI  # type: ignore

        client = OpenAI(api_key=api_key, base_url=base_url)
        yield _sse({"ok": True, "model": resolved_model, "begin": True})
        try:
            resp = client.chat.completions.create(
                model=resolved_model,
                messages=msgs,
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body=extra_body or None,
                stream=True,
            )
            for chunk in resp:
                try:
                    choice = chunk.choices[0]
                    delta = getattr(choice, "delta", None)
                    content_delta = getattr(delta, "content", None) if delta is not None else None
                    if raw:
                        yield _sse(json.loads(chunk.model_dump_json()))
                    elif content_delta:
                        yield _sse({"delta": content_delta})
                    if getattr(choice, "finish_reason", None):
                        break
                except Exception:
                    if raw:
                        try:
                            yield _sse(json.loads(chunk.model_dump_json()))
                        except Exception:
                            pass
            yield _sse({"done": True})
        except Exception as e:
            yield _sse({"ok": False, "error": f"SDK stream failed: {e}"})

    def stream_with_httpx():
        import httpx  # type: ignore

        url = base_url.rstrip("/") + "/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload: Dict[str, Any] = {
            "model": resolved_model,
            "messages": msgs,
            "stream": True,
        }
        if extra_body:
            payload.update(extra_body)
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        yield _sse({"ok": True, "model": resolved_model, "begin": True})
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream("POST", url, headers=headers, json=payload) as r:
                    if r.status_code != 200:
                        yield _sse({"ok": False, "error": f"HTTP {r.status_code}"})
                        return
                    for line in r.iter_text():
                        if not line:
                            continue
                        if line.startswith("data: "):
                            data_str = line[len("data: "):].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                obj = json.loads(data_str)
                            except Exception:
                                continue
                            if raw:
                                yield _sse(obj)
                            else:
                                try:
                                    delta = obj["choices"][0]["delta"].get("content")
                                    if delta:
                                        yield _sse({"delta": delta})
                                except Exception:
                                    pass
            yield _sse({"done": True})
        except Exception as e:
            yield _sse({"ok": False, "error": f"httpx stream failed: {e}"})

    generator = stream_with_httpx() if force_httpx else stream_with_sdk()
    sse_headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return Response(generator, headers=sse_headers)


@app.route("/upload", methods=["POST"])
def upload() -> Any:
    if not request.files:
        return jsonify({"ok": False, "error": "No files provided"}), 400

    files = request.files.getlist("files") or []
    if not files:
        try:
            files = list(request.files.values())
        except Exception:
            files = []
    if not files:
        return jsonify({"ok": False, "error": "No files provided"}), 400

    saved: List[Dict[str, Any]] = []
    for fs in files:
        try:
            saved.append(_save_upload(fs))
        except Exception as e:
            return jsonify({"ok": False, "error": f"Failed to save file: {e}"}), 400

    return jsonify({"ok": True, "files": saved})


@app.route("/files/<file_id>", methods=["GET"])
def get_file(file_id: str) -> Any:
    meta = _resolve_upload(file_id)
    if not meta:
        return jsonify({"error": "Not found"}), 404
    return send_file(meta["path"], as_attachment=True, download_name=meta["name"])  # type: ignore


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    gc.load_env_file()
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=_bool_env("FLASK_DEBUG"))
