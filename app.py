"""
=============================================================================
AI-Based Disaster Evacuation & Safe Route Planner
app.py  --  Python AI Engine (Flask)
=============================================================================
Implements:
  1. Data Processing + Logistic Regression       -> /api/predict-flood
  2. Graph Search + Heuristics + A* Search        -> /api/safe-route
  3. Constraint Satisfaction Problem (CSP)        -> /api/recommend-shelter

Data source: MySQL database created by schema.sql (aquaevac_db)
=============================================================================
"""

import os
import math
import traceback

import numpy as np
import requests
import mysql.connector
from mysql.connector import Error as MySQLError

from flask import Flask, request, jsonify

from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import networkx as nx
from constraint import Problem


# =============================================================================
# CONFIG
# =============================================================================

DB_CONFIG = {
    "host": os.environ.get("DB_HOST", "localhost"),
    "user": os.environ.get("DB_USER", "root"),
    "password": os.environ.get("DB_PASSWORD", ""),
    "database": os.environ.get("DB_NAME", "aquaevac_db"),
}

# Optional: set this to a real OpenWeatherMap API key (free tier) to enable
# the "use live weather" button on the flood-prediction form. Elevation
# lookups use Open-Elevation, which is free and needs no key. Without a key,
# /api/live-weather returns a clear error and the form still works with
# manually typed numbers.
OPENWEATHER_API_KEY = os.environ.get("OPENWEATHER_API_KEY", "")
OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather"
OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"

# Weights used to convert (distance, hazard, traffic) into a single dynamic
# routing cost / heuristic penalty. Tunable.
HAZARD_WEIGHT = 1.5
TRAFFIC_WEIGHT = 0.8

# Default CSP thresholds (can be overridden per-request)
DEFAULT_MAX_DISTANCE_KM = 12.0   # H6: limit on the ROUTE length (graph path + off-graph legs)
DEFAULT_HAZARD_LIMIT = 0.6          # avg hazard_score along access route must be <= this
ATTACH_NODE_COUNT = 5               # E1: a person / shelter may join the road graph at any of its N nearest nodes
MAX_ATTACH_LEG_KM = 3.0             # E1: ...but only where the straight off-road walk to that node is at most this long
                                    #     (the single nearest node is always allowed, however far)
ATTACH_BAD_ROAD_RADIUS_KM = 1.0     # E3: a person this close to a node counts as standing AT it (see attach_nodes)
HIGH_RISK_HAZARD_CUTOFF = 0.6       # edges at/above this are treated as "high flood risk zones"
LEAST_RISK_HAZARD_WEIGHT = 10.0      # M14: when nothing is safe, hazard counts 10x per km (>= distance, so A* stays admissible)
SAME_NODE_MAX_KM = 1.6               # E4: a person this close to a shelter may join the graph AT the shelter's own node
                                    #     (short walk in, no detour); H5 still reports the real gap, never 0 km

# H6: travel modes. Walking cost = distance and hazard only (traffic does not
# slow a person on foot); driving keeps the distance + hazard + traffic cost.
# A blocked road (is_blocked) is impassable in BOTH modes.
VALID_TRAVEL_MODES = ("walk", "drive")
DEFAULT_ROUTE_MODE = "drive"     # /api/safe-route: unchanged behaviour when no mode is sent
DEFAULT_SHELTER_MODE = "walk"    # /api/recommend-shelter: evacuees are often on foot

# Risk level label mapping for the logistic regression classifier
RISK_LABELS = {0: "Low", 1: "Medium", 2: "High", 3: "Severe"}

# Static lookup of approximate coordinates for each named node in
# roads_graph. In a production system these would live in their own
# `graph_nodes` table; they are kept in-code here to match the node
# names seeded in schema.sql.
NODE_COORDS = {
    "Mirpur":      (23.8223, 90.3654),
    "Kazipara":    (23.8151, 90.3661),
    "Shewrapara":  (23.8065, 90.3673),
    "Dhanmondi":   (23.7461, 90.3742),
    "New Market":   (23.7331, 90.3852),
    "OldTown":     (23.7104, 90.4074),
    "Kotwali":     (23.7065, 90.4103),
    "Sadarghat":   (23.7038, 90.4088),
    "Uttara":      (23.8759, 90.3795),
    "Airport":     (23.8433, 90.4008),
    "Banani":      (23.7936, 90.4043),
    "Gulshan":     (23.7808, 90.4152),
    "Badda":       (23.7805, 90.4265),
    "Rampura":     (23.7580, 90.4256),
    "Malibagh":    (23.7484, 90.4127),
    "Motijheel":   (23.7331, 90.4172),
    "Mohammadpur": (23.7657, 90.3585),
    "Shyamoli":    (23.7746, 90.3654),
    "Tejgaon":     (23.7626, 90.3931),
    "Farmgate":    (23.7566, 90.3873),
    # Additional Dhaka landmarks requested for the safe-route selector.
    # Approximate neighborhood coordinates; road geometry remains the demo
    # network represented by roads_graph, not turn-by-turn OSM data.
    "Agargaon": (23.7777, 90.3785),
    "Kallyanpur": (23.7808, 90.3542),
    "Asad Gate": (23.7609, 90.3683),
    "Mohammadpur Bus Stand": (23.7635, 90.3587),
    "Gabtoli": (23.7842, 90.3445),
    "Technical Mor": (23.7908, 90.3534),
    "Bijoy Sarani": (23.7650, 90.3890),
    "Manik Mia Avenue": (23.7606, 90.3754),
    "Elephant Road": (23.7387, 90.3848),
    "Science Lab": (23.7393, 90.3840),
    "Kalabagan": (23.7460, 90.3839),
    "Panthapath": (23.7507, 90.3901),
    "Hatirpool": (23.7427, 90.3949),
    "Eskaton": (23.7454, 90.4013),
    "Kakrail": (23.7365, 90.4127),
    "Segunbagicha": (23.7309, 90.4058),
    "Purana Paltan": (23.7313, 90.4134),
    "Gulistan": (23.7239, 90.4105),
    "Wari": (23.7194, 90.4164),
    "Mugda": (23.7247, 90.4389),
    "Basabo": (23.7295, 90.4330),
    "Aftabnagar": (23.7652, 90.4358),
    "Merul Badda": (23.7739, 90.4293),
    "Natun Bazar": (23.7930, 90.4240),
    "Mohakhali": (23.7776, 90.4042),
    "Moghbazar": (23.7500, 90.4089),
    "Shahbagh": (23.7389, 90.3954),
    "Karwan Bazar": (23.7501, 90.3915),
    "Jatrabari": (23.7108, 90.4350),
    "Sayedabad": (23.7105, 90.4266),
    "Bashundhara": (23.8150, 90.4250),
    "Kuril": (23.8240, 90.4250),
    "Khilgaon": (23.7370, 90.4240),
    "Paltan": (23.7290, 90.4140),
    "Lalbagh": (23.7180, 90.3880),
}


