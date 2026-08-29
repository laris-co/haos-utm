# Agent Prompt: Create one HAOS VM and prove it works

Copy everything below the line into any LLM agent that can run shell commands on
an Apple Silicon Mac (Claude Code, Codex, aider, ...). It will build one Home
Assistant OS VM from this repo and hand back verifiable proof, not claims.

---

## Task

Create exactly **one** Home Assistant OS virtual machine on this Mac using the
`justfile` in https://github.com/laris-co/haos-utm — then prove it is alive with
captured command output. Do not retype commands from docs; run the recipes.

## Hard rules

1. **Run recipes, not hand-typed commands.** Every gate lives in the justfile
   and exits non-zero on a refuse condition. A gate you retype is not a gate.
2. **Never use the x86 OVA image.** Only `haos_generic-aarch64` (the recipes
   already enforce this — do not "fix" them).
3. **Never call bare `qemu-img`.** PATH may resolve to Android SDK's 2018 build
   with a different JSON shape. The justfile pins `/opt/homebrew/bin/qemu-img`.
4. **One VM only.** If `create` refuses because the name exists, STOP and report
   — do not delete anything to make room. `delete` is gated behind `--confirm`
   for a reason; you do not have permission to use it.
5. If any step fails, capture the exact error line and stop. Do not improvise
   alternative creation paths (no manual UTM GUI steps, no raw qemu invocation).

## Steps

```bash
# 0. clone
git clone https://github.com/laris-co/haos-utm && cd haos-utm

# 1. gates: UTM present, pinned qemu-img present, Hypervisor.framework
just preflight

# 2-4. fetch (sha256 vs GitHub's upload-time digest + 32 GiB identity gate),
#      create (AppleScript — utmctl cannot create), start
just up

# 5. wait for DHCP (~30-60s), then address + port truth
just ip
just probe

# 6. owner account, headless — pick your own password
just onboard admin 'CHANGE_ME_STRONG_PASSWORD'

# 7. one command over serial, scripted (no interactive tty needed)
just serial-run "ha os info"
```

Timing expectations: DHCP lease ~30-60 s after start; supervisor healthy ~90 s.
If `probe` shows nothing on all three ports at 2 minutes, wait 60 s and retry
once before declaring failure.

## Proof — required evidence, in this order

Paste the **actual output** of each. Screenshots not required; text is proof.

| # | Evidence | What it must show |
|---|---|---|
| 1 | `just preflight` output | `preflight ok: UTM <version>, qemu-img version 11.x` |
| 2 | sha256 line from `just up` | `haos_generic-aarch64-18.2.qcow2.xz: OK` |
| 3 | identity gate line | `virtual-size 34359738368 (32 GiB) fmt qcow2` |
| 4 | `utmctl list` row | VM name with state `started` |
| 5 | `just ip` | one `192.168.64.x` address |
| 6 | `just probe` | `:80` or `:8123` answering, `:4357` -> `200` |
| 7 | `just onboard` tail | onboarding steps passing, ending with a login URL |
| 8 | `just serial-run "ha os info"` | YAML with `board: generic-aarch64` and `version: "18.2"` |
| 9 | `curl -s -o /dev/null -w '%{http_code}' http://<IP>:4357/` | `200` |

Evidence 8 is the strongest single item: it proves the guest OS itself is
running and the serial channel works — it cannot be faked by a stale cache or a
half-booted VM.

## Report format

End with exactly this summary block, values filled in:

```
HAOS-UTM PROOF
vm_name:    <name>
state:      <utmctl status output>
ip:         <address>
supervisor: <:4357 http code>
web:        http://<address>/  (login: admin / password you set)
os:         <board + version from ha os info>
image:      haos_generic-aarch64-18.2, sha256 verified against GitHub digest
evidence:   9/9 captured above
```

Anything you could not capture, list as `MISSING: <#> — <why>`. Never report
`9/9` unless all nine are pasted verbatim.

## Known traps (already paid for — do not rediscover)

- Black UTM display ≠ hung: HAOS console goes to serial, not VGA. Check `:4357`.
- A 0 ms connection refusal is a RST (nothing listening), not "still booting".
- `:8123` answers during boot then 307-redirects to `:80` once settled.
- Only ONE reader per serial pty — never run `console` and `serial-run`
  simultaneously.
- If you open `just console` interactively, do it in a separate terminal, never
  inside the pane your agent runs in (scroll keys leak into serial as `^[[6~`).
