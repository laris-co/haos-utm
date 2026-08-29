# haos-utm

Run **Home Assistant OS** as a **native aarch64 VM** on Apple Silicon, via
[UTM](https://github.com/utmapp/UTM) — no emulation, boot to a healthy Supervisor
in ~90 seconds. Everything is a `just` recipe; nothing to retype.

```
just up            # fetch → digest-verify → create → start
just ip            # guest IP (no guest agent needed — vmnet DHCP lease)
just probe         # port truth: 80 / 8123 / 4357
just onboard admin 'YOUR_PASSWORD'   # owner account, no browser
just console       # serial terminal (root, no password, `ha` CLI)
```

## Requirements

- Apple Silicon Mac (`sysctl kern.hv_support` → 1)
- [UTM](https://mac.getutm.app/) ≥ 4.x — verify the DMG: `codesign -dv` →
  `Turing Software, LLC`
- `brew install qemu just` (needs qemu-img ≥ 11 at `/opt/homebrew/bin/qemu-img`)
- [bun](https://bun.sh) for the onboarding script

## Why it works the way it does

- **`utmctl` cannot create VMs** — creation goes through UTM's AppleScript API
  (`qemu configuration` record; drive `source` accepts an existing qcow2).
- **aarch64 image, never the OVA** — the OVA is x86-64 and gets TCG-emulated on
  Apple Silicon. `haos_generic-aarch64` runs native under Hypervisor.framework.
- **Image is verified before use** — sha256 against GitHub's own upload-time
  release digest, then a hard gate on virtual-size == 32 GiB (HAOS's Buildroot
  layout is identical on every arch — measured, not assumed).
- **Serial console is a QEMU pty** whose path changes each boot; recipes resolve
  it live. Console login is `root` with no password (console = physical access);
  the Home Assistant web user exists only in HA's own database.
- **Port truth**: `:4357` (supervisor observer) is up long before HA core;
  `:8123` answers during boot then redirects to `:80` once settled. A 0 ms
  connection refusal is a RST — nothing listening — not "still booting".

## Traps this repo already paid for

| trap | avoidance |
|---|---|
| PATH `qemu-img` is Android SDK's 2018 build (emits different JSON than 11.x) | pinned binary + top-level-key-only parsing |
| x86 OVA on Apple Silicon | aarch64 image, gated |
| Black UTM display looks hung | normal — console goes to serial, check `:4357` |
| `screen` inside a tmux/agent pane | scroll keys leak into serial as `^[[6~` — separate terminal |
| Can't exit `screen` (`ctrl-c` goes to guest) | `ctrl-a d` / `ctrl-a k y` / `screen -X -S <id> quit` |
| `utmctl delete` has no confirmation | recipe refuses without `--confirm` |

## Skill

`.claude/skills/create-haos-utm/` makes this driveable by Claude Code — the
skill documents gates and decisions; the justfile holds every executable step.

## License / status

Personal lab tooling, shared as-is. HAOS version pinned via `HAOS_UTM_VERSION`
(default 18.2); image cache in `~/Library/Caches/haos-utm`.