# =============================================================================
# DATABASE HELPER
# =============================================================================

def get_db_connection():
    """Open a fresh MySQL connection using DB_CONFIG."""
    return mysql.connector.connect(**DB_CONFIG)


def fetch_all(query, params=None):
    """Run a SELECT query and return rows as a list of dicts."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute(query, params or ())
        rows = cursor.fetchall()
        cursor.close()
        return rows
    finally:
        conn.close()


def haversine_km(coord1, coord2):
    """Great-circle distance between two (lat, lon) points, in kilometers."""
    lat1, lon1 = coord1
    lat2, lon2 = coord2
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (math.sin(d_phi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def nearest_node(lat, lon):
    """Map an arbitrary (lat, lon) to the closest known graph node."""
    best_node, best_dist = None, float("inf")
    for node, coord in NODE_COORDS.items():
        d = haversine_km((lat, lon), coord)
        if d < best_dist:
            best_node, best_dist = node, d
    return best_node, best_dist


def nearest_nodes(lat, lon, count=None):
    """
    E1: the graph nodes ordered by straight-line distance from (lat, lon),
    nearest first; `count` limits the list (None = every node). A person or a
    shelter is not forced onto the single closest node any more (that node can
    be behind them), see find_access_route().
    """
    ranked = sorted(
        ((haversine_km((lat, lon), coord), node) for node, coord in NODE_COORDS.items()),
        key=lambda pair: pair[0],
    )
    return [(node, d) for d, node in ranked[:count]]


# =============================================================================
# CONCEPT 1: DATA PROCESSING + LOGISTIC REGRESSION  (flood risk prediction)
# =============================================================================

# The model is cached for speed, but the dataset signature is also cached.
# If an admin changes flood_data, the signature changes and the model retrains.
_flood_model_cache = {"model": None, "scaler": None, "signature": None, "rows": 0}


def _map_risk_to_class(risk_level):
    """Keep the database's four risk levels as four real ML classes."""
    mapping = {
        "low": 0,
        "moderate": 1,
        "high": 2,
        "severe": 3,
    }
    return mapping.get(str(risk_level).lower(), 1)


# M10: physical limits for /api/predict-flood inputs (inclusive)
FLOOD_INPUT_RANGES = {
    "rainfall_mm": (0.0, 2000.0),
    "river_level_m": (0.0, 100.0),
    "elevation_m": (0.0, 9000.0),
}


class FloodInputError(ValueError):
    """Bad /api/predict-flood input; the message is safe to show the caller."""


def _read_flood_number(payload, name, low, high):
    """Return payload[name] as a finite float inside [low, high], else FloodInputError."""
    value = payload.get(name)
    # bool is a subclass of int, so it must be rejected explicitly
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FloodInputError(f"{name} must be a number.")
    value = float(value)
    if not math.isfinite(value):
        raise FloodInputError(f"{name} must be a finite number.")
    if value < low or value > high:
        raise FloodInputError(f"{name} must be between {low:g} and {high:g}.")
    return value


def get_flood_data_signature():
    """Return a small fingerprint that changes when flood training data changes.

    M9: row count / max id / latest recorded_at ignore an UPDATE of an existing
    row, so the checksum of the four training columns is included too.
    """
    rows = fetch_all(
        "SELECT COUNT(*) AS row_count, "
        "COALESCE(MAX(id), 0) AS max_id, "
        "COALESCE(MAX(recorded_at), '1970-01-01 00:00:00') AS latest_recorded_at, "
        "COALESCE(SUM(CRC32(CONCAT_WS('|', id, rainfall_mm, river_level_m, "
        "elevation_m, risk_level))), 0) AS data_checksum "
        "FROM flood_data"
    )
    row = rows[0]
    return (
        int(row["row_count"]),
        int(row["max_id"]),
        str(row["latest_recorded_at"]),
        str(row["data_checksum"]),
    )


def invalidate_flood_model():
    """Clear the cached model so the next prediction trains from current data."""
    _flood_model_cache["model"] = None
    _flood_model_cache["scaler"] = None
    _flood_model_cache["signature"] = None
    _flood_model_cache["rows"] = 0


