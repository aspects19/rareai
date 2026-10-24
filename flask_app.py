#!/usr/bin/env python3
import json
import os
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.utils import secure_filename
import uuid
import glob
import mimetypes
import base64

# Reuse .env loader and helpers from the local script
import openrouter_chat as orc


app = Flask(__name__)


def _bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _ensure_keys_visible() -> None:
    # Mirror key vars so either name works
    if ("OPENROUTER_API_KEY" not in os.environ) and os.getenv("OPENAI_API_KEY"):
        os.environ["OPENROUTER_API_KEY"] = os.getenv("OPENAI_API_KEY", "")
    if ("OPENAI_API_KEY" not in os.environ) and os.getenv("OPENROUTER_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.getenv("OPENROUTER_API_KEY", "")


# ----------------------
# File upload utilities
# ----------------------

def _upload_dir() -> str:
    d = os.getenv("UPLOAD_DIR", os.path.join(os.path.dirname(__file__), "uploads"))
    os.makedirs(d, exist_ok=True)
    return d


def _save_upload(fs) -> Dict[str, Any]:
    """Save a Werkzeug FileStorage and return metadata dict with id.

    The file is stored as <id>_<secure_name> in UPLOAD_DIR.
    """
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
    # original name is the portion after first underscore
    try:
        _, name = basename.split("_", 1)
    except ValueError:
        name = basename
    size = os.path.getsize(path)
    mtype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {"id": file_id, "name": name, "path": path, "size": size, "mimetype": mtype}


def _is_text_like(mimetype: str, name: str) -> bool:
    if mimetype.startswith("text/"):
        return True
    if mimetype in {"application/json"}:
        return True
    if any(name.lower().endswith(ext) for ext in (".md", ".csv", ".json", ".txt")):
        return True
    return False


def _append_attachments_to_content(content: str, attachments: List[Dict[str, Any]]) -> str:
    if not attachments:
        return content
    out = content
    MAX_BYTES = 512 * 1024
    MAX_CHARS = 20000
    for att in attachments:
        fid = att.get("id")
        if not fid:
            continue
        meta = _resolve_upload(str(fid))
        if not meta:
            continue
        name = meta["name"]
        size_kb = max(1, round(meta["size"] / 1024))
        mimetype = meta["mimetype"]
        if _is_text_like(mimetype, name) and meta["size"] <= MAX_BYTES:
            try:
                with open(meta["path"], "r", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
            except Exception:
                raw = "[Failed to read file]"
            if len(raw) > MAX_CHARS:
                raw = raw[:MAX_CHARS] + "\n... [truncated]"
            out += f"\n\nAttached file: {name} ({size_kb} KB)\n\n```text\n{raw}\n```"
        else:
            note = "non-text or too large; not inlined"
            out += f"\n\nAttached file: {name} ({size_kb} KB) [{note}]"
    return out


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
    # Prefer explicit upload id
    fid = att.get("id")
    if fid:
        return _resolve_upload(str(fid))
    # Fall back to local file path
    path = att.get("path") or att.get("file") or att.get("filepath")
    if isinstance(path, str) and path.strip():
        return _resolve_path(path)
    return None


def _model_supports_images(model: Optional[str]) -> bool:
    if not model:
        return False
    m = model.strip().lower()
    # Heuristic: common multimodal model slugs
    patterns = [
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-vision",
        "gpt-4-turbo",
        "o4",
        "omni",
        "vision",
        "-vl",
        " llava",
        "minicpm-v",
        "qwen-vl",
        "llama-vision",
    ]
    return any(p in m for p in patterns)


def _append_attachments_to_messages(
    msgs: List[Dict[str, Any]], attachments: Optional[List[Dict[str, Any]]], model: Optional[str]
) -> List[Dict[str, Any]]:
    if not attachments:
        return msgs

    # Find last user message to append to
    idx = None
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get("role") == "user":
            idx = i
            break
    if idx is None:
        return msgs

    # Prepare original content as text
    new_msgs = list(msgs)
    original_content = new_msgs[idx].get("content", "")
    if not isinstance(original_content, str):
        try:
            original_content = str(original_content)
        except Exception:
            original_content = ""

    # Limits
    MAX_TEXT_BYTES = 512 * 1024
    MAX_TEXT_CHARS = 20000
    MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

    text_out = original_content
    image_parts: List[Dict[str, Any]] = []
    supports_images = _model_supports_images(model)

    for att in attachments or []:
        meta = _normalize_attachment_meta(att) or None
        if not meta:
            continue
        name = meta["name"]
        size = int(meta["size"])
        size_kb = max(1, round(size / 1024))
        mtype = meta["mimetype"]
        path = meta.get("path")

        if _is_text_like(mtype, name) and size <= MAX_TEXT_BYTES and path:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
            except Exception:
                raw = "[Failed to read file]"
            if len(raw) > MAX_TEXT_CHARS:
                raw = raw[:MAX_TEXT_CHARS] + "\n... [truncated]"
            text_out += f"\n\nAttached file: {name} ({size_kb} KB)\n\n```text\n{raw}\n```"
            continue

        if mtype.startswith("image/") and size <= MAX_IMAGE_BYTES and path:
            if supports_images:
                try:
                    with open(path, "rb") as f:
                        b = f.read()
                    b64 = base64.b64encode(b).decode("ascii")
                    data_url = f"data:{mtype};base64,{b64}"
                    image_parts.append({
                        "type": "image_url",
                        "image_url": {"url": data_url, "detail": "auto"},
                    })
                    # Also add a brief textual note for context
                    text_out += f"\n\nAttached image: {name} ({size_kb} KB)"
                except Exception:
                    text_out += f"\n\nAttached image: {name} ({size_kb} KB) [failed to read]"
            else:
                text_out += f"\n\nAttached image: {name} ({size_kb} KB) [model not multimodal]"
            continue

        # Fallback note for non-text or large files
        note = []
        if not mtype.startswith("image/") and not _is_text_like(mtype, name):
            note.append("non-text")
        if size > (MAX_IMAGE_BYTES if mtype.startswith("image/") else MAX_TEXT_BYTES):
            note.append("too large")
        note_s = "; ".join(note) if note else "not inlined"
        text_out += f"\n\nAttached file: {name} ({size_kb} KB) [{note_s}]"

    if image_parts and supports_images:
        # Use multimodal content array: first text, then images
        new_msgs[idx] = {**new_msgs[idx], "content": [{"type": "text", "text": text_out}] + image_parts}
    else:
        new_msgs[idx] = {**new_msgs[idx], "content": text_out}

    return new_msgs


def _build_messages(prompt: Optional[str], system_prompt: Optional[str], messages: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    if messages and isinstance(messages, list):
        return messages
    seq: List[Dict[str, Any]] = []
    if system_prompt:
        seq.append({"role": "system", "content": system_prompt})
    if prompt:
        seq.append({"role": "user", "content": prompt})
    return seq


def _send_chat(
    *,
    messages: List[Dict[str, Any]],
    model: Optional[str],
    site_url: Optional[str],
    app_name: Optional[str],
    provider_order: Optional[List[str]],
    provider_allow_fallbacks: Optional[bool],
    provider_route: Optional[Dict[str, Any]],
    temperature: Optional[float],
    max_tokens: Optional[int],
    force_httpx: bool,
) -> Dict[str, Any]:
    # Load env and normalize keys
    orc.load_env_file()
    _ensure_keys_visible()

    api_key = (os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return {"error": "Missing OPENROUTER_API_KEY/OPENAI_API_KEY"}

    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
    model = (model or os.getenv("OPENROUTER_MODEL") or "openai/gpt-oss-120b").strip()

    # Headers and provider metadata
    extra_headers: Dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
    }
    if site_url or os.getenv("OPENROUTER_SITE_URL"):
        extra_headers["HTTP-Referer"] = site_url or os.getenv("OPENROUTER_SITE_URL")  # type: ignore
    if app_name or os.getenv("OPENROUTER_APP_NAME"):
        extra_headers["X-Title"] = app_name or os.getenv("OPENROUTER_APP_NAME")  # type: ignore

    extra_body: Dict[str, Any] = {}
    if provider_order or provider_allow_fallbacks is not None:
        extra_body["provider"] = {}
        if provider_order:
            extra_body["provider"]["order"] = provider_order
        if provider_allow_fallbacks is not None:
            extra_body["provider"]["allow_fallbacks"] = provider_allow_fallbacks
    if provider_route:
        extra_body["route"] = provider_route

    # Try SDK first, then fallback to httpx
    try:
        from openai import OpenAI  # type: ignore

        client = OpenAI(base_url=base_url, api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            extra_headers=extra_headers or None,
            extra_body=extra_body or None,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        # Success via SDK
        content = None
        try:
            content = resp.choices[0].message.content  # type: ignore[attr-defined]
        except Exception:
            pass
        return {
            "ok": True,
            "content": content,
            "raw": json.loads(resp.model_dump_json()),
        }
    except Exception as e:
        if not (force_httpx or "401" in str(e) or "No auth credentials" in str(e)):
            return {"error": f"SDK request failed: {e}"}

    # Fallback path
    import httpx  # type: ignore

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

    r = httpx.post(base_url.rstrip("/") + "/chat/completions", headers=headers, json=payload, timeout=60)
    try:
        r.raise_for_status()
    except Exception:
        return {"error": f"HTTP {r.status_code}: {r.text}"}
    data = r.json()
    content = None
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        pass
    return {"ok": True, "content": content, "raw": data}


@app.route("/health", methods=["GET"])
def health() -> Any:
    orc.load_env_file()
    _ensure_keys_visible()
    key_len = len((os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip())
    return jsonify({"status": "ok", "key_present": key_len > 0})


@app.route("/chat", methods=["POST"])
def chat() -> Any:
    body = request.get_json(silent=True) or {}

    prompt = body.get("prompt")
    system_prompt = body.get("system") or body.get("system_prompt")
    messages = body.get("messages")
    model = body.get("model")
    temperature = body.get("temperature")
    max_tokens = body.get("max_tokens")
    force_httpx = bool(body.get("force_httpx", False))
    raw = bool(body.get("raw", False))

    # Provider metadata and headers
    site_url = body.get("site_url")
    app_name = body.get("app_name")
    provider = body.get("provider") or {}
    provider_order = provider.get("order")
    provider_allow_fallbacks = provider.get("allow_fallbacks")
    provider_route = provider.get("route")

    msgs = _build_messages(prompt, system_prompt, messages)
    if not msgs:
        return jsonify({"error": "Missing 'prompt' or 'messages'"}), 400

    # Append attachments (if any) to the last user message
    attachments = body.get("attachments") or []
    if attachments:
        msgs = _append_attachments_to_messages(msgs, attachments, model)

    result = _send_chat(
        messages=msgs,
        model=model,
        site_url=site_url,
        app_name=app_name,
        provider_order=provider_order,
        provider_allow_fallbacks=provider_allow_fallbacks,
        provider_route=provider_route,
        temperature=temperature,
        max_tokens=max_tokens,
        force_httpx=force_httpx or _bool_env("OPENROUTER_FORCE_HTTPX"),
    )

    status = 200 if result.get("ok") else 400
    if result.get("ok") and not raw:
        return jsonify({"content": result.get("content")}), status
    return jsonify(result), status


def _sse(data: Dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.route("/chat/stream", methods=["POST"])
def chat_stream() -> Any:
    body = request.get_json(silent=True) or {}

    prompt = body.get("prompt")
    system_prompt = body.get("system") or body.get("system_prompt")
    messages = body.get("messages")
    model = body.get("model")
    temperature = body.get("temperature")
    max_tokens = body.get("max_tokens")
    force_httpx = bool(body.get("force_httpx", False))
    raw = bool(body.get("raw", False))

    site_url = body.get("site_url")
    app_name = body.get("app_name")
    provider = body.get("provider") or {}
    provider_order = provider.get("order")
    provider_allow_fallbacks = provider.get("allow_fallbacks")
    provider_route = provider.get("route")

    msgs = _build_messages(prompt, system_prompt, messages)
    if not msgs:
        return jsonify({"error": "Missing 'prompt' or 'messages'"}), 400

    # Append attachments (if any) to the last user message
    attachments = body.get("attachments") or []
    if attachments:
        msgs = _append_attachments_to_messages(msgs, attachments, model)

    # Shared setup
    orc.load_env_file()
    _ensure_keys_visible()
    api_key = (os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return jsonify({"error": "Missing OPENROUTER_API_KEY/OPENAI_API_KEY"}), 400
    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
    model = (model or os.getenv("OPENROUTER_MODEL") or "openai/gpt-oss-120b").strip()

    extra_headers: Dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
    }
    if site_url or os.getenv("OPENROUTER_SITE_URL"):
        extra_headers["HTTP-Referer"] = site_url or os.getenv("OPENROUTER_SITE_URL")  # type: ignore
    if app_name or os.getenv("OPENROUTER_APP_NAME"):
        extra_headers["X-Title"] = app_name or os.getenv("OPENROUTER_APP_NAME")  # type: ignore

    extra_body: Dict[str, Any] = {}
    if provider_order or provider_allow_fallbacks is not None:
        extra_body["provider"] = {}
        if provider_order:
            extra_body["provider"]["order"] = provider_order
        if provider_allow_fallbacks is not None:
            extra_body["provider"]["allow_fallbacks"] = provider_allow_fallbacks
    if provider_route:
        extra_body["route"] = provider_route

    def stream_with_sdk() -> Any:
        from openai import OpenAI  # type: ignore

        client = OpenAI(base_url=base_url, api_key=api_key)
        yield _sse({"ok": True, "model": model, "begin": True})
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=msgs,
                extra_headers=extra_headers or None,
                extra_body=extra_body or None,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
            for chunk in resp:
                try:
                    choice = chunk.choices[0]
                    delta = getattr(choice, "delta", None)
                    content = None
                    if delta is not None:
                        content = getattr(delta, "content", None)
                    if raw:
                        yield _sse(json.loads(chunk.model_dump_json()))
                    elif content:
                        yield _sse({"delta": content})
                    if getattr(choice, "finish_reason", None):
                        break
                except Exception:
                    if raw:
                        yield _sse(json.loads(chunk.model_dump_json()))
            yield _sse({"done": True})
        except Exception as e:
            # Signal error to caller and let them retry with force_httpx
            yield _sse({"ok": False, "error": f"SDK stream failed: {e}"})

    def stream_with_httpx() -> Any:
        import httpx  # type: ignore

        url = base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        for k in ("HTTP-Referer", "X-Title"):
            if k in extra_headers:
                headers[k] = extra_headers[k]
        payload: Dict[str, Any] = {"model": model, "messages": msgs, "stream": True}
        if extra_body:
            payload.update(extra_body)
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        yield _sse({"ok": True, "model": model, "begin": True})
        with httpx.Client(timeout=None) as client:
            with client.stream("POST", url, headers=headers, json=payload) as r:
                if r.status_code != 200:
                    yield _sse({"ok": False, "error": f"HTTP {r.status_code}: {r.text}"})
                    return
                buffer = ""
                for line in r.iter_text():
                    if not line:
                        continue
                    # SSE format: lines starting with 'data: '
                    if line.startswith("data: "):
                        data = line[len("data: "):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
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

    # Choose path: stream via SDK first unless forced to httpx
    generator = stream_with_httpx() if force_httpx else stream_with_sdk()
    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return Response(generator, headers=headers)


@app.route("/upload", methods=["POST"])
def upload() -> Any:
    # Expect multipart/form-data with one or more 'files'
    if not request.files:
        return jsonify({"ok": False, "error": "No files provided"}), 400
    files = request.files.getlist("files") or []
    if not files:
        # Allow single unnamed file (first value in dict)
        try:
            files = list(request.files.values())
        except Exception:
            files = []
    if not files:
        return jsonify({"ok": False, "error": "No files provided"}), 400

    saved: List[Dict[str, Any]] = []
    for fs in files:
        try:
            meta = _save_upload(fs)
            saved.append(meta)
        except Exception as e:
            return jsonify({"ok": False, "error": f"Failed to save file: {e}"}), 400
    return jsonify({"ok": True, "files": saved})


@app.route("/files/<file_id>", methods=["GET"])
def get_file(file_id: str) -> Any:
    meta = _resolve_upload(file_id)
    if not meta:
        return jsonify({"error": "Not found"}), 404
    # send the file with original name
    return send_file(meta["path"], as_attachment=True, download_name=meta["name"])  # type: ignore


if __name__ == "__main__":
    # Load .env early for local runs
    orc.load_env_file()
    _ensure_keys_visible()
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=_bool_env("FLASK_DEBUG"))
