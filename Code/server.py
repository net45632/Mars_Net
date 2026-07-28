import os
import time
import io
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, FileResponse
from pydantic import BaseModel
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from chatbot import ChatRequest, get_chat_reply
from RL_Agent import agent as rl_agent

START_TIME = time.time()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)




# --- ROUTING & STATIC FILES ---
@app.get("/")
def read_landing():
    if not os.path.exists("landing.html"):
        raise HTTPException(status_code=404, detail="landing.html file not found on server.")
    return FileResponse("landing.html")


@app.get("/landing.html")
def read_landing_direct():
    return read_landing()


@app.get("/app")
def read_app():
    if not os.path.exists("index.html"):
        raise HTTPException(status_code=404, detail="index.html file not found on server.")
    return FileResponse("index.html")


@app.get("/index.html")
def read_index_direct():
    return read_app()


@app.get("/telemetry.html")
def read_telemetry_page():
    if not os.path.exists("telemetry.html"):
        raise HTTPException(status_code=404, detail="telemetry.html not found on server.")
    return FileResponse("telemetry.html")

@app.get("/assistant.html")
async def serve_assistant_ui():
    return FileResponse("assistant.html")


@app.get("/style.css")
def read_style():
    if not os.path.exists("style.css"):
        raise HTTPException(status_code=404, detail="style.css not found.")
    return FileResponse("style.css", media_type="text/css")


@app.get("/script.js")
def read_script():
    if not os.path.exists("script.js"):
        raise HTTPException(status_code=404, detail="script.js not found.")
    return FileResponse("script.js", media_type="application/javascript")


# --- TELEMETRY LOGS & STATE ---
telemetry_log = []
sim_log = []
cumulative_fuel = 0.0


class TelemetrySnapshot(BaseModel):
    elapsed_seconds: float
    ai_enabled: bool
    altitude_multiplier: float
    off_collisions: int
    on_collisions: int
    off_time_ms: float
    on_time_ms: float
    min_nearest_distance: Optional[float] = None
    num_caution: int
    num_danger: int


@app.post("/telemetry")
def post_telemetry(snapshot: TelemetrySnapshot):
    record = snapshot.dict()
    record["timestamp"] = time.time()
    sim_log.append(record)
    return {"status": "ok", "logged": len(sim_log)}


# --- REAL RL AGENT ROUTES ---
class SatelliteState(BaseModel):
    sat_idx: int
    distance: Optional[float] = None
    had_collision: bool = False
    safe_direction: str = "INCREASE"


class MultiRLStepRequest(BaseModel):
    satellites: List[SatelliteState]


@app.post("/rl-step-multi")
def rl_step_multi(req: MultiRLStepRequest):
    global cumulative_fuel
    start_proc = time.time()
    results = rl_agent.step_batch([s.dict() for s in req.satellites])
    proc_latency = (time.time() - start_proc) * 1000.0  # ms

    if results:
        avg_multiplier = sum(r["multiplier"] for r in results) / len(results)
        shielded_count = sum(1 for r in results if r["shielded"])

        # Fuel model: Penalize orbital alterations
        non_hold_moves = sum(1 for r in results if r["action"] != "HOLD")
        cumulative_fuel += non_hold_moves * 0.05

        telemetry_log.append({
            "timestamp": time.time(),
            "step": rl_agent.total_steps,
            "elapsed_seconds": round(time.time() - START_TIME, 2),
            "altitude_multiplier": round(avg_multiplier, 3),
            "shielded_count": shielded_count,
            "epsilon": round(rl_agent.epsilon, 3),
            "fuel_expenditure": round(cumulative_fuel, 2),
            "latency_ms": round(proc_latency, 2)
        })

    return {"results": results, "epsilon": round(rl_agent.epsilon, 3), "total_steps": rl_agent.total_steps}


@app.get("/telemetry-live")
def get_telemetry_live():
    """Serves structured time-series data for the 8 telemetry models."""
    times = [t["elapsed_seconds"] for t in telemetry_log[-60:]]
    multipliers = [t["altitude_multiplier"] for t in telemetry_log[-60:]]
    shielded = [t["shielded_count"] for t in telemetry_log[-60:]]
    epsilons = [t["epsilon"] for t in telemetry_log[-60:]]
    fuels = [t["fuel_expenditure"] for t in telemetry_log[-60:]]
    latencies = [t["latency_ms"] for t in telemetry_log[-60:]]

    sim_recent = sim_log[-60:]
    min_distances = [s.get("min_nearest_distance", 1.0) or 1.0 for s in sim_recent]
    off_hits = [s.get("off_collisions", 0) for s in sim_recent]
    on_hits = [s.get("on_collisions", 0) for s in sim_recent]
    num_caution = [s.get("num_caution", 0) for s in sim_recent]
    num_danger = [s.get("num_danger", 0) for s in sim_recent]

    return {
        "times": times,
        "multipliers": multipliers,
        "min_distances": min_distances,
        "off_collisions": off_hits,
        "on_collisions": on_hits,
        "shielded_counts": shielded,
        "epsilons": epsilons,
        "fuel_expenditure": fuels,
        "num_caution": num_caution,
        "num_danger": num_danger,
        "latencies": latencies
    }


@app.get("/rl-debug")
def rl_debug():
    return {
        "q_table": rl_agent.debug_table(),
        "epsilon": round(rl_agent.epsilon, 3),
        "multipliers": rl_agent.debug_multipliers(),
        "total_steps": rl_agent.total_steps,
    }


@app.get("/rl-reset")
def rl_reset():
    """Resets RL memory AND flushes telemetry logs to keep reset data clean."""
    global telemetry_log, sim_log, cumulative_fuel, START_TIME
    rl_agent.reset()
    telemetry_log.clear()
    sim_log.clear()
    cumulative_fuel = 0.0
    START_TIME = time.time()
    return {"status": "RL agent reset & telemetry logs flushed"}


@app.post("/chat")
def chat(req: ChatRequest):
    return get_chat_reply(req)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)