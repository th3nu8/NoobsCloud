# VMStream

Credit-based streaming service: users sign up, get a per-minute-billed Android
instance cloned fresh from a Proxmox template, and stream it in-browser via
your existing ws-scrcpy setup. The account named `th3nu8` automatically gets
owner access on registration — no one else can self-promote to owner.

## What's included

- Username/password auth (bcrypt + JWT in an httpOnly cookie)
- Credit ledger (signup bonus, per-minute deduction while streaming, owner adjustments)
- `/api/stream/start` clones your template VM in Proxmox, boots it, connects
  ADB, and hands the browser a ws-scrcpy stream link
- `/api/stream/stop` bills the final minute and destroys the cloned VM
- Owner dashboard (`/owner.html`) — user list, credit adjustments, live
  instance table. Only reachable by the `th3nu8` account.
- SQLite storage (`vmstream.db`, created automatically) — no external DB needed

## Setup

```bash
cd vmstream
npm install
cp .env.example .env
# edit .env with real values - see below
npm start
```

Runs on port 4000 by default. Put it behind your Cloudflare Tunnel the same
way you did for ws-scrcpy (`localhost:4000`), ideally on its own subdomain
(e.g. `app.yourdomain.com`), separate from the raw ws-scrcpy hostname — end
users should only ever see this app, not the ws-scrcpy device list directly.

## Required Proxmox setup

1. **API token**: Datacenter > Permissions > API Tokens, create one for a user
   with permission to clone/start/stop/delete VMs on your node. Put the
   token ID and secret in `.env`.
2. **Template VM**: your existing Android VM, set as the clone source. Put its
   VMID in `PROXMOX_TEMPLATE_VMID`. I used `full: 0` (linked clone) in
   `proxmox.js` for speed — switch to `full: 1` if your storage backend
   doesn't support linked clones.
3. **VMID range**: pick a block of VMIDs (e.g. 9000-9999) that nothing else on
   your node uses — the app claims one per active session and destroys it on
   stop.

## Networking (static MAC + DHCP reservation — fastest, no polling delay)

Every cloned VM gets a **deterministic MAC address** derived from its VMID
(`proxmox.macForVmid()`, set via `pinMac()` right after cloning). That means
VMID 9000 is *always* `BC:24:11:00:23:28`, VMID 9001 is always the next one,
and so on — the same VM slot always has the same MAC, every single time it's
cloned.

You need to do one manual setup step: **add a DHCP reservation on your router
for each VMID in your clone range**, mapping that deterministic MAC to a
predictable IP. With the `.env.example` defaults (range 9000-9020, subnet
`192.168.4.`, offset 150):

| VMID | MAC | Reserved IP |
|---|---|---|
| 9000 | BC:24:11:00:23:28 | 192.168.4.150 |
| 9001 | BC:24:11:00:23:29 | 192.168.4.151 |
| ... | ... | ... |
| 9020 | BC:24:11:00:23:3C | 192.168.4.170 |

Run this on Node to print the full table for your range so you can copy it
straight into your router's DHCP reservation list:

```bash
node -e "
const { macForVmid } = require('./proxmox');
const start=9000, end=9020, subnet='192.168.4.', offset=150;
for (let v=start; v<=end; v++) console.log(v, macForVmid(v), subnet+(v-start+offset));
"
```

Once those reservations exist, this is fast: no waiting on a guest agent
(which most Android-x86 images don't have anyway) — the app knows the IP the
instant it clones the VM, and just waits for port 5555 to respond before
handing off to ADB, which is normal boot time (a few seconds to ~1 minute
depending on your VM's disk speed).

If your Android template doesn't have "ADB over network" enabled to start
automatically at boot, that's the other thing to check — otherwise port 5555
never comes up and the session will time out with an error telling you the
expected MAC/IP pairing to double check.

## Game lock

Each account permanently picks one game the first time they visit the
dashboard (`POST /api/games/lock`) — after that, every session they start
auto-launches that same app via `adb shell am start`, and the frontend never
shows them a picker again. Only the owner can clear a user's choice
(`owner.html` -> Reset), letting them pick again.

Edit `games.js` with the real package name + launch activity for every game
installed on your Android template. Find these values by running, against
the template while it's booted (before cloning):

```bash
adb shell cmd package resolve-activity --brief <package.name>
```

**Scope note**: this launches the chosen app as the foreground activity, but
it's an app-level launch, not an OS-level kiosk lock — a user could still
press Home/Recents on the stream and get to the Android launcher or other
installed apps if your image doesn't restrict that. True kiosk-mode pinning
needs the Android image provisioned as a **Device Owner** (via QR/NFC
enrollment at first boot) with `setLockTaskPackages()` restricting it to only
the locked game. That's a one-time change to your template image, not this
app — let me know if you want help setting that up on the Android side.



- The credit shop / payment processing — right now credits only come from the
  signup bonus and owner manual adjustments (`owner.html`)
- Email verification, password reset
- Rate limiting on auth endpoints
