# NoobsCloud

A self-hosted, multi-node mobile cloud gaming service: [Redroid](https://github.com/remote-android/redroid-doc) (Android-in-Docker) running across multiple Proxmox nodes, streamed to the browser via [web-scrcpy](https://github.com/NetrisTV/ws-scrcpy), fronted by a single gateway and a session broker that schedules each new session onto whichever node has room.

```
                     ┌─────────────────────────┐
   Browser  ───────▶ │   Gateway (Traefik)      │
                     │   + web-scrcpy frontend  │
                     │   + broker API            │
                     └───────────┬──────────────┘
                                 │ picks least-loaded node
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
          pve-node1        pve-node2        pve-node3 ...
          (k3s worker)     (k3s worker)     (k3s worker)
          Redroid pods     Redroid pods     Redroid pods
```

This repo is a **reference implementation** — the exact GPU passthrough, kernel module, and network details will vary with your hardware. Read each step, don't just run it blind.

---

## 0. What you need before starting

- Proxmox VE cluster with 2+ nodes (you already have this)
- web-scrcpy running somewhere (you already have this) — we'll point it at multiple backends instead of one
- A Debian 13.3.0 (Trixie) cloud-init template on each Proxmox node (VMID `9000` in the Terraform, adjust to yours)
- A domain or subdomain you can point at the gateway node (or reuse your existing Cloudflare Tunnel setup, same pattern as your other PDC services)
- Basic comfort with `kubectl`, Docker, and Terraform

---

## 1. Architecture decisions, explained

**Why a VM per Proxmox node instead of an LXC container?**
Redroid needs the `binder_linux` and `ashmem_linux` kernel modules loaded on the kernel that Docker's containers share. Loading custom modules on your actual Proxmox host kernel is risky (breaks cluster stability if it goes wrong) and not always possible depending on your Proxmox kernel version. A dedicated VM per node gives Redroid its own kernel to patch, isolated from Proxmox itself.

**Why k3s instead of just docker-compose per node?**
You said this needs to scale across nodes. Docker Compose has no concept of "which node has capacity" — you'd be SSHing into a specific node to start each session, and manually load-balancing yourself. k3s (or Nomad) gives you a scheduler: tell it "run this Redroid pod on a `redroid.io/capable=true` node" and it figures out placement. Adding a node later is just `k3s agent` joining the cluster — no broker code changes.

If you want something *lighter* than k3s (fewer moving parts, single Go binary), swap in [Nomad](https://www.nomadproject.io/) — the broker's `pick_node`/`apply manifest` logic maps over almost 1:1, just swap the Kubernetes client calls for Nomad's HTTP API.

**Why a broker service instead of scripting kubectl by hand?**
Because "start a session" needs to be one atomic action from the frontend's point of view: pick a node → deploy → wait for ready → wire up the route → hand back a URL. `broker/broker.py` does exactly that.

**Why Traefik with a file provider for routing?**
Session pods come and go constantly, each with a different internal IP. Traefik's file provider lets the broker just drop a YAML file per session (`traefik/sessions/<id>.yml`) and Traefik picks it up live — no reloads, no Traefik restarts.

---

## 2. Step-by-step deployment

### Step 1 — Build the cloud-init template
On one Proxmox node, create a minimal Debian 13.3.0 (Trixie) VM, install `qemu-guest-agent` and `cloud-init`, then convert it to a template. Note its VMID — you'll reference it in `terraform/main.tf` (`clone.vm_id`).

Debian's cloud images live at https://cloud.debian.org/images/cloud/trixie/ — the `generic` variant works fine as a Proxmox template base.

### Step 2 — Provision a Docker-host VM per worker node
```bash
cd terraform
export TF_VAR_proxmox_endpoint="https://sandpile.local:8006/"
export TF_VAR_proxmox_api_token="user@pve!noobscloud=xxxxxxxx-xxxx-..."
terraform init
terraform apply
```
Edit `variables.tf`'s `worker_nodes` map first to list every Proxmox node you want in the pool, their VMIDs, and static IPs.

**Create the API token safely:** Proxmox → Datacenter → Permissions → API Tokens → generate one scoped to a role with just VM-provisioning rights, not full root. Export it as an env var — never hardcode it in `.tf` files or commit it.

### Step 3 — Load binder/ashmem modules + join k3s
Set up the control node first (any small VM, even the gateway itself):
```bash
curl -sfL https://get.k3s.io | sh -
sudo cat /var/lib/rancher/k3s/server/node-token   # this is your K3S_TOKEN
```
Then, from your workstation:
```bash
cd ansible
cp inventory.ini.example inventory.ini   # fill in real IPs
export K3S_TOKEN="<token from above>"
ansible-playbook -i inventory.ini setup-docker-host.yml
```
This installs Docker, runs `scripts/install-binder-modules.sh` on each worker VM, and joins it to the k3s cluster with the `redroid.io/capable=true` label.

**Verify:**
```bash
kubectl get nodes --show-labels
ls -l /dev/binderfs   # on each worker VM — should exist after modprobe
```

### Step 4 — GPU passthrough (optional but recommended for real gaming perf)
Without a GPU, Redroid falls back to `llvmpipe` software rendering — playable for light apps, rough for anything graphically demanding.

Two paths:
- **Single GPU passthrough**: one physical GPU dedicated to one Docker-host VM (uncomment the `hostpci` block in `terraform/main.tf`). Simple, but that node only serves one session's worth of hardware acceleration well.
- **NVIDIA vGPU / SR-IOV**: splits one physical GPU into several virtual slices, each passed to a different session. Needs a supported datacenter/quadro-class card and NVIDIA's vGPU host driver on the Proxmox host. This is the real path to density — look at `nvidia-device-plugin` for Kubernetes once vGPU is working at the hypervisor level.

Once GPU passthrough works on a node, change that node's Redroid pods to `androidboot.redroid_gpu_mode=host` (see `k3s/redroid-deployment.yaml`).

### Step 5 — Deploy the gateway (Traefik + web-scrcpy frontend + broker)
On your gateway VM:
```bash
docker network create noobscloud-gw
docker run -d --name traefik --network noobscloud-gw \
  -p 80:80 -p 443:443 \
  -v $(pwd)/traefik/traefik.yml:/etc/traefik/traefik.yml \
  -v $(pwd)/traefik/dynamic.yml:/etc/traefik/dynamic.yml \
  -v $(pwd)/traefik/sessions:/etc/traefik/sessions \
  traefik:v3.1

# your existing web-scrcpy container, joined to the same network
docker run -d --name web-scrcpy --network noobscloud-gw ...

cd broker
pip install -r requirements.txt
cp ~/.kube/config .   # broker needs cluster access — or run it as an in-cluster pod
uvicorn broker:app --host 0.0.0.0 --port 8000
```
Point your existing Cloudflare Tunnel at `127.0.0.1:80` on the gateway, same pattern you already use elsewhere.

### Step 6 — Test end to end
```bash
curl -X POST http://gateway:8000/session/start
# → {"session_id": "a1b2c3d4e5f6", "node": "pve-node1", "scrcpy_url": "/session/a1b2c3d4e5f6"}
```
Open `https://your-domain/session/a1b2c3d4e5f6` in a browser — web-scrcpy should connect through Traefik straight to that pod's ADB port.

Tear it down:
```bash
curl -X POST http://gateway:8000/session/a1b2c3d4e5f6/stop
```

---

## 3. Scaling out later

Adding a node is just:
1. Add it to `terraform/variables.tf`'s `worker_nodes`, `terraform apply`
2. Add it to `ansible/inventory.ini`, re-run the playbook
3. `kubectl get nodes` — it should show up labeled and schedulable within a minute

The broker's `pick_node()` will start balancing new sessions onto it automatically since it queries live pod counts per node — no broker restart needed.

---

## 3.5. Single-instance Redroid testing + game picker (any installed game, not locked to one)

Before touching the cluster, test Redroid standalone: see
[`docs/redroid-setup.md`](docs/redroid-setup.md) — install modules, run one
container, connect adb, verify web-scrcpy renders it, install an APK.

For a game picker in your frontend (grid of known games + a manual
"launch by package name" field so users aren't limited to a fixed list),
the broker exposes:
- `GET /apps` — friendly-name → package map for the picker grid
- `POST /session/{id}/launch/{app_key}` — launch a known app by its short name
- `POST /session/{id}/launch/by-package/{package}` — launch *any* installed
  package directly, so the picker isn't a hard limit

See `broker/broker.py`'s `KNOWN_APPS` dict (add more games there any time)
and [`docs/frontend-launch-button.html`](docs/frontend-launch-button.html)
for the picker UI. It only foregrounds an app that's already installed in
that session — it doesn't install or download anything, and it doesn't
touch how an app detects the environment it's running in.

**Note on emulator/anti-cheat detection:** Redroid, like any Android
emulator, will be detectable by apps that check for it (Clash Royale
included — Supercell's ToS explicitly prohibits emulator use for exactly
this reason). This repo doesn't include anything to spoof device
fingerprints or hide root/emulator signals, and I'd steer away from adding
that — it's circumventing an anti-cheat/anti-fraud system, carries real
account-ban risk regardless of how well it works, and isn't something I'll
help build out. If your use case is just "play my own account casually
from the browser," that's what this repo already does; if it's about
getting past detection specifically, that's a different (and
ToS-violating) ask.

## 3.6. Accounts + credits (users spend 1 credit/minute)

The signup/login/credits system is a **separate service from the Redroid
hosts** — `accounts/accounts.py`. It owns user accounts, password hashes
(bcrypt), and a credit balance, and issues JWTs for the frontend to use.

Run it (anywhere — doesn't need GPU or binder, just a small VM or container):
```bash
cd accounts
pip install -r requirements.txt
export JWT_SECRET="$(openssl rand -hex 32)"   # generate once, keep stable across restarts
uvicorn accounts:app --host 0.0.0.0 --port 8001
```

**Billing flow:**
1. Frontend calls `/signup` or `/login` on the accounts service → gets a JWT
2. Frontend calls the broker's `POST /session/start` with `Authorization: Bearer <jwt>`
3. The broker calls accounts' `/billing/session/start` first — if the user has
   less than 1 credit, it's rejected (`402`) before any Redroid pod is created
4. Once billing is reserved, the broker schedules the Redroid pod as before
5. A background loop in the broker calls `/billing/session/{id}/tick` every
   60 seconds, deducting 1 credit per elapsed minute
6. When the tick response says `should_continue: false` (balance hit 0), the
   broker automatically tears down the session and stops billing

Set `ACCOUNTS_URL` as an env var on the broker (defaults to
`http://accounts:8001`) so it knows where to reach the accounts service.

**What's stubbed, not built:** `/credits/add` just adds credits directly with
no payment check — it's there so you can test the billing flow, but you
need to put a real payment processor (Stripe, etc.) in front of it and only
call it after a verified successful charge before this handles real money.

## 4. Things this reference implementation doesn't handle yet (your homework)


- **Auth** — `/session/start` is wide open right now. Put real auth in front of the broker API before exposing it publicly.
- **Persistent user data** — each session gets a fresh `emptyDir`. If you want "my apps stay installed between sessions," back the volume with NFS/Ceph keyed by user ID instead of session ID.
- **Capacity-aware scheduling** — `pick_node()` currently just counts pods per node. As you add GPU-sliced nodes, you'll want real headroom checks (CPU/mem/GPU) instead of a flat count.
- **Session limits per node** — nothing currently caps how many sessions land on one box; add a `maxSessions` label check before that becomes a problem.
- **TLS on Traefik** — the config ships with plain HTTP; wire up a certResolver once you're pointing a real domain at it directly (or keep relying on your Cloudflare Tunnel for TLS termination, like you do elsewhere).

---

## Repo layout

```
NoobsCloud/
├── terraform/     # Provisions one Docker-host VM per Proxmox node
├── ansible/        # Installs Docker, binder/ashmem modules, joins k3s
├── scripts/        # install-binder-modules.sh — the kernel module bit
├── k3s/            # Per-session Redroid Deployment+Service template
├── docker/          # Alternative: docker-compose template if you skip k3s
├── broker/         # FastAPI service: schedules sessions, wires routing, app launch, billing calls
├── accounts/        # Separate service: signup/login, JWTs, credit balances, session billing
├── traefik/        # Gateway config + where broker drops per-session routes
└── docs/           # Standalone Redroid setup guide + frontend launch-button snippet
```
