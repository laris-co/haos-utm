---
name: create-haos-utm
description: Spin up Home Assistant OS as a native aarch64 VM on Apple Silicon via UTM — digest-verified image, AppleScript creation (utmctl cannot create), headless onboarding, scripted serial console. Use when the user says "create haos vm on mac", "haos on utm", "local home assistant vm", "spin up haos sandbox", or wants a throwaway HAOS to test add-ons without touching a production instance. Do NOT trigger for HAOS on libvirt/KVM hosts (that is create-haos-vm in kvm-oracle) or Proxmox (vpskeeper-oracle) — and do NOT use the x86 OVA image on Apple Silicon, it gets TCG-emulated into uselessness.
---

# /create-haos-utm

HAOS guest in UTM on Apple Silicon. **All executable steps live in the `justfile`
at this repo's root — run recipes, do not retype commands from this document.**

```
just preflight          # UTM present, qemu-img sane, hv_support
just up [NAME]          # fetch → verify → create → start   (full chain)
just ip && just probe   # address + port truth
just onboard USER PASS  # owner account, no browser
just console            # serial terminal (SEPARATE terminal window!)
just delete NAME --confirm
```

## Why the commands are not in this document

Same rule as kvm-oracle's create-haos-vm, learned 2026-08-24 when a prose warning
did not stop a command and a running guest's disk was renamed: **a gate you retype
is not a gate.** The justfile's recipes exit non-zero on every refuse condition.

## The gates (enforced in the justfile, not here)

| gate | condition | recipe |
|---|---|---|
| preflight | UTM missing / qemu-img missing / no hv_support | `preflight` |
| digest | downloaded .xz fails GitHub's own upload-time sha256 | `fetch` |
| identity | virtual-size ≠ 34359738368 (32 GiB) → not HAOS | `fetch` |
| name | VM name already exists in `utmctl list` | `create` |
| delete | refuses without `--confirm` (utmctl has no confirmation) | `delete` |

The 32 GiB constant is arch-independent — measured on both the x86 OVA and the
aarch64 image: Buildroot partitions HAOS identically everywhere.

## Decisions

| | value | why |
|---|---|---|
| image | `haos_generic-aarch64` | native via Hypervisor.framework. The OVA is x86 — TCG-emulated on Apple Silicon, 5-20× slower |
| backend | UTM **QEMU** (+ HVF), not Apple Virtualization | QEMU backend boots arbitrary qcow2 with UEFI; edk2 bundled, no Secure Boot (HAOS refuses SB) |
| creation | AppleScript API | `utmctl` has NO `create` subcommand — verified against its sdef. The `qemu configuration` record + drive `source` accept an existing qcow2 |
| network | Shared (vmnet NAT) | `utmctl ip-address` reads the vmnet DHCP lease — works with NO guest agent (HAOS ships none). Bridged risks `homeassistant.local` mDNS collisions with other HAOS instances on the LAN |
| qemu-img | pinned `/opt/homebrew/bin/qemu-img` | PATH may resolve to Android SDK's 2.12.0 (2018). The two versions emit DIFFERENT JSON shapes — 11.x nests a second `virtual-size` that is the file's own size. Parse the top-level key only |
| memory | 2048 MiB | measured fine for a bare guest; supervisor Healthy at ~350 MB real use |

## Port truth — do not assume :8123

`:4357` (supervisor observer) answers long before HA core. `:8123` answers during
boot, then 307s to `:80` once settled (HAOS 18.x behavior; older versions stay on
:8123). A 0 ms refuse is a TCP RST — nothing listening — while a booting service
times out. `just probe` checks all three.

## Serial console

Mechanism: `guest ttyAMA0 → QEMU -serial pty → /dev/ttysNNN → screen`.
The pty path changes every VM start — `just console` resolves it live via
AppleScript. Login `root`, **no password** (console = physical access). The HA
web user does not exist at the OS layer.

⚠️ Run `just console` in its own terminal window. Inside a tmux pane where an
agent runs, scroll keys leak into the serial line as `^[[6~` garbage. Only ONE
reader per pty — `console` and `serial-run` fight if used simultaneously.
Detach `ctrl-a d` · kill `ctrl-a k y` · stuck: `screen -ls; screen -X -S <id> quit`.

## Onboarding — not browser-only

`scripts/onboard.ts` drives the 5-step onboarding REST API (first call needs no
auth — no user exists yet to authenticate as). Refuses cleanly if already done;
resumes a half-finished onboarding via login_flow instead of failing. Prefer
`--pass-file` over `--pass` for anything non-throwaway.

## Limits — say them plainly

- **aarch64**: add-ons published amd64-only will not install. Sizes/timings
  measured here do not transfer to x86 production instances (~2.7× cross-arch
  measurement error documented in the wild).
- This is a **sandbox**, not a stand-in for a production HAOS on x86 hardware.
- `bake-hostname` is not ported: macOS has no qemu-nbd path. Shared network makes
  the default `homeassistant` hostname collision-safe enough; first boot on
  Bridged is where it bites.

## Provenance

Extracted from `laris-co/kvm-oracle` (create-haos-vm skill + 2026-08-29 UTM
session). Gates R1/R2/R8, port truth, copy-not-overlay reasoning, and the
onboarding script all originate there; libvirt-specific mechanisms (virsh, ovs,
qemu-nbd, ARP addressing) were deliberately NOT ported — their root causes
generalize, their commands do not.
