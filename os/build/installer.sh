#!/bin/sh
# NOVA OS installer.
#
# Writes the assembled image to a block device, or produces a compressed image
# and checksums that can be shipped for someone else to install. It refuses to
# touch a device it cannot name, and it confirms before overwriting anything.
#
#   sh os/build/installer.sh --image os/build/out/nova-os.img --device /dev/sdX
#   sh os/build/installer.sh --image os/build/out/nova-os.img --package
#
# The --device path needs a Linux host and root. The --package path only reads
# the image and writes a .img.xz plus a manifest, so it runs anywhere.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IMAGE="$ROOT/os/build/out/nova-os.img"
DEVICE=""
PACKAGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --package) PACKAGE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$IMAGE" ] || { echo "No image at $IMAGE; run os/build/build-image.sh first." >&2; exit 1; }

if [ "$PACKAGE" = "1" ]; then
  OUT="$IMAGE.xz"
  echo "==> compressing $IMAGE to $OUT"
  if command -v xz >/dev/null 2>&1; then
    xz -T0 -9 -c "$IMAGE" > "$OUT"
  else
    echo "xz is not installed; writing a plain copy instead." >&2
    cp "$IMAGE" "$OUT"
  fi
  sha256sum "$IMAGE" > "$IMAGE.sha256"
  {
    echo "NAME=NOVA OS"
    echo "IMAGE=$(basename "$IMAGE")"
    echo "PACKAGE=$(basename "$OUT")"
    echo "BYTES=$(wc -c < "$IMAGE" | tr -d ' ')"
    echo "SHA256=$(cut -d' ' -f1 < "$IMAGE.sha256")"
    echo "BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$IMAGE.manifest"
  echo "wrote $OUT and $IMAGE.manifest"
  exit 0
fi

[ -n "$DEVICE" ] || { echo "Name a target with --device /dev/..., or use --package." >&2; exit 2; }
[ -b "$DEVICE" ] || { echo "$DEVICE is not a block device." >&2; exit 1; }

echo "This will overwrite everything on $DEVICE with the NOVA OS image."
printf 'Type the device path again to confirm: '
read -r CONFIRM
[ "$CONFIRM" = "$DEVICE" ] || { echo "Not confirmed; nothing was written." >&2; exit 1; }

echo "==> writing $IMAGE to $DEVICE"
if command -v dd >/dev/null 2>&1; then
  dd if="$IMAGE" of="$DEVICE" bs=4M conv=fsync status=progress
else
  cat "$IMAGE" > "$DEVICE"
  sync
fi

echo "==> done. Remove the installer medium and boot from $DEVICE."
echo "The OS's own requirement audit runs on first boot (os/diag/audit.ts)."
