# Setting up a single Redroid instance (test before you touch the cluster)

Do this once, on one Docker-host VM, before wiring the broker/k3s pieces in.
It confirms binder/ashmem + Docker + adb + web-scrcpy actually work together
on your hardware before you scale it across nodes.

## 1. Install Docker
```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Load the kernel modules Redroid needs
Redroid needs `binder_linux` and `ashmem_linux` on the host kernel (this VM's
kernel, not the Proxmox hypervisor's). Run:
```bash
sudo ./scripts/install-binder-modules.sh
```
Verify:
```bash
ls -l /dev/binderfs
```
If that's empty, check `dmesg | tail -50` for module load errors before going
further — nothing downstream will work without this.

## 3. Run one Redroid container
```bash
docker run -d \
  --name redroid-test \
  --privileged \
  -p 5555:5555 \
  -v redroid-data:/data \
  --device /dev/binderfs:/dev/binderfs \
  redroid/redroid:13.0.0-latest \
  androidboot.redroid_gpu_mode=guest
```
`androidboot.redroid_gpu_mode=guest` = software rendering (llvmpipe). Fine
for this smoke test. Switch to `host` once GPU passthrough is set up (see
README section 4).

## 4. Connect over adb to confirm it booted
```bash
adb connect localhost:5555
adb -s localhost:5555 shell getprop ro.build.version.release
```
Should print an Android version. If `adb connect` refuses, give the
container another 30–60s — first boot is slow.

## 5. Point web-scrcpy at it
In your existing web-scrcpy instance's device list, add:
```
localhost:5555
```
(or the Docker-host VM's IP:5555 if web-scrcpy runs elsewhere). You should
see the Android screen render in-browser and be able to click/drag on it.

## 6. Install an APK
```bash
adb -s localhost:5555 install /path/to/app.apk
```
Or push a Play Store login flow through and install from there — either
works, Redroid runs stock (unrooted) Android by default.

## 7. Clean up the test container
```bash
docker rm -f redroid-test
docker volume rm redroid-data
```

Once this all works on one node, move to the full cluster deployment in the
main [README](../README.md) — same image, same modules, just orchestrated
by k3s instead of a single `docker run`.
