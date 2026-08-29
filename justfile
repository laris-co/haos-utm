# haos-utm — Home Assistant OS as a native aarch64 VM on Apple Silicon, via UTM.
#
# Full chain: just up NAME  (fetch → verify → create → start → probe)
# Extracted from laris-co/kvm-oracle 704829f, made standalone. Origin of every
# gate and trap: kvm-oracle's create-haos-vm skill + the 2026-08-29 UTM session.
#
# WHY THESE SHAPES:
# - utmctl has NO create subcommand — creation goes through UTM's AppleScript
#   API (verified against its sdef: qemu configuration record, drive `source`
#   accepts an existing qcow2).
# - utmctl ip-address works WITHOUT a guest agent: UTM reads the vmnet DHCP
#   lease. Unlike virsh domifaddr over a bridge, which lies.
# - Serial console is a QEMU pty whose path changes per boot — always resolve
#   live via AppleScript, never hardcode /dev/ttysNNN.
# - HAOS answers :8123 during boot then 307s to :80 once settled; :4357 is the
#   supervisor observer and comes up long before HA core. 0ms refuse = RST.

set shell := ["bash", "-uc"]

utm_ctl  := "/Applications/UTM.app/Contents/MacOS/utmctl"
cache    := env_var_or_default("HAOS_UTM_CACHE", env_var("HOME") / "Library/Caches/haos-utm")
version  := env_var_or_default("HAOS_UTM_VERSION", "18.2")
img      := cache / "haos_generic-aarch64-" + version + ".qcow2"
# PINNED, not `qemu-img` from PATH: Android SDK ships qemu-img 2.12.0 (2018) at
# ~/Library/Android/sdk/emulator, AHEAD of Homebrew's 11.x. The two emit
# different JSON shapes (11.x nests a children[].info whose virtual-size is the
# FILE size). Parse top-level key only; never grep or `jq '..'` this output.
qemu_img := env_var_or_default("HAOS_UTM_QEMU_IMG", "/opt/homebrew/bin/qemu-img")

_default:
    @just --list --unsorted

# preflight: UTM installed, qemu-img sane, hypervisor support
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -x {{utm_ctl}} ] || { echo "REFUSE: UTM not at /Applications/UTM.app — install the official DMG (verify: codesign -dv → Turing Software, LLC)"; exit 1; }
    [ -x {{qemu_img}} ] || { echo "REFUSE: {{qemu_img}} missing — brew install qemu. Do NOT trust bare qemu-img: PATH may resolve to Android SDK's 2018 build"; exit 1; }
    [ "$(sysctl -n kern.hv_support)" = "1" ] || { echo "REFUSE: no Hypervisor.framework support"; exit 1; }
    command -v xz >/dev/null || { echo "REFUSE: xz missing"; exit 1; }
    echo "preflight ok: UTM $( defaults read /Applications/UTM.app/Contents/Info.plist CFBundleShortVersionString ), $({{qemu_img}} --version | head -1)"

# download aarch64 image + verify sha256 against GitHub's own upload-time digest,
# then gate on virtual-size == 32 GiB (arch-independent: Buildroot partitions
# HAOS identically on every arch — measured, not assumed)
fetch: preflight
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p {{quote(cache)}} && cd {{quote(cache)}}
    XZ="haos_generic-aarch64-{{version}}.qcow2.xz"
    if [ ! -f "${XZ%.xz}" ]; then
      DIGEST=$(curl -fsSL "https://api.github.com/repos/home-assistant/operating-system/releases/tags/{{version}}" \
        | python3 -c 'import json,sys;a=[x for x in json.load(sys.stdin)["assets"] if x["name"]=="'"$XZ"'"];d=(a[0].get("digest") or "") if a else "";print(d.removeprefix("sha256:")) if d.startswith("sha256:") else sys.exit("REFUSE: no upstream sha256 digest for '"$XZ"'")')
      [ -f "$XZ" ] || curl -fL -o "$XZ" "https://github.com/home-assistant/operating-system/releases/download/{{version}}/$XZ"
      echo "$DIGEST  $XZ" | shasum -a 256 -c -
      xz -dk "$XZ"
    fi
    {{qemu_img}} info --output=json "${XZ%.xz}" | python3 -c "
    import json,sys
    d=json.load(sys.stdin); vs=d['virtual-size']
    print('virtual-size', vs, '(%.0f GiB)' % (vs/2**30), 'fmt', d['format'])
    sys.exit(0 if vs==34359738368 else 'REFUSE: size != 32 GiB — not HAOS')"

