import time
import io
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
import pandas as pd
import matplotlib
matplotlib.use("Agg")  # headless backend — no display available on the server
import matplotlib.pyplot as plt

app = FastAPI()

# Allow your HTML file to securely talk to this Python server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- REINFORCEMENT LEARNING SIMULATION STATE ---
class RLOrtbitOptimizer:
    def __init__(self):
        self.start_time = time.time()
        self.call_count = 0
        # Training duration is now real elapsed seconds, NOT number of poll calls.
        # The frontend can poll at 10fps or 60fps and the demo still paces the same way.
        self.total_training_seconds = 20.0
        self.altitude_multiplier = 1.0

    def reset(self):
        self.start_time = time.time()
        self.call_count = 0
        self.altitude_multiplier = 1.0

    def step(self):
        """
        This represents your RL Agent's step function.
        It evaluates the environment state (debris density) and adjusts the orbit.
        """
        self.call_count += 1
        elapsed = time.time() - self.start_time

        if elapsed < self.total_training_seconds:
            # Simulated Q-Learning/Policy update, paced by real time:
            # The AI learns that staying too low hits debris, so it actively increments altitude
            progress = elapsed / self.total_training_seconds  # 0.0 .. 1.0
            state_idx = min(3, int(progress * 4))
            self.altitude_multiplier = 0.85 + (state_idx * 0.15)
            mode = f"Training Phase ({elapsed:.1f}s / {self.total_training_seconds:.0f}s)"
        else:
            # Exploitation Phase: AI has settled on the optimal stable clearance scale
            self.altitude_multiplier = 1.30
            mode = "Live Deployment (Optimal State)"

        return {
            "step": self.call_count,
            "elapsed_seconds": round(elapsed, 2),
            "altitude_multiplier": self.altitude_multiplier,
            "mode": mode,
        }


# Instantiate our AI agent
ai_agent = RLOrtbitOptimizer()

# --- TELEMETRY LOGGING (model steps) ---
# Every call to /next-step gets appended here. This is the ground-truth data trail —
# separate from the live in-browser chart, meant for CSV export / retrospective reports.
telemetry_log = []

# --- TELEMETRY LOGGING (real simulation outcomes, reported by the frontend) ---
# This is the data that actually proves the AI is doing something: real collision counts,
# real distances, on a different cadence (~every 2s) than the model's own per-poll log above.
sim_log = []


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


@app.get("/download-sim-log")
def download_sim_log():
    """Export the real simulation telemetry (collisions, distances) as a CSV file."""
    df = pd.DataFrame(sim_log)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sim_telemetry_log.csv"},
    )


@app.get("/next-step")
def get_next_step():
    # When the frontend asks, run one iteration of the AI model and return the data
    result = ai_agent.step()
    telemetry_log.append({
        "timestamp": time.time(),
        "step": result["step"],
        "elapsed_seconds": result["elapsed_seconds"],
        "altitude_multiplier": result["altitude_multiplier"],
        "mode": result["mode"],
    })
    return result


@app.get("/reset")
def reset_simulation():
    ai_agent.reset()
    return {"status": "AI reset successful"}


@app.get("/download-log")
def download_log():
    """Export the full telemetry history as a CSV file."""
    df = pd.DataFrame(telemetry_log)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=telemetry_log.csv"},
    )


@app.get("/report-chart")
def report_chart():
    """Render a matplotlib PNG summarizing the session: orbit multiplier (model log),
    plus collision counts and nearest-threat distance over time (real sim telemetry)."""
    model_df = pd.DataFrame(telemetry_log)
    sim_df = pd.DataFrame(sim_log)

    fig, axes = plt.subplots(3, 1, figsize=(7, 7.5), dpi=140, sharex=False)
    fig.patch.set_facecolor("#0d1117")

    def style_axis(ax, title):
        ax.set_facecolor("#0d1117")
        ax.set_title(title, color="#c9d1d9", fontsize=10, loc="left")
        ax.tick_params(colors="#8b949e", labelsize=8)
        for spine in ax.spines.values():
            spine.set_color("#30363d")
        ax.grid(True, color="#21262d", linewidth=0.6)

    # Panel 1: orbit multiplier over time (model log)
    style_axis(axes[0], "Orbit Multiplier")
    if not model_df.empty:
        axes[0].plot(model_df["elapsed_seconds"], model_df["altitude_multiplier"],
                      color="#58a6ff", linewidth=1.6)
    axes[0].set_ylabel("multiplier", color="#8b949e", fontsize=8)

    # Panel 2: collision counts, AI off vs on (real sim telemetry)
    style_axis(axes[1], "Collisions — AI OFF vs AI ON")
    if not sim_df.empty:
        axes[1].plot(sim_df["elapsed_seconds"], sim_df["off_collisions"],
                      color="#f85149", linewidth=1.6, label="AI OFF")
        axes[1].plot(sim_df["elapsed_seconds"], sim_df["on_collisions"],
                      color="#3fb950", linewidth=1.6, label="AI ON")
        axes[1].legend(facecolor="#161b22", edgecolor="#30363d", labelcolor="#c9d1d9", fontsize=8)
    axes[1].set_ylabel("count", color="#8b949e", fontsize=8)

    # Panel 3: nearest-threat distance over time, with the collision threshold marked
    style_axis(axes[2], "Nearest Threat Distance")
    if not sim_df.empty:
        axes[2].plot(sim_df["elapsed_seconds"], sim_df["min_nearest_distance"],
                      color="#d29922", linewidth=1.6)
        axes[2].axhline(0.35, color="#f85149", linewidth=1.0, linestyle="--", label="collision threshold")
        axes[2].legend(facecolor="#161b22", edgecolor="#30363d", labelcolor="#c9d1d9", fontsize=8)
    axes[2].set_xlabel("Elapsed seconds", color="#8b949e", fontsize=9)
    axes[2].set_ylabel("distance", color="#8b949e", fontsize=8)

    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")


if __name__ == "__main__":
    import uvicorn
    # Runs the backend local server on http://127.0.0.1:8000
    uvicorn.run(app, host="127.0.0.1", port=8000)