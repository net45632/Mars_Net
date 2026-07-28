"""
Online Q-learning agent with a symbolic safety shield, for satellite orbit-avoidance.

v2 — per-satellite control. Each satellite gets its own state, its own action, its own
multiplier — fixing a real bug found in testing: with one shared global multiplier,
"fixing" one satellite's danger moved all 8 satellites at once, sometimes creating new
collisions for satellites that were previously fine. Independent multipliers mean an
action taken for satellite 3 can no longer disturb satellite 6.

The Q-TABLE itself stays SHARED/pooled across all 8 satellites — they face structurally
the same problem, so pooling their experience into one table means every satellite's
outcome trains the same policy, which matters a lot when real experience trickles in
slowly from a live browser stream rather than a fast resettable simulator.

Neuro-symbolic split:
- SYMBOLIC layer: a hard, unlearned safety rule. If a satellite's nearest threat is inside
  the danger zone, the shield forces a maximum evasive action — in the DIRECTION that
  actually moves away from that specific threat (computed from real geometry: whether the
  threat's radius sits above or below that satellite's baseline), not a blind guess.
- Learned layer: everything outside the danger zone. The shared Q-table decides how
  aggressively to adjust orbit, trading off safety margin against fuel efficiency.
"""

"""
Online Q-learning agent with a symbolic safety shield, for satellite orbit-avoidance.
v2.2 — Reward shaping to close the deep-space drift loophole
(station-keeping penalty, anti-crowding penalty, boundary-attempt penalty)
"""

import random

COLLISION_RADIUS = 0.35
DANGER_DIST = 0.50
CAUTION_DIST = 0.90

DIST_BINS = ["DANGER", "CAUTION", "SAFE"]
CLOSING_BINS = ["CLOSING", "STEADY", "OPENING"]
THREAT_DIRS = ["ABOVE", "BELOW", "NONE"]
ACTIONS = ["DECREASE", "HOLD", "INCREASE"]

# Standard step vs. Evasive Shield impulse
ACTION_STEP = 0.02
EMERGENCY_ACTION_STEP = 0.06  # 3x stronger impulse when shield overrides

MULTIPLIER_MIN = 0.75
MULTIPLIER_MAX = 1.60

ALPHA_START = 0.2
ALPHA_MIN = 0.03
ALPHA_DECAY = 0.9995   # slower than epsilon's decay — keeps learning useful early, floors ~step 3800
GAMMA = 0.9
EPSILON_START = 0.3
EPSILON_MIN = 0.02
EPSILON_DECAY = 0.985

# --- Reward-shaping tuning knobs (anti reward-hacking) ---
# K_STATION must beat the +1.0/step survival reward even at the TIGHTEST boundary gap.
# MULTIPLIER_MIN=0.75 is only 0.25 from baseline (vs 0.6 at MULTIPLIER_MAX=1.60), so that's
# the binding constraint: need K_STATION * 0.25 > 1.0  =>  K_STATION > 4.0. Using 6.0 for margin.
K_STATION = 6.0             # station-keeping severity; raise if agent still parks off-baseline
K_CROWD = 6.0               # anti-crowding severity
CROWDING_SAFE_DIST = CAUTION_DIST  # start penalizing closeness at the same point CAUTION begins
BOUNDARY_PENALTY = 15.0     # flat cost each time the agent tries to push past a hard limit


def distance_bin(distance):
    if distance is None:
        return "SAFE"
    if distance < DANGER_DIST:
        return "DANGER"
    if distance < CAUTION_DIST:
        return "CAUTION"
    return "SAFE"


def closing_bin(distance, prev_distance):
    if distance is None or prev_distance is None:
        return "STEADY"
    delta = prev_distance - distance  # positive = getting closer
    if delta > 0.02:
        return "CLOSING"
    if delta < -0.02:
        return "OPENING"
    return "STEADY"


def station_keeping_penalty(mult, k=K_STATION):
    """Constant drain proportional to distance from the baseline orbit (1.0).
    This is what makes drifting to an extreme and coasting there a losing strategy."""
    return abs(1.0 - mult) * k


def crowding_penalty(distance, safe_dist=CROWDING_SAFE_DIST, k=K_CROWD):
    """Quadratic penalty once a satellite creeps inside the safe distance,
    so 'close but not yet in DANGER' still costs something."""
    if distance is None or distance >= safe_dist:
        return 0.0
    return ((safe_dist - distance) ** 2) * k


