"""
Groq-backed explainer assistant for the Mars satellite simulation.

The API key is loaded ONLY here, from a local .env file (git-ignored, never committed).
server.py imports get_chat_reply() and ChatRequest from this file and exposes them as
the /chat route — this file has no FastAPI app of its own and isn't run directly.
"""

import os
from typing import Optional, List

import requests
from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()  # reads GROQ_API_KEY from a local .env file next to this one

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = "openai/gpt-oss-20b"  # fast + cheap; swap to openai/gpt-oss-120b for stronger answers
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SYSTEM_PROMPT = """You are the in-app assistant for a Mars satellite-debris simulation. Explain what \
the viewer is looking at, in plain, friendly language. Keep answers concise unless asked for detail.

What's in the simulation:
- A 3D scene of Mars orbited by 8 satellites across 3 orbital planes, plus its moons Phobos and Deimos.
- Mars visibly rotates (a subtle shifting surface texture). Phobos orbits faster and closer than Deimos,
  using the same real orbital-speed relationship (speed depends on radius, closer = faster).
- "Threat debris" (orange dots) are on slowly-drifting collision courses with specific satellites.
- An AI ON/OFF toggle: when OFF, satellites hold a fixed baseline orbit no matter what; when ON, an
  RL-style model's altitude adjustments actually apply, letting satellites shift orbit to dodge debris.
- The Collisions tab compares collision counts and rates between AI-off and AI-on time, showing a
  live percentage reduction — the core proof that the AI's maneuvering actually helps.
- The Telemetry tab shows: a live chart of the model's orbit multiplier, a per-satellite status table
  (SAFE / CAUTION / DANGER based on distance to the nearest threat), a decision log narrating events,
  and an embedded matplotlib session report (3 panels: multiplier, collision counts, nearest distance).
- Clicking a satellite in the 3D view locks the camera to follow it; clicking it again releases.

If a "live state" section is included below, use it to answer questions about what's happening right \
now (e.g. current collision counts, which satellites are in danger). If no live state is given, answer \
generally about how the simulation works."""


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: Optional[List[ChatMessage]] = []
    context: Optional[dict] = None


def get_chat_reply(req: ChatRequest) -> dict:
    """Builds the Groq request from a ChatRequest and returns {"reply": str, "error": bool}."""
    if not GROQ_API_KEY:
        return {
            "reply": "The chatbot isn't configured yet — add GROQ_API_KEY to a .env file "
                     "next to chatbot.py (see .env.example), then restart the server.",
            "error": True,
        }

    system_content = SYSTEM_PROMPT
    if req.context:
        system_content += "\n\nCurrent live state:\n" + str(req.context)

    messages = [{"role": "system", "content": system_content}]
    messages += [{"role": m.role, "content": m.content} for m in (req.history or [])]
    messages.append({"role": "user", "content": req.message})

    try:
        response = requests.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GROQ_MODEL,
                "messages": messages,
                "temperature": 0.6,
                "max_tokens": 700,
            },
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        reply = data["choices"][0]["message"]["content"]
        return {"reply": reply, "error": False}

    except requests.exceptions.RequestException as e:
        return {"reply": f"Couldn't reach the Groq API right now ({e}). Check your API key and connection.", "error": True}
    except (KeyError, IndexError):
        return {"reply": "Got an unexpected response shape back from Groq. Check the model name is still valid.", "error": True}