"""
NoobsCloud session broker.

Responsibilities:
  1. Accept "start session" requests from the frontend.
  2. Pick the least-loaded k3s node capable of running Redroid.
  3. Apply a per-session Redroid Deployment+Service manifest.
  4. Wait for the pod to be Ready, then write a Traefik dynamic-config
     fragment that routes /session/{id}/* -> that pod's ADB/scrcpy bridge.
  5. Return connection info to the frontend so web-scrcpy can attach.
  6. Expose a "stop session" endpoint that tears everything down.

This is a reference implementation — swap the k8s client calls out for
Docker SDK calls if you go the docker-compose-per-node route instead of k3s.
"""

import subprocess
import time
import uuid
import os
import asyncio
import httpx
import yaml
from pathlib import Path
from fastapi import FastAPI, HTTPException, Header
from kubernetes import client, config

app = FastAPI(title="NoobsCloud Broker")

NAMESPACE = "noobscloud"
MANIFEST_TEMPLATE = Path(__file__).parent.parent / "k3s" / "redroid-deployment.yaml"
TRAEFIK_DYNAMIC_DIR = Path(__file__).parent.parent / "traefik" / "sessions"
TRAEFIK_DYNAMIC_DIR.mkdir(parents=True, exist_ok=True)

ACCOUNTS_URL = os.environ.get("ACCOUNTS_URL", "http://accounts:8001")
BILLING_TICK_SECONDS = 60

config.load_kube_config()  # or load_incluster_config() if broker runs inside the cluster
apps_v1 = client.AppsV1Api()
core_v1 = client.CoreV1Api()

sessions: dict[str, dict] = {}


def pick_node() -> str:
    """Return the redroid-capable node with the fewest running Redroid pods."""
    nodes = core_v1.list_node(label_selector="redroid.io/capable=true").items
    if not nodes:
        raise HTTPException(503, "No redroid-capable nodes joined to the cluster")

    pods = core_v1.list_namespaced_pod(NAMESPACE, label_selector="app=redroid").items
    counts = {n.metadata.name: 0 for n in nodes}
    for p in pods:
        if p.spec.node_name in counts:
            counts[p.spec.node_name] += 1

    # naive least-loaded pick; swap in real capacity (CPU/mem/GPU headroom) as you scale
    return min(counts, key=counts.get)


def render_manifest(session_id: str) -> list[dict]:
    raw = MANIFEST_TEMPLATE.read_text().replace("{{SESSION_ID}}", session_id)
    return list(yaml.safe_load_all(raw))


