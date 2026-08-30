// Thin wrapper around the Proxmox VE REST API.
// Docs: https://pve.proxmox.com/pve-docs/api-viewer/
const fetch = require('node-fetch');
const https = require('https');

const {
  PROXMOX_HOST,
  PROXMOX_PORT = 8006,
  PROXMOX_NODE,
  PROXMOX_TOKEN_ID,
  PROXMOX_TOKEN_SECRET,
  PROXMOX_VERIFY_TLS = 'false',
} = process.env;

const agent = new https.Agent({ rejectUnauthorized: PROXMOX_VERIFY_TLS === 'true' });

const base = `https://${PROXMOX_HOST}:${PROXMOX_PORT}/api2/json`;

async function pve(pathSuffix, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathSuffix}`, {
    method,
    agent,
    headers: {
      Authorization: `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Proxmox API ${method} ${pathSuffix} -> ${res.status}: ${text}`);
  }
  return json.data;
}

// Clone the template VM into a fresh instance. Uses a linked clone for speed;
// switch full:1 to full:0/1 depending on whether your template disk supports it.
async function cloneVM(templateVmid, newVmid, name) {
  return pve(`/nodes/${PROXMOX_NODE}/qemu/${templateVmid}/clone`, {
    method: 'POST',
    body: { newid: newVmid, name, full: 0 },
  });
}

// Deterministic MAC derived from the VMID, so the same VMID always gets the
// same MAC -> your router's DHCP reservation always hands it the same IP.
// Uses the QEMU/KVM-reserved locally-administered prefix (BC:24:11) so it
// never collides with real hardware NICs.
function macForVmid(vmid) {
  const hex = vmid.toString(16).padStart(6, '0');
  return `BC:24:11:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`.toUpperCase();
}

// Overwrites the clone's first network device with our deterministic MAC.
// Call this right after cloneVM() and before startVM().
async function pinMac(vmid, bridge = 'vmbr0') {
  const mac = macForVmid(vmid);
  await pve(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/config`, {
    method: 'POST',
    body: { net0: `virtio=${mac},bridge=${bridge}` },
  });
  return mac;
}

async function startVM(vmid) {
  return pve(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/start`, { method: 'POST' });
}

async function stopVM(vmid) {
  return pve(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/stop`, { method: 'POST' });
}

async function destroyVM(vmid) {
  return pve(`/nodes/${PROXMOX_NODE}/qemu/${vmid}`, { method: 'DELETE' });
}

// Best-effort IP discovery via the QEMU guest agent. Most Android-x86 images
// do NOT ship this agent, so this will likely fail unless you've installed
// one. See README "Networking" for the static-map fallback.
async function getVMIPviaAgent(vmid) {
  const data = await pve(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/agent/network-get-interfaces`);
  for (const iface of data.result || []) {
    for (const addr of iface['ip-addresses'] || []) {
      if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
        return addr['ip-address'];
      }
    }
  }
  return null;
}

module.exports = { cloneVM, startVM, stopVM, destroyVM, getVMIPviaAgent, macForVmid, pinMac };
