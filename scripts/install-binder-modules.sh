#!/usr/bin/env bash
# Run this INSIDE the Docker-host VM on each Proxmox worker node (NOT the Proxmox host itself).
# Installs the binder_linux + ashmem_linux kernel modules Redroid requires for Android IPC.
set -euo pipefail

echo "== Installing build deps =="
apt-get update
apt-get install -y git build-essential linux-headers-$(uname -r) dkms

echo "== Cloning anbox-modules (provides binder_linux / ashmem_linux DKMS) =="
cd /usr/src
if [ ! -d anbox-modules ]; then
  git clone https://github.com/choff/anbox-modules.git anbox-modules-src
  mv anbox-modules-src anbox-modules-1.0
fi

echo "== Registering with DKMS =="
dkms add -m anbox-modules -v 1.0 || true
dkms build -m anbox-modules -v 1.0
dkms install -m anbox-modules -v 1.0

echo "== Loading modules =="
modprobe binder_linux devices="binder,hwbinder,vndbinder"
modprobe ashmem_linux

echo "== Persisting across reboots =="
cat <<EOF > /etc/modules-load.d/redroid.conf
binder_linux
ashmem_linux
EOF

cat <<EOF > /etc/modprobe.d/redroid.conf
options binder_linux devices=binder,hwbinder,vndbinder
EOF

echo "== Verifying =="
ls -l /dev/binderfs 2>/dev/null || ls -l /dev/binder* 2>/dev/null || echo "WARNING: /dev/binder* not found — check dmesg for module load errors"

echo "Done. Reboot the VM once to confirm modules persist, then re-run the verify step."