class QLearningShieldAgent:
    def __init__(self):
        self.q_table = {
            (d, c, t): {a: 0.0 for a in ACTIONS}
            for d in DIST_BINS
            for c in CLOSING_BINS
            for t in THREAT_DIRS
        }

        self._apply_warm_start()

        self.epsilon = EPSILON_START
        self.alpha = ALPHA_START
        self.total_steps = 0
        self.multiplier = {}
        self.prev_distance = {}
        self.last_state = {}
        self.last_action = {}
        self.last_boundary_hit = {}

    def _apply_warm_start(self):
        """Injects strong directional domain priors into Q-table."""
        for c in CLOSING_BINS:
            for d in ["DANGER", "CAUTION"]:
                # Threat ABOVE -> Preferred DECREASE
                self.q_table[(d, c, "ABOVE")]["DECREASE"] = 8.0
                self.q_table[(d, c, "ABOVE")]["HOLD"] = 0.0
                self.q_table[(d, c, "ABOVE")]["INCREASE"] = -8.0

                # Threat BELOW -> Preferred INCREASE
                self.q_table[(d, c, "BELOW")]["INCREASE"] = 8.0
                self.q_table[(d, c, "BELOW")]["HOLD"] = 0.0
                self.q_table[(d, c, "BELOW")]["DECREASE"] = -8.0

    def reset(self, keep_positions=True):
        """
        Resets agent memory/learning without physically collapsing active orbits.
        """
        saved_multipliers = dict(self.multiplier) if keep_positions else {}
        saved_prev_dists = dict(self.prev_distance) if keep_positions else {}

        self.q_table = {
            (d, c, t): {a: 0.0 for a in ACTIONS}
            for d in DIST_BINS
            for c in CLOSING_BINS
            for t in THREAT_DIRS
        }
        self._apply_warm_start()

        self.epsilon = EPSILON_START
        self.alpha = ALPHA_START
        self.total_steps = 0

        # Retain orbital positions & distances to prevent collision spikes on reset
        self.multiplier = saved_multipliers
        self.prev_distance = saved_prev_dists
        self.last_state = {}
        self.last_action = {}
        self.last_boundary_hit = {}

    def _get_multiplier(self, sat_idx):
        return self.multiplier.setdefault(sat_idx, 1.0)

    def choose_action(self, state):
        dist_bin, closing, threat_dir = state

        # Safe Exploration Masking: In CAUTION mode, filter out suicidal moves during random picks
        if random.random() < self.epsilon:
            valid_actions = list(ACTIONS)
            if dist_bin == "CAUTION":
                if threat_dir == "ABOVE" and "INCREASE" in valid_actions:
                    valid_actions.remove("INCREASE")
                elif threat_dir == "BELOW" and "DECREASE" in valid_actions:
                    valid_actions.remove("DECREASE")
            return random.choice(valid_actions)

        q_row = self.q_table[state]
        return max(q_row, key=q_row.get)

    def learn(self, prev_state, action, reward, new_state):
        old_q = self.q_table[prev_state][action]
        best_next_q = max(self.q_table[new_state].values())
        td_target = reward + GAMMA * best_next_q
        self.q_table[prev_state][action] = old_q + self.alpha * (td_target - old_q)

    def step_satellite(self, sat_idx, distance, had_collision, safe_direction):
        prev_dist = self.prev_distance.get(sat_idx)
        current_mult = self._get_multiplier(sat_idx)

        threat_dir = "NONE"
        if safe_direction == "DECREASE":
            threat_dir = "ABOVE"
        elif safe_direction == "INCREASE":
            threat_dir = "BELOW"

        state = (distance_bin(distance), closing_bin(distance, prev_dist), threat_dir)

        last_state = self.last_state.get(sat_idx)
        last_action = self.last_action.get(sat_idx)
        last_boundary_hit = self.last_boundary_hit.get(sat_idx, False)

        if last_state is not None:
            reward = -100.0 if had_collision else 1.0
            if last_action != "HOLD":
                reward -= 0.1

            # --- Anti reward-hacking shaping ---
            # Penalize sitting away from the baseline orbit (closes the drift loophole),
            # penalize creeping close to a threat even outside the hard shield zone,
            # and penalize attempts to blow past the hard multiplier limits.
            reward -= station_keeping_penalty(current_mult)
            reward -= crowding_penalty(distance)
            if last_boundary_hit:
                reward -= BOUNDARY_PENALTY

            self.learn(last_state, last_action, reward, state)

        shielded = state[0] == "DANGER"
        if shielded:
            action = safe_direction if safe_direction in ("INCREASE", "DECREASE") else "INCREASE"
            mode = "SHIELD OVERRIDE"
            step_magnitude = EMERGENCY_ACTION_STEP  # Rapid evasion step size
        else:
            action = self.choose_action(state)
            mode = "Learning" if self.epsilon > EPSILON_MIN * 1.5 else "Exploiting learned policy"
            step_magnitude = ACTION_STEP

        raw_mult = current_mult
        if action == "INCREASE":
            intended = raw_mult + step_magnitude
            mult = min(MULTIPLIER_MAX, intended)
        elif action == "DECREASE":
            intended = raw_mult - step_magnitude
            mult = max(MULTIPLIER_MIN, intended)
        else:
            intended = raw_mult
            mult = raw_mult

        boundary_hit = intended != mult

        self.multiplier[sat_idx] = mult
        self.last_state[sat_idx] = state
        self.last_action[sat_idx] = action
        self.last_boundary_hit[sat_idx] = boundary_hit
        self.prev_distance[sat_idx] = distance

        # Decay epsilon and alpha slightly per satellite step — alpha decay is what
        # stops the shared Q-table from perpetually re-writing itself on late-game noise
        self.epsilon = max(EPSILON_MIN, self.epsilon * EPSILON_DECAY)
        self.alpha = max(ALPHA_MIN, self.alpha * ALPHA_DECAY)
        self.total_steps += 1

        return {
            "sat_idx": sat_idx,
            "multiplier": round(mult, 3),
            "action": action,
            "state": f"{state[0]}/{state[1]}/{state[2]}",
            "mode": mode,
            "shielded": shielded,
            "boundary_hit": boundary_hit,
        }

    def step_batch(self, satellite_states):
        results = []
        for sat in satellite_states:
            res = self.step_satellite(
                sat_idx=sat["sat_idx"],
                distance=sat.get("distance"),
                had_collision=sat.get("had_collision", False),
                safe_direction=sat.get("safe_direction", "INCREASE"),
            )
            results.append(res)
        return results

    def debug_table(self):
        return {str(k): v for k, v in self.q_table.items()}

    def debug_multipliers(self):
        return {k: round(v, 3) for k, v in self.multiplier.items()}


agent = QLearningShieldAgent()