def train_flood_model():
    """
    DATA PROCESSING:
      - Pulls raw environmental readings from flood_data
      - Scales/normalizes features (rainfall_mm, river_level_m, elevation_m)
        using StandardScaler (zero mean, unit variance)

    LOGISTIC REGRESSION:
      - Trains a multi-class scikit-learn LogisticRegression classifier
        on the scaled features to predict flood risk class (0/1/2/3)
    """
    # M9: fingerprint first, then read the rows, so an edit that lands between
    # the two makes the next request retrain instead of trusting a stale model.
    signature = get_flood_data_signature()
    rows = fetch_all(
        "SELECT rainfall_mm, river_level_m, elevation_m, risk_level FROM flood_data"
    )
    if len(rows) < 5:
        raise RuntimeError(
            "Not enough flood_data rows to train the logistic regression model."
        )

    X_raw = np.array(
        [[r["rainfall_mm"], r["river_level_m"], r["elevation_m"]] for r in rows],
        dtype=float,
    )
    y = np.array([_map_risk_to_class(r["risk_level"]) for r in rows], dtype=int)

    # --- Data Processing: feature scaling/normalization ---
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_raw)

    # --- Model training ---
    # (scikit-learn >= 1.5 auto-selects multinomial handling for
    # multi-class targets, so no explicit multi_class= kwarg is needed)
    model = LogisticRegression(max_iter=1000)
    model.fit(X_scaled, y)

    _flood_model_cache["model"] = model
    _flood_model_cache["scaler"] = scaler
    _flood_model_cache["signature"] = signature
    _flood_model_cache["rows"] = len(rows)
    return model, scaler


def get_flood_model():
    """Return a current model; automatically retrain after data changes."""
    current_signature = get_flood_data_signature()
    if (
        _flood_model_cache["model"] is None
        or _flood_model_cache["scaler"] is None
        or _flood_model_cache["signature"] != current_signature
    ):
        train_flood_model()
    return _flood_model_cache["model"], _flood_model_cache["scaler"]


# =============================================================================
# CONCEPT 2: GRAPH SEARCH + HEURISTICS + A*  (safe route planning)
# =============================================================================

def build_road_graph():
    """
    Builds a NetworkX undirected graph from roads_graph.
    Edges flagged is_blocked = TRUE are excluded entirely, so A* can never
    route through a blocked road.

    Each edge stores:
      - distance_km      : raw physical distance (base g-cost component)
      - hazard_score      : 0..1 flood/hazard danger
      - traffic_density    : 0..1 congestion level
      - cost              : dynamic weighted cost used by A* as edge weight
                              cost = distance_km * (1 + HAZARD_WEIGHT*hazard
                                                       + TRAFFIC_WEIGHT*traffic)
      - cost_walk         : same without the traffic term (H6, walking mode)
    """
    rows = fetch_all(
        """SELECT node_a, node_b, distance_km, hazard_score, traffic_density
           FROM roads_graph
           WHERE is_blocked = FALSE"""
    )
    blocked_rows = fetch_all(
        """SELECT node_a, node_b
           FROM roads_graph
           WHERE is_blocked = TRUE"""
    )

    G = nx.Graph()
    # E3: remember which node pairs are joined by a BLOCKED road, so an
    # off-graph leg can never be used to "walk through" one (see attach_nodes).
    G.graph["blocked_pairs"] = {frozenset((r["node_a"], r["node_b"])) for r in blocked_rows}
    # ...and the pairs joined only by a high-hazard road (the safe route may not
    # use it, so a straight leg must not replace it either).
    G.graph["hazard_pairs"] = {
        frozenset((r["node_a"], r["node_b"]))
        for r in rows if float(r["hazard_score"]) >= HIGH_RISK_HAZARD_CUTOFF
    }
    for node in NODE_COORDS:
        G.add_node(node)

    for r in rows:
        distance = float(r["distance_km"])
        hazard = float(r["hazard_score"])
        traffic = float(r["traffic_density"])
        dynamic_cost = distance * (1 + HAZARD_WEIGHT * hazard + TRAFFIC_WEIGHT * traffic)
        walk_cost = distance * (1 + HAZARD_WEIGHT * hazard)

        G.add_edge(
            r["node_a"], r["node_b"],
            distance_km=distance,
            hazard_score=hazard,
            traffic_density=traffic,
            cost=dynamic_cost,
            cost_walk=walk_cost,
        )
    return G


def make_heuristic(G):
    """
    Build a safe A* heuristic.

    Road distances in a demo graph are data, so we do not blindly assume
    every stored road distance is longer than the straight-line distance.
    We calculate the smallest observed road/geographic ratio and multiply
    the straight-line distance by that ratio. The result stays admissible
    for this graph while remaining more useful than h(n)=0.
    """
    ratios = []
    for u, v, data in G.edges(data=True):
        if u in NODE_COORDS and v in NODE_COORDS:
            geo = haversine_km(NODE_COORDS[u], NODE_COORDS[v])
            road = float(data.get("distance_km", 0.0))
            if geo > 0 and road > 0:
                ratios.append(road / geo)

    distance_scale = min(1.0, min(ratios)) if ratios else 0.0

    def heuristic(u, v):
        if u not in NODE_COORDS or v not in NODE_COORDS:
            return 0.0
        return haversine_km(NODE_COORDS[u], NODE_COORDS[v]) * distance_scale

    return heuristic

def edge_weight_for(mode):
    """Weight function handed to nx.astar_path -- uses the precomputed
    dynamic cost of the chosen travel mode (distance + hazard [+ traffic for
    driving]) rather than raw distance, so the search itself is hazard-aware,
    not just the heuristic. Both costs are >= distance_km, so the
    straight-line heuristic stays admissible in either mode."""
    key = "cost_walk" if mode == "walk" else "cost"

    def weight(u, v, d):
        return d.get(key, d.get("distance_km", 1.0))

    return weight


def parse_travel_mode(value, default):
    """H6: return a valid travel mode or raise ValueError (endpoints answer 400)."""
    mode = default if value is None else value
    if not isinstance(mode, str) or mode not in VALID_TRAVEL_MODES:
        raise ValueError(
            f"Unknown travel mode {value!r}. Use one of: {', '.join(VALID_TRAVEL_MODES)}."
        )
    return mode


def route_length_km(G, path, from_latlon, to_latlon):
    """
    H6: the length of the trip the person really makes -- the graph path plus
    the two straight off-graph legs (real start -> first node, last node ->
    real end), the same figure the dashboard shows for responder routes (H5).
    When both points snap to the same node the graph says nothing, so the
    straight-line distance is used.
    """
    if len(path) < 2:
        return haversine_km(from_latlon, to_latlon)
    graph_km = sum(G[a][b]["distance_km"] for a, b in zip(path[:-1], path[1:]))
    legs_km = (haversine_km(from_latlon, NODE_COORDS[path[0]])
               + haversine_km(NODE_COORDS[path[-1]], to_latlon))
    return graph_km + legs_km


def summarize_path(G, path, mode):
    """Totals for one graph path (distance, dynamic cost, average hazard / traffic)."""
    total_distance = 0.0
    total_cost = 0.0
    hazard_scores = []
    traffic_scores = []

    for a, b in zip(path[:-1], path[1:]):
        edge = G[a][b]
        total_distance += edge["distance_km"]
        total_cost += edge["cost_walk" if mode == "walk" else "cost"]
        hazard_scores.append(edge["hazard_score"])
        traffic_scores.append(edge["traffic_density"])

    return {
        "path": path,
        "total_distance_km": round(total_distance, 3),
        "total_dynamic_cost": round(total_cost, 3),
        "avg_hazard_score": round(sum(hazard_scores) / len(hazard_scores), 3) if hazard_scores else 0.0,
        "avg_traffic_density": round(sum(traffic_scores) / len(traffic_scores), 3) if traffic_scores else 0.0,
        "hops": len(path) - 1,
    }


def compute_safe_route(start, end, mode=DEFAULT_ROUTE_MODE):
    """
    Runs A* Search (nx.astar_path) over the hazard-aware graph (H6: for a travel mode).

    E2: the answer is the SAFEST route (unchanged fields). Beside it the reply
    carries `shortest`: the route with the fewest kilometres (A* on plain
    distance_km, blocked roads still removed), so the person can see and choose
    when the safest road is a detour. `shortest.same_as_safest` is true when
    both are the same path.
    """
    G = build_road_graph()

    if start not in G.nodes or end not in G.nodes:
        raise ValueError(f"Unknown node(s): '{start}' and/or '{end}'.")

    heuristic = make_heuristic(G)

    try:
        path = nx.astar_path(G, start, end, heuristic=heuristic, weight=edge_weight_for(mode))
    except nx.NetworkXNoPath:
        raise LookupError(
            f"No safe route exists between '{start}' and '{end}' "
            f"(all connecting roads are blocked or disconnected)."
        )

    # Same roads and the same blocked-road removal, but cost = kilometres only.
    shortest_path = nx.astar_path(
        G, start, end, heuristic=heuristic,
        weight=lambda u, v, d: d["distance_km"],
    )
    shortest = summarize_path(G, shortest_path, mode)
    shortest["same_as_safest"] = shortest_path == path

    return {
        "mode": mode,
        **summarize_path(G, path, mode),
        "shortest": shortest,
    }


# =============================================================================
# CONCEPT 3: CONSTRAINT SATISFACTION PROBLEM (CSP)  (shelter recommendation)
# =============================================================================

def make_safe_graph(G):
    """A copy of G without the high-hazard edges (built once per request)."""
    safe_graph = G.copy()
    for u, v, data in list(safe_graph.edges(data=True)):
        if float(data.get("hazard_score", 0.0)) >= HIGH_RISK_HAZARD_CUTOFF:
            safe_graph.remove_edge(u, v)
    return safe_graph


def route_is_safe(G, start_node, end_node, hazard_limit, mode=DEFAULT_ROUTE_MODE, safe_graph=None, weight=None):
    """
    Find a route that satisfies the shelter safety rules FIRST.

    High-hazard edges are removed before pathfinding. A* then minimizes the
    normal dynamic cost of the travel mode among the remaining safe edges.
    (E1: `safe_graph` lets the caller build the filtered graph once and reuse
    it for many node pairs.)
    """
    if safe_graph is None:
        safe_graph = make_safe_graph(G)

    try:
        path = nx.astar_path(
            safe_graph,
            start_node,
            end_node,
            heuristic=make_heuristic(safe_graph),
            weight=weight or edge_weight_for(mode),
        )
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return False, None, None

    hazards = [
        float(safe_graph[a][b]["hazard_score"])
        for a, b in zip(path[:-1], path[1:])
    ]
    avg_hazard = sum(hazards) / len(hazards) if hazards else 0.0

    if avg_hazard > hazard_limit:
        return False, avg_hazard, path

    return True, avg_hazard, path


def attach_nodes(G, latlon, count=None, max_leg_km=MAX_ATTACH_LEG_KM):
    """
    E1/E3: the graph nodes a point may join the road graph at, nearest first.

    The straight off-road leg to a node is meant to be a short walk ONTO a road,
    never a substitute for a road the person must not use. So:
    - The nearest node is always allowed. Further nodes only if the straight
      leg to them is at most `max_leg_km` (None = no limit).
    - If the person stands AT an accepted node (within ATTACH_BAD_ROAD_RADIUS_KM)
      and a BLOCKED road, or a road too hazardous for the safe route, leaves
      that node, the node at its other end is skipped: the leg would just run
      along that road and dodge the rule. (Someone standing at Kotwali must not
      be led over the blocked Kotwali-OldTown road as if it were a short walk
      to OldTown.) Someone further away keeps every node: their leg does not
      follow that road.
    """
    bad_pairs = G.graph.get("blocked_pairs", set()) | G.graph.get("hazard_pairs", set())
    chosen = []      # (node, straight leg km)
    for node, leg_km in nearest_nodes(*latlon):
        if chosen and max_leg_km is not None and leg_km > max_leg_km:
            break
        if any(frozenset((node, other)) in bad_pairs and other_km <= ATTACH_BAD_ROAD_RADIUS_KM
               for other, other_km in chosen):
            continue
        chosen.append((node, leg_km))
        if count is not None and len(chosen) >= count:
            break
    return [node for node, _ in chosen]


def find_access_route(G, safe_graph, from_latlon, to_latlon, hazard_limit, mode=DEFAULT_ROUTE_MODE, weight=None):
    """
    E1 + E3: the access route for a person -> shelter trip.

    The old code joined the person to ONE node (the closest by straight line,
    even when it lies behind them) and the shelter to ONE node, so the trip
    often doubled back. Here the person may join the road graph at any of the
    nodes attach_nodes() allows (up to ATTACH_NODE_COUNT) and the shelter
    likewise; every pair is tried and the SAFE pair with the shortest real trip
    (route_length_km = leg + graph path + leg) wins.

    - If the nearest nodes are cut off (no open road connects ANY pair, hazard
      ignored), the pass is repeated with EVERY node as the person's entry
      point, nearest first. That is how someone standing in a cut-off area
      reaches the nearest node that is still connected (E3). A pair that is
      connected only through high-hazard roads is NOT widened: the answer stays
      "unsafe" rather than sending the person across the flood in a straight line.
    - Two different nodes are always used, except (H5) when the person and the
      shelter both have the same single nearest node, or (E4) when the person is
      within SAME_NODE_MAX_KM of the shelter and may join the graph at the
      shelter's own node: then the straight line between them is the trip.
      Otherwise "graph routes only".

    Returns (safe, avg_hazard, path, connected) -- the first three like
    route_is_safe(); `connected` says whether ANY open road links the two ends
    (False = blocked roads cut the person off, True with path None = only
    high-hazard roads are left).
    """
    near_from = attach_nodes(G, from_latlon, ATTACH_NODE_COUNT)
    near_to = attach_nodes(G, to_latlon, ATTACH_NODE_COUNT)
    direct_km = haversine_km(from_latlon, to_latlon)

    def same_node_allowed(node):
        # H5: both share the same single nearest node -> the straight line is the trip.
        if node == near_from[0] == near_to[0]:
            return True
        # E4: the person is a short walk from the shelter and may join the graph
        # at the shelter's own node (an attach node for them too), instead of
        # being sent to a different node and back. route_length_km() then
        # returns the real straight gap (never 0 km).
        return direct_km <= SAME_NODE_MAX_KM and node in near_from

    def search(starts, ends):
        best_safe = None      # (length, avg_hazard, path)
        best_unsafe = None
        connected = False
        for s_node in starts:
            for e_node in ends:
                if s_node == e_node and not same_node_allowed(s_node):
                    continue
                if not connected and nx.has_path(G, s_node, e_node):
                    connected = True
                safe, avg_hazard, path = route_is_safe(G, s_node, e_node, hazard_limit, mode, safe_graph, weight)
                if path is None:
                    continue
                length = route_length_km(G, path, from_latlon, to_latlon)
                candidate = (length, avg_hazard, path)
                if safe:
                    if best_safe is None or length < best_safe[0]:
                        best_safe = candidate
                elif best_unsafe is None or length < best_unsafe[0]:
                    best_unsafe = candidate
        return best_safe, best_unsafe, connected

    best_safe, best_unsafe, connected = search(near_from, near_to)
    if not connected:
        best_safe, best_unsafe, connected = search(attach_nodes(G, from_latlon, None, None), near_to)

    if best_safe is not None:
        return True, best_safe[1], best_safe[2], connected
    if best_unsafe is not None:
        return False, best_unsafe[1], best_unsafe[2], connected
    return False, None, None, connected


def find_least_risk_shelter(G, evacuee_latlon, shelters_by_id, capacity_ok, max_distance_km, mode):
    """
    M14: used only when NO shelter passes the safety rules. Among the shelters
    that are open, have room and are within the distance limit, return the one
    reached over the least hazardous roads (average hazard first, route length
    second). Blocked roads are still never used (they are not in G). Returns
    None when no such shelter has any open road to it.
    """
    def weight(u, v, d):
        return d["distance_km"] * (1 + LEAST_RISK_HAZARD_WEIGHT * d["hazard_score"])

    best = None   # (avg_hazard, length, shelter_id, path)
    for sid, s in shelters_by_id.items():
        if not capacity_ok(sid):
            continue
        shelter_latlon = (float(s["latitude"]), float(s["longitude"]))
        # hazard_limit = infinity and the FULL graph: high-hazard roads are allowed here
        _safe, avg_hazard, path, _connected = find_access_route(
            G, G, evacuee_latlon, shelter_latlon, float("inf"), mode, weight
        )
        if path is None:
            continue
        length = route_length_km(G, path, evacuee_latlon, shelter_latlon)
        if length > max_distance_km:
            continue
        candidate = (round(avg_hazard or 0.0, 6), round(length, 6), sid, path)
        if best is None or candidate[:2] < best[:2]:
            best = candidate
    return best


def solve_shelter_csp(evacuee_lat, evacuee_lon, max_distance_km, hazard_limit,
                      mode=DEFAULT_SHELTER_MODE):
    """
    CSP FORMULATION
      Variable   : "shelter" (the shelter assigned to this evacuee)
      Domain     : IDs of shelters currently in the database
      Constraints:
        (a) Capacity constraint : current_occupancy + 1 <= capacity, status == 'open'
        (b) Distance constraint : ROUTE length (graph path + the two straight
                                    off-graph legs, see route_length_km) <=
                                    max_distance_km. H6: not the straight line.
        (c) Hazard constraint   : access route (evacuee -> shelter, via the
                                    road graph) must not pass through a
                                    high-flood-risk edge and must keep
                                    average hazard <= hazard_limit

    Uses the `python-constraint` library's backtracking solver
    (Problem / addVariable / addConstraint) to find every value in the
    domain that is consistent with all constraints, then ranks the
    consistent solutions to pick the single best shelter (H6: the shortest
    route wins; average hazard only breaks ties, because the hazard limit is
    already a hard constraint).

    mode ("walk" / "drive") picks the edge cost A* minimises; blocked roads
    are removed in both modes.

    E1: the person and each shelter join the road graph at the best of their
    ATTACH_NODE_COUNT nearest nodes (find_access_route), not at one node.
    Returns (best, rejected, error, fallback); `fallback` is only set when no
    shelter with room has any open road to it (E3).
    """
    shelters = fetch_all(
        "SELECT id, name, latitude, longitude, capacity, current_occupancy, status FROM shelters"
    )
    if not shelters:
        return None, [], "No shelters exist in the database.", None

    shelters_by_id = {s["id"]: s for s in shelters}
    G = build_road_graph()
    safe_graph = make_safe_graph(G)

    # ---- Precompute constraint-check data per shelter (used by the CSP
    # constraint functions and later for ranking/explanation) ----
    details = {}
    for s in shelters:
        shelter_latlon = (float(s["latitude"]), float(s["longitude"]))
        # E1/E3: join the graph at the best of several nearby nodes, not one.
        safe, avg_hazard, path, connected = find_access_route(
            G, safe_graph, (evacuee_lat, evacuee_lon), shelter_latlon, hazard_limit, mode
        )
        # H6: no path at all (blocked / disconnected) -> no route length; the
        # hazard constraint already rules such a shelter out ("unsafe_route").
        distance_km = (route_length_km(G, path, (evacuee_lat, evacuee_lon), shelter_latlon)
                       if path else None)
        details[s["id"]] = {
            "distance_km": distance_km,
            "avg_hazard": avg_hazard,
            "access_route": path,
            "route_is_safe": safe,
            "connected": connected,
        }

    # ---- Build and solve the CSP ----
    problem = Problem()
    problem.addVariable("shelter", list(shelters_by_id.keys()))

    def capacity_constraint(shelter_id):
        s = shelters_by_id[shelter_id]
        return s["status"] == "open" and (s["current_occupancy"] + 1) <= s["capacity"]

    def distance_constraint(shelter_id):
        d = details[shelter_id]["distance_km"]
        return d is None or d <= max_distance_km

    def hazard_constraint(shelter_id):
        return details[shelter_id]["route_is_safe"]

    problem.addConstraint(capacity_constraint, ["shelter"])
    problem.addConstraint(distance_constraint, ["shelter"])
    problem.addConstraint(hazard_constraint, ["shelter"])

    solutions = problem.getSolutions()  # every shelter_id consistent with ALL constraints

    rejected = []
    consistent_ids = {sol["shelter"] for sol in solutions}
    for sid, s in shelters_by_id.items():
        if sid not in consistent_ids:
            reasons = []
            if not capacity_constraint(sid):
                reasons.append("capacity_or_status")
            if not distance_constraint(sid):
                reasons.append("too_far")
            if not details[sid]["connected"]:
                reasons.append("no_open_road")   # E3: not one open road reaches it
            if not hazard_constraint(sid):
                reasons.append("unsafe_route")
            rejected.append({"shelter_id": sid, "name": s["name"], "reasons": reasons})

    if not solutions:
        # E3: when the shelters that still have room are ALL unreachable because
        # no open road leads to them, say so and name the nearest one by straight
        # line. It is NOT a route (a straight line ignores flooded roads); the
        # client labels it that way.
        fallback = None
        with_room = [sid for sid in shelters_by_id if capacity_constraint(sid)]
        if with_room and all(not details[sid]["connected"] for sid in with_room):
            nearest_id = min(
                with_room,
                key=lambda sid: haversine_km(
                    (evacuee_lat, evacuee_lon),
                    (float(shelters_by_id[sid]["latitude"]), float(shelters_by_id[sid]["longitude"])),
                ),
            )
            ns = shelters_by_id[nearest_id]
            fallback = {
                "shelter_id": ns["id"],
                "name": ns["name"],
                "latitude": float(ns["latitude"]),
                "longitude": float(ns["longitude"]),
                "straight_line_km": round(haversine_km(
                    (evacuee_lat, evacuee_lon),
                    (float(ns["latitude"]), float(ns["longitude"])),
                ), 3),
                "reason": "no_open_road",
            }
        # M14: nothing is safe, but a shelter with room may still be reachable over
        # open (if flooded) roads. Return the least hazardous one, clearly marked
        # high risk, instead of no answer. Shelters cut off by blocked roads stay
        # on the E3 path above.
        least = find_least_risk_shelter(
            G, (evacuee_lat, evacuee_lon), shelters_by_id, capacity_constraint, max_distance_km, mode
        )
        if least is not None:
            _avg, _length, sid, path = least
            ls = shelters_by_id[sid]
            shelter_latlon = (float(ls["latitude"]), float(ls["longitude"]))
            path_hazards = [float(G[a][b]["hazard_score"]) for a, b in zip(path[:-1], path[1:])]
            avg_h = sum(path_hazards) / len(path_hazards) if path_hazards else 0.0
            result = {
                "shelter_id": ls["id"],
                "name": ls["name"],
                "latitude": shelter_latlon[0],
                "longitude": shelter_latlon[1],
                "capacity": ls["capacity"],
                "current_occupancy": ls["current_occupancy"],
                "distance_km": round(route_length_km(G, path, (evacuee_lat, evacuee_lon), shelter_latlon), 3),
                "travel_mode": mode,
                "avg_hazard_on_route": round(avg_h, 3),
                "max_hazard_on_route": round(max(path_hazards), 3) if path_hazards else 0.0,
                "access_route": path,
                "candidates_considered": len(shelters),
                "candidates_satisfying_constraints": 0,
                "high_risk": True,
                "high_risk_warning": ("HIGH FLOOD RISK - no shelter can be reached by a safe route. "
                                      "This is the least dangerous way; use it only if you cannot wait. "
                                      "If you are in danger, send an SOS."),
            }
            return result, rejected, None, None
        return None, rejected, "No shelter satisfies all constraints (capacity, distance, hazard).", fallback

    # ---- Rank consistent solutions: shortest route first (H6) ----
    # Hazard is already limited by the hazard constraint; it only breaks ties.
    def score(sol):
        d = details[sol["shelter"]]
        return (round(d["distance_km"], 6), d["avg_hazard"] or 0.0)

    best = min(solutions, key=score)
    best_shelter = shelters_by_id[best["shelter"]]
    best_detail = details[best["shelter"]]

    result = {
        "shelter_id": best_shelter["id"],
        "name": best_shelter["name"],
        "latitude": float(best_shelter["latitude"]),
        "longitude": float(best_shelter["longitude"]),
        "capacity": best_shelter["capacity"],
        "current_occupancy": best_shelter["current_occupancy"],
        "distance_km": round(best_detail["distance_km"], 3),  # H6: route length
        "travel_mode": mode,
        "avg_hazard_on_route": round(best_detail["avg_hazard"], 3) if best_detail["avg_hazard"] is not None else None,
        "access_route": best_detail["access_route"],
        "candidates_considered": len(shelters),
        "candidates_satisfying_constraints": len(solutions),
    }
    return result, rejected, None, None


