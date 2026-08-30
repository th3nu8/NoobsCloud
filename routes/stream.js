const express = require('express');
const { exec } = require('child_process');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const proxmox = require('../proxmox');
const games = require('../games');

const router = express.Router();

// Tracks setInterval handles for active billing loops, keyed by instance id.
const billingTimers = new Map();

function nextVmid() {
  const start = Number(process.env.PROXMOX_CLONE_VMID_START || 9000);
  const end = Number(process.env.PROXMOX_CLONE_VMID_END || 9999);
  const used = db.prepare(
    "SELECT vmid FROM instances WHERE status IN ('starting','running')"
  ).all().map(r => r.vmid);
  for (let id = start; id <= end; id++) {
    if (!used.includes(id)) return id;
  }
  throw new Error('No free VMIDs left in the configured clone range');
}

// Deterministic: VMID N is always assigned the same MAC (see proxmox.pinMac),
// and STATIC_MAP_SUBNET + offset gives its IP. Your router needs a DHCP
// reservation for that MAC -> that IP for every VMID in the clone range -
// see README "Networking".
function staticIPForVmid(vmid) {
  const offset = Number(process.env.STATIC_MAP_OFFSET || 0);
  return `${process.env.STATIC_MAP_SUBNET}${vmid - Number(process.env.PROXMOX_CLONE_VMID_START) + offset}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wait for the VM to actually respond on the network before handing it to
// adb - the IP is known instantly (static map), but the guest still needs a
// few seconds to boot and bring its NIC up.
async function waitForBoot(ip, { attempts = 15, delayMs = 2000 } = {}) {
  const net = require('net');
  for (let i = 0; i < attempts; i++) {
    const up = await new Promise(resolve => {
      const sock = net.createConnection({ host: ip, port: 5555, timeout: 1500 });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (up) return true;
    await sleep(delayMs);
  }
  return false;
}

function adbConnect(ip) {
  return new Promise((resolve, reject) => {
    exec(`${process.env.ADB_BIN || 'adb'} connect ${ip}:5555`, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

// Launches the user's locked game as the foreground app. This is an
// app-level launch, not an OS-level kiosk lock - see README "Game lock"
// for what that would additionally require.
function launchGame(ip, game) {
  return new Promise((resolve, reject) => {
    const cmd = `${process.env.ADB_BIN || 'adb'} -s ${ip}:5555 shell am start -n ${game.package}/${game.activity}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

router.post('/start', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const costPerMin = Number(process.env.CREDIT_COST_PER_MINUTE || 1);
  if (user.credits < costPerMin) {
    return res.status(402).json({ error: 'Not enough credits' });
  }
  if (!user.locked_game_id) {
    return res.status(400).json({ error: 'Lock in a game first (POST /api/games/lock)' });
  }
  const game = games.find(g => g.id === user.locked_game_id);
  if (!game) {
    return res.status(500).json({ error: 'Your locked game is no longer in the catalog - contact the owner' });
  }

  let vmid;
  try {
    vmid = nextVmid();
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }

  const info = db.prepare(
    'INSERT INTO instances (user_id, vmid, game_id, status) VALUES (?, ?, ?, ?)'
  ).run(user.id, vmid, game.id, 'starting');
  const instanceId = info.lastInsertRowid;

  try {
    await proxmox.cloneVM(process.env.PROXMOX_TEMPLATE_VMID, vmid, `vmstream-${user.username}-${vmid}`);
    await proxmox.pinMac(vmid); // deterministic MAC so the static IP map holds
    await proxmox.startVM(vmid);

    const ip = staticIPForVmid(vmid);
    const booted = await waitForBoot(ip);
    if (!booted) {
      db.prepare("UPDATE instances SET status = 'error' WHERE id = ?").run(instanceId);
      return res.status(504).json({
        error: `VM started but ${ip} never came up on port 5555. Check that your DHCP reservation for MAC ${proxmox.macForVmid(vmid)} -> ${ip} is set, and that the template has ADB-over-network enabled at boot.`,
      });
    }
    await adbConnect(ip);
    await launchGame(ip, game);

    db.prepare("UPDATE instances SET status = 'running', ip = ? WHERE id = ?").run(ip, instanceId);
    startBilling(instanceId, user.id, costPerMin);

    const streamUrl = `${process.env.WSSCRCPY_BASE_URL}/#!action=stream&udid=${encodeURIComponent(ip + ':5555')}`;
    res.json({ ok: true, instanceId, streamUrl, game: { id: game.id, name: game.name } });
  } catch (e) {
    db.prepare("UPDATE instances SET status = 'error' WHERE id = ?").run(instanceId);
    res.status(500).json({ error: String(e) });
  }
});

router.post('/stop', requireAuth, async (req, res) => {
  const { instanceId } = req.body;
  const instance = db.prepare('SELECT * FROM instances WHERE id = ? AND user_id = ?').get(instanceId, req.user.id);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  stopBilling(instanceId);
  db.prepare("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE id = ?").run(instanceId);

  try {
    await proxmox.stopVM(instance.vmid);
    await proxmox.destroyVM(instance.vmid);
  } catch (e) {
    // Non-fatal for the user-facing response, but worth logging server-side.
    console.error('Proxmox teardown failed for vmid', instance.vmid, e);
  }
  res.json({ ok: true });
});

router.get('/mine', requireAuth, (req, res) => {
  const instances = db.prepare(
    "SELECT * FROM instances WHERE user_id = ? ORDER BY started_at DESC LIMIT 20"
  ).all(req.user.id);
  res.json({ instances });
});

function startBilling(instanceId, userId, costPerMin) {
  const timer = setInterval(() => {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!user || user.credits < costPerMin) {
      stopBilling(instanceId);
      const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId);
      if (instance && instance.status === 'running') {
        db.prepare("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE id = ?").run(instanceId);
        proxmox.stopVM(instance.vmid).then(() => proxmox.destroyVM(instance.vmid)).catch(() => {});
      }
      return;
    }
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(costPerMin, userId);
    db.prepare('INSERT INTO ledger (user_id, delta, reason) VALUES (?, ?, ?)')
      .run(userId, -costPerMin, `streaming (instance ${instanceId})`);
    db.prepare('UPDATE instances SET minutes_billed = minutes_billed + 1 WHERE id = ?').run(instanceId);
  }, 60 * 1000);
  billingTimers.set(instanceId, timer);
}

function stopBilling(instanceId) {
  const timer = billingTimers.get(instanceId);
  if (timer) {
    clearInterval(timer);
    billingTimers.delete(instanceId);
  }
}

module.exports = router;
