"""
Minimal OpenRouter chat example using the official OpenAI Python SDK
without hardcoding secrets. Reads key and optional headers from env.

Usage:
  export OPENROUTER_API_KEY=...           # required
  export OPENROUTER_SITE_URL=http://localhost:3000  # optional
  export OPENROUTER_APP_NAME="Your App"   # optional
  python3 code/examples/openrouter_example.py
"""

import os
import sys

try:
    from openai import OpenAI
except Exception as exc:
    print("The 'openai' package is required. Install with: pip install --upgrade openai", file=sys.stderr)
    raise


def main() -> None:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is not set.", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
    )

    # Pick any OpenRouter model you have access to.
    # Examples: "openai/gpt-oss-20b:free", "openai/gpt-oss-120b",
    #           "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.1-70b-instruct"
    model = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-20b:free")

    extra_headers = {}
    site = os.getenv("OPENROUTER_SITE_URL")
    title = os.getenv("OPENROUTER_APP_NAME")
    if site:
        extra_headers["HTTP-Referer"] = site
    if title:
        extra_headers["X-Title"] = title

    print(f"Using model: {model}")

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Draft a friendly 2-sentence welcome for a tech meetup."},
        ],
        temperature=0.7,
        max_tokens=300,
        extra_headers=extra_headers or None,
    )

    print(resp.choices[0].message.content)


if __name__ == "__main__":
    main()