def explain_no_shelter(rejected, max_distance_km):
    """
    E3: one plain sentence for "why is there no shelter", from the reasons of the
    shelters that still have room (status open and space left). Instead of a
    bare "No shelter satisfies all constraints".
    """
    with_room = [r for r in rejected if "capacity_or_status" not in r["reasons"]]
    if not with_room:
        return "Every shelter is full, closed or damaged right now."
    if all("no_open_road" in r["reasons"] for r in with_room):
        return "No open road leads from your position to any shelter with room (the roads are blocked)."
    if all("unsafe_route" in r["reasons"] for r in with_room):
        return ("Every way from your position to a shelter with room runs through high flood-risk "
                "roads. If you are in danger, send an SOS.")
    if all(r["reasons"] == ["too_far"] for r in with_room):
        return f"Every shelter with room is more than {max_distance_km:g} km away by road."
    return "No shelter with room can be reached safely within the distance limit."


# =============================================================================
# FLASK APP
# =============================================================================

app = Flask(__name__)
# No CORS here on purpose: the browser only ever talks to PHP (api_proxy.php),
# and PHP calls this service server-to-server on 127.0.0.1, so cross-origin
# access is not needed (AGENT.md section 19). Do not add blanket CORS(app).


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "disaster-evac-ai-engine"})


@app.route("/api/nodes", methods=["GET"])
def list_nodes():
    """Helper endpoint: lists valid road-graph node names for testing /api/safe-route."""
    return jsonify({"nodes": sorted(NODE_COORDS.keys())})


# -----------------------------------------------------------------------
# LIVE WEATHER + ELEVATION (real data, optional)
# -----------------------------------------------------------------------
@app.route("/api/live-weather", methods=["GET"])
def live_weather():
    """
    Pulls REAL current data for a coordinate, to auto-fill the flood
    prediction form instead of typing numbers by hand:
      - rainfall_mm : from OpenWeatherMap's current weather (rain.1h, mm),
                       0 if it isn't currently raining there. Requires
                       OPENWEATHER_API_KEY to be set.
      - elevation_m : from Open-Elevation (free, no API key needed).

    There is no free, standard public API for real-time river gauge level,
    so river_level_m is intentionally NOT auto-filled here — the person
    still enters that one themselves (or an admin wires up a real river
    authority feed later).

    GET /api/live-weather?latitude=..&longitude=..
    """
    try:
        lat = request.args.get("latitude", type=float)
        lon = request.args.get("longitude", type=float)
        if lat is None or lon is None:
            return jsonify({"error": "latitude and longitude query params are required."}), 400

        result = {"latitude": lat, "longitude": lon, "rainfall_mm": None, "elevation_m": None, "warnings": []}

        # --- Elevation (Open-Elevation, no key required) ---
        try:
            elev_resp = requests.get(OPEN_ELEVATION_URL, params={"locations": f"{lat},{lon}"}, timeout=5)
            elev_resp.raise_for_status()
            elev_data = elev_resp.json()
            result["elevation_m"] = float(elev_data["results"][0]["elevation"])
        except Exception as exc:
            result["warnings"].append(f"Elevation lookup failed: {exc}")

        # --- Rainfall (OpenWeatherMap, needs OPENWEATHER_API_KEY) ---
        if not OPENWEATHER_API_KEY:
            result["warnings"].append(
                "OPENWEATHER_API_KEY is not set on the server, so rainfall could not be fetched live. "
                "Enter rainfall manually, or set OPENWEATHER_API_KEY (see README)."
            )
        else:
            try:
                weather_resp = requests.get(
                    OPENWEATHER_URL,
                    params={"lat": lat, "lon": lon, "appid": OPENWEATHER_API_KEY, "units": "metric"},
                    timeout=5,
                )
                weather_resp.raise_for_status()
                weather_data = weather_resp.json()
                # OpenWeatherMap only reports rain volume when it's actually
                # raining; absence of "rain" means 0mm right now.
                result["rainfall_mm"] = float(weather_data.get("rain", {}).get("1h", 0.0))
                result["weather_description"] = (weather_data.get("weather") or [{}])[0].get("description")
                result["temperature_c"] = weather_data.get("main", {}).get("temp")
            except Exception as exc:
                result["warnings"].append(f"Live rainfall lookup failed: {exc}")

        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------