# create the VM via AppleScript; refuses an existing name (R3 pattern)
create NAME="haos-utm" MEM="2048" CPUS="2": fetch
    #!/usr/bin/env bash
    set -euo pipefail
    if {{utm_ctl}} list | awk '{print $3}' | grep -qx {{quote(NAME)}}; then
      echo "REFUSE: VM '{{NAME}}' already exists ({{utm_ctl}} list)"; exit 1; fi
    osascript <<EOF
    tell application "UTM"
      set img to POSIX file "{{img}}"
      set vm to make new virtual machine with properties {backend:qemu, configuration:{name:"{{NAME}}", architecture:"aarch64", memory:{{MEM}}, cpu cores:{{CPUS}}, hypervisor:true, uefi:true, drives:{{{{removable:false, source:img, interface:virtio}}}}, network interfaces:{{{{mode:shared}}}}}}
      get id of vm
    end tell
    EOF

start NAME="haos-utm":
    {{utm_ctl}} start {{NAME}}

stop NAME="haos-utm":
    {{utm_ctl}} stop {{NAME}}

status NAME="haos-utm":
    {{utm_ctl}} status {{NAME}}

# vmnet DHCP lease — answers without a guest agent, once DHCP completes (~30-60s)
ip NAME="haos-utm":
    {{utm_ctl}} ip-address {{NAME}}

# :4357 = supervisor observer (up first) · :8123 during boot, 307s to :80 settled
probe NAME="haos-utm":
    #!/usr/bin/env bash
    set -euo pipefail
    IP=$({{utm_ctl}} ip-address {{quote(NAME)}} | head -1)
    [ -n "$IP" ] || { echo "no IP yet — booting or DHCP pending"; exit 1; }
    echo "guest $IP"
    for p in 80 8123 4357; do
      c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "http://$IP:$p/" || true)
      echo "  :$p -> ${c:-000}"
    done

# full chain: nothing → running VM with an IP
up NAME="haos-utm" MEM="2048" CPUS="2":
    just create {{NAME}} {{MEM}} {{CPUS}}
    just start {{NAME}}
    @echo "booting — ~30-60s to DHCP, ~90s to supervisor. next:"
    @echo "  just ip {{NAME}} && just probe {{NAME}}"
    @echo "  just onboard USER PASS {{NAME}}"

# create the owner account headless — no browser. same 5-step onboarding API
# gates as kvm-oracle's libvirt/KVM guests (scripts/onboard.ts, copied from
# create-haos-vm; refuses cleanly if onboarding is already done)
onboard USER PASS NAME="haos-utm":
    #!/usr/bin/env bash
    set -euo pipefail
    IP=$({{utm_ctl}} ip-address {{quote(NAME)}} | head -1)
    [ -n "$IP" ] || { echo "no IP yet"; exit 1; }
    bun {{justfile_directory()}}/scripts/onboard.ts --ip "$IP" --user {{quote(USER)}} --pass {{quote(PASS)}}

# interactive serial console — root, NO password, `ha` CLI inside.
# ⚠️ run in a SEPARATE terminal, never inside a tmux pane an agent lives in
# (scroll keys leak into the serial line as ^[[6~ garbage).
# detach: ctrl-a d · kill: ctrl-a k y · stuck: screen -ls; screen -X -S <id> quit
console NAME="haos-utm":
    #!/usr/bin/env bash
    set -euo pipefail
    PTTY=$(osascript -e 'tell application "UTM" to get address of first serial port of virtual machine named "{{NAME}}"')
    [ -n "$PTTY" ] || { echo "no serial port on {{NAME}}"; exit 1; }
    echo "attaching $PTTY — login: root (no password), then \`ha\`. detach: ctrl-a d"
    exec screen "$PTTY"

# one-shot command over serial, scriptable — login+run+capture, no interactive tty
serial-run CMD NAME="haos-utm":
    #!/usr/bin/env bash
    set -euo pipefail
    PTTY=$(osascript -e 'tell application "UTM" to get address of first serial port of virtual machine named "{{NAME}}"')
    python3 - "$PTTY" {{quote(CMD)}} <<'PYEOF'
    import os, sys, time, tty
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_NONBLOCK)
    tty.setraw(fd)
    def send(s, wait):
        os.write(fd, s.encode()); time.sleep(wait)
        out = b''
        try:
            while True:
                c = os.read(fd, 4096)
                if not c: break
                out += c
        except BlockingIOError: pass
        return out.decode(errors='replace')
    send('\n', 1)
    send('root\n', 2)          # no-op if already logged in
    print(send(sys.argv[2] + '\n', 5))
    os.close(fd)
    PYEOF

# irreversible; utmctl delete has NO confirmation of its own, so gate here
delete NAME="haos-utm" CONFIRM="":
    #!/usr/bin/env bash
    set -euo pipefail
    [ {{quote(CONFIRM)}} = "--confirm" ] || { echo "plan only. re-run: just delete {{NAME}} --confirm"; exit 0; }
    {{utm_ctl}} stop {{quote(NAME)}} 2>/dev/null || true
    {{utm_ctl}} delete {{quote(NAME)}}
    echo "deleted {{NAME}} (image cache kept at {{cache}})"