def wait_for_ready(session_id: str, timeout: int = 60) -> str:
    """Poll until the pod is Running+Ready, return its pod IP."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pods = core_v1.list_namespaced_pod(
            NAMESPACE, label_selector=f"session={session_id}"
        ).items
        if pods:
            p = pods[0]
            ready = p.status.phase == "Running" and all(
                c.ready for c in (p.status.container_statuses or [])
            )
            if ready:
                return p.status.pod_ip
        time.sleep(2)
    raise HTTPException(504, "Redroid session did not become ready in time")


def write_traefik_route(session_id: str, pod_ip: str):
    """Drop a dynamic-config fragment Traefik picks up automatically (file provider)."""
    route = {
        "http": {
            "routers": {
                f"session-{session_id}": {
                    "rule": f"PathPrefix(`/session/{session_id}`)",
                    "service": f"session-{session_id}",
                }
            },
            "services": {
                f"session-{session_id}": {
                    "loadBalancer": {
                        "servers": [{"url": f"http://{pod_ip}:5555"}]
                    }
                }
            },
        }
    }
    (TRAEFIK_DYNAMIC_DIR / f"{session_id}.yml").write_text(yaml.dump(route))


@app.post("/session/start")
async def start_session(authorization: str = Header(...)):
    async with httpx.AsyncClient() as http:
        # Reserve the session with accounts FIRST — before spinning up any
        # infrastructure — so we never bill someone for a session that
        # failed to actually reserve credits, and never give away free
        # compute to someone with zero balance.
        session_id = uuid.uuid4().hex[:12]
        resp = await http.post(
            f"{ACCOUNTS_URL}/billing/session/start",
            json={"session_id": session_id},
            headers={"Authorization": authorization},
        )
        if resp.status_code == 402:
            raise HTTPException(402, "Insufficient credits")
        resp.raise_for_status()

    node = pick_node()

    for obj in render_manifest(session_id):
        if obj["kind"] == "Deployment":
            obj["spec"]["template"]["spec"]["nodeSelector"] = {"kubernetes.io/hostname": node}
            apps_v1.create_namespaced_deployment(NAMESPACE, obj)
        elif obj["kind"] == "Service":
            core_v1.create_namespaced_service(NAMESPACE, obj)

    pod_ip = wait_for_ready(session_id)
    write_traefik_route(session_id, pod_ip)

    sessions[session_id] = {"node": node, "pod_ip": pod_ip}
    asyncio.create_task(bill_session_until_stopped(session_id))

    return {
        "session_id": session_id,
        "node": node,
        "scrcpy_url": f"/session/{session_id}",
    }


async def bill_session_until_stopped(session_id: str):
    """Background loop: charge 1 credit/minute, tear the session down when
    the user runs out. Runs for as long as the session exists."""
    async with httpx.AsyncClient() as http:
        while session_id in sessions:
            await asyncio.sleep(BILLING_TICK_SECONDS)
            if session_id not in sessions:
                return
            try:
                resp = await http.post(f"{ACCOUNTS_URL}/billing/session/{session_id}/tick")
                resp.raise_for_status()
                result = resp.json()
            except httpx.HTTPError:
                # Accounts service unreachable — fail safe by stopping the
                # session rather than giving away free compute indefinitely.
                result = {"should_continue": False}

            if not result.get("should_continue", False):
                _teardown_session(session_id)
                await http.post(f"{ACCOUNTS_URL}/billing/session/{session_id}/stop")
                return


def _teardown_session(session_id: str):
    """Shared teardown logic used by both explicit stop and out-of-credits auto-stop."""
    if session_id not in sessions:
        return
    apps_v1.delete_namespaced_deployment(f"redroid-{session_id}", NAMESPACE)
    core_v1.delete_namespaced_service(f"redroid-{session_id}", NAMESPACE)
    route_file = TRAEFIK_DYNAMIC_DIR / f"{session_id}.yml"
    if route_file.exists():
        route_file.unlink()
    del sessions[session_id]


@app.post("/session/{session_id}/stop")
async def stop_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404, "Unknown session")

    _teardown_session(session_id)

    async with httpx.AsyncClient() as http:
        await http.post(f"{ACCOUNTS_URL}/billing/session/{session_id}/stop")

    return {"status": "stopped"}


@app.get("/session/{session_id}")
def session_status(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404, "Unknown session")
    return sessions[session_id]


@app.get("/nodes")
def list_nodes():
    nodes = core_v1.list_node(label_selector="redroid.io/capable=true").items
    return [n.metadata.name for n in nodes]


# --- App quick-launch -------------------------------------------------
# Generic launcher: given a session and a package name, sends an adb
# monkey intent to bring that app to the foreground (installing it first
# is a one-time step done manually inside the session, or via `adb install`
# — see docs/redroid-setup.md step 6).
#
# KNOWN_APPS is just a friendly-name -> package map for the frontend's
# picker UI. Add as many as you want. Launching isn't limited to this
# list though — /launch/by-package lets you launch any installed package
# directly, so users aren't locked to only what's in this dict.

KNOWN_APPS = {
    "clash-royale": "com.supercell.clashroyale",
    "clash-of-clans": "com.supercell.clashofclans",
    "brawl-stars": "com.supercell.brawlstars",
    "pubg-mobile": "com.tencent.ig",
    "genshin-impact": "com.miHoYo.GenshinImpact",
    "minecraft": "com.mojang.minecraftpe",
    "among-us": "com.innersloth.spacemafia",
}


def _adb_launch(pod_ip: str, package: str):
    subprocess.run(["adb", "connect", f"{pod_ip}:5555"], check=True, timeout=15)
    result = subprocess.run(
        ["adb", "-s", f"{pod_ip}:5555", "shell", "monkey",
         "-p", package, "-c", "android.intent.category.LAUNCHER", "1"],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0 or "No activities found" in result.stdout:
        raise HTTPException(
            409,
            f"Could not launch {package} — is it installed in this session? "
            f"(see docs/redroid-setup.md step 6)",
        )
    return {"status": "launched", "package": package}


@app.get("/apps")
def list_known_apps():
    """Friendly-name list for a frontend picker. Not exhaustive — see /launch/by-package."""
    return KNOWN_APPS


@app.post("/session/{session_id}/launch/{app_key}")
def launch_app(session_id: str, app_key: str):
    if session_id not in sessions:
        raise HTTPException(404, "Unknown session")
    if app_key not in KNOWN_APPS:
        raise HTTPException(404, f"Unknown app '{app_key}' — try /launch/by-package/{{package}} instead")

    package = KNOWN_APPS[app_key]
    pod_ip = sessions[session_id]["pod_ip"]
    return _adb_launch(pod_ip, package)


@app.post("/session/{session_id}/launch/by-package/{package}")
def launch_app_by_package(session_id: str, package: str):
    """Launch any installed package directly, bypassing the KNOWN_APPS list."""
    if session_id not in sessions:
        raise HTTPException(404, "Unknown session")

    pod_ip = sessions[session_id]["pod_ip"]
    return _adb_launch(pod_ip, package)