# 1) DATA PROCESSING + LOGISTIC REGRESSION
# -----------------------------------------------------------------------
@app.route("/api/predict-flood", methods=["POST"])
def predict_flood():
    try:
        payload = request.get_json(force=True, silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Request body must be a JSON object."}), 400
        required = ["rainfall_mm", "river_level_m", "elevation_m"]
        missing = [f for f in required if f not in payload]
        if missing:
            return jsonify({"error": f"Missing fields: {missing}"}), 400

        rainfall = _read_flood_number(payload, "rainfall_mm", *FLOOD_INPUT_RANGES["rainfall_mm"])
        river_level = _read_flood_number(payload, "river_level_m", *FLOOD_INPUT_RANGES["river_level_m"])
        elevation = _read_flood_number(payload, "elevation_m", *FLOOD_INPUT_RANGES["elevation_m"])

        model, scaler = get_flood_model()

        # --- Data Processing: normalize/scale the incoming raw input
        # using the SAME scaler fitted on the training data ---
        X_input = np.array([[rainfall, river_level, elevation]])
        X_scaled = scaler.transform(X_input)

        predicted_class = int(model.predict(X_scaled)[0])
        probabilities = model.predict_proba(X_scaled)[0]

        # M10: always return all four labels (0 for a class the data never had)
        confidence = {label: 0.0 for label in RISK_LABELS.values()}
        for class_id, probability in zip(model.classes_, probabilities):
            confidence[RISK_LABELS[int(class_id)]] = round(float(probability), 4)

        return jsonify({
            "input": {
                "rainfall_mm": rainfall,
                "river_level_m": river_level,
                "elevation_m": elevation,
            },
            "predicted_risk_level": predicted_class,
            "risk_label": RISK_LABELS[predicted_class],
            "confidence": confidence,
            # M13: say how little (or much) data the numbers come from
            "trained_on_rows": int(_flood_model_cache["rows"]),
        })

    except FloodInputError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        # M10: log the details, never send library error text to the client
        traceback.print_exc()
        return jsonify({"error": "Flood prediction failed. Please try again later."}), 500


# -----------------------------------------------------------------------
# 2) GRAPH SEARCH + HEURISTIC + A*
# -----------------------------------------------------------------------
@app.route("/api/safe-route", methods=["POST"])
def safe_route():
    try:
        payload = request.get_json(force=True) or {}
        start = payload.get("start")
        end = payload.get("end")
        if not start or not end:
            return jsonify({
                "error": "Both 'start' and 'end' node names are required.",
                "hint": "GET /api/nodes for the list of valid node names."
            }), 400

        mode = parse_travel_mode(payload.get("mode"), DEFAULT_ROUTE_MODE)
        result = compute_safe_route(start, end, mode)
        return jsonify({
            "start": start,
            "end": end,
            **result,
        })

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except LookupError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------
# 3) CONSTRAINT SATISFACTION PROBLEM (CSP)
# -----------------------------------------------------------------------
@app.route("/api/recommend-shelter", methods=["POST"])
def recommend_shelter():
    try:
        payload = request.get_json(force=True) or {}
        if "latitude" not in payload or "longitude" not in payload:
            return jsonify({"error": "Both 'latitude' and 'longitude' are required."}), 400

        lat = float(payload["latitude"])
        lon = float(payload["longitude"])
        max_distance_km = float(payload.get("max_distance_km", DEFAULT_MAX_DISTANCE_KM))
        hazard_limit = float(payload.get("hazard_limit", DEFAULT_HAZARD_LIMIT))

        try:
            mode = parse_travel_mode(payload.get("mode"), DEFAULT_SHELTER_MODE)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        best, rejected, error, fallback = solve_shelter_csp(lat, lon, max_distance_km, hazard_limit, mode)

        if best is None:
            return jsonify({
                "error": error,
                "explanation": explain_no_shelter(rejected, max_distance_km),
                "no_open_road": fallback is not None,
                "nearest_open_shelter_straight_line": fallback,   # E3: not a route, see solve_shelter_csp
                "constraints_used": {
                    "max_distance_km": max_distance_km,
                    "hazard_limit": hazard_limit,
                    "travel_mode": mode,
                },
                "rejected_shelters": rejected,
            }), 404

        return jsonify({
            "recommended_shelter": best,
            "constraints_used": {
                "max_distance_km": max_distance_km,
                "hazard_limit": hazard_limit,
                "travel_mode": mode,
            },
            "rejected_shelters": rejected,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------
# ERROR HANDLERS
# -----------------------------------------------------------------------
@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found."}), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error."}), 500


# =============================================================================
# ENTRY POINT
# =============================================================================
if __name__ == "__main__":
    # Warm up the logistic regression model at startup so the first
    # /api/predict-flood request isn't slowed down by training.
    try:
        train_flood_model()
        print("[startup] Flood risk logistic regression model trained successfully.")
    except Exception as exc:
        print(f"[startup] WARNING: could not pre-train flood model: {exc}")

    app.run(host="127.0.0.1", port=5000, debug=False)
