# xo-server-affinity-manager

> Tag-based VM affinity and anti-affinity management for XCP-ng / Xen Orchestra

Automated VM placement rules driven entirely by tags you apply in the XO UI — no external scripts, no cron jobs, no CLI required. Tag your VMs and hosts, and the plugin enforces placement on every cycle.

---

## Table of Contents

- [Features](#features)
- [Tag Syntax](#tag-syntax)
- [Host Tag Syntax](#host-tag-syntax)
- [Installation](#installation)
- [Configuration](#configuration)
- [Testing & Dry Run](#testing--dry-run)
- [Logging](#logging)
- [Real-World Examples](#real-world-examples)
- [Technical Details](#technical-details)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## Features

- **Host Affinity (`RunOn`)** — Pin VMs to a specific host group (e.g. a particular data center or pool segment)
- **Host Anti-Affinity (`NotOn`)** — Keep VMs off a specific host group (e.g. avoid backup or licensed nodes)
- **VM Co-location (`KeepTogether`)** — Keep a group of VMs on the same host to minimize latency (follows a Leader VM)
- **VM Separation (`KeepApart`)** — Spread a group of VMs across unique hosts for high availability (best effort)
- **Dry Run Mode** — Logs all intended migrations without moving anything (default: ON — recommended for initial setup)
- **Scheduled Enforcement** — Runs every 15 minutes, hourly, or daily at 2 AM (configurable in XO UI)
- **Pool Safety** — Cross-pool migration is always blocked automatically
- **Log Rotation** — Rolling 10 MB logs with 3 compressed `.gz` archives retained

---

## Tag Syntax

Apply these tags directly to your **VMs** in the Xen Orchestra UI:

| VM TAG / RULE | EXAMPLE | MEANING |
| :--- | :--- | :--- |
| `AM-RunOn_{HostGrpName}` | `AM-RunOn_P1-DC2-HOST` | VM should run on hosts tagged `P1-DC2-HOST` |
| `AM-NotOn_{HostGrpName}` | `AM-NotOn_P2-DC1-HOST` | VM should NOT run on hosts tagged `P2-DC1-HOST` |
| `AM-KeepTogether_{GrpName}` | `AM-KeepTogether_AppStack1` | Keep all group VMs on same host (follows Leader VM) |
| `AM-KeepApart_{GrpName}` | `AM-KeepApart_DBCluster1` | Spread group VMs across unique hosts (best effort) |

> **Note:** Multiple rules can be combined on a single VM. For example, a VM can have both
> `AM-RunOn_P1-DC1-HOST` and `AM-KeepTogether_WebCluster` simultaneously.

---

## Host Tag Syntax

Apply these tags directly to your **XCP-ng hosts** in the Xen Orchestra UI:

| EXAMPLE HOST TAG | POOL | LOCATION |
| :--- | :--- | :--- |
| `P1-DC1-HOST` | POOL-1 | Data Center 1 |
| `P1-DC2-HOST` | POOL-1 | Data Center 2 |
| `P2-DC1-HOST` | POOL-2 | Data Center 1 |
| `P2-DC2-HOST` | POOL-2 | Data Center 2 |

> ⚠️ **Important:** Host tags do **NOT** use the `AM-` prefix. The `AM-` prefix lives only
> on the VM tag side. The plugin strips `AM-RunOn_` (or `AM-NotOn_`) from the VM tag and
> matches the remainder **exactly** against host tags.
>
> ✅ Correct host tag: `P1-DC1-HOST`
> ❌ Wrong host tag:   `AM-P1-DC1-HOST`

---

## Installation

The plugin is available as a pre-built release bundle — no Babel or build tools required on the target system.

### Quick Install (Recommended)

**1. Download and extract the release bundle:**
```bash
sudo mkdir -p /usr/local/lib/node_modules/xo-server-affinity-manager
cd /usr/local/lib/node_modules/xo-server-affinity-manager
sudo wget https://github.com/john/xo-server-affinity-manager/releases/download/v0.3.6/xo-server-affinity-manager-v0.3.6.tar.gz
sudo tar -xzf xo-server-affinity-manager-v0.3.6.tar.gz --strip-components=1
```

**2. Install dependencies:**
```bash
sudo npm install --production
```

**3. Restart xo-server:**
```bash
sudo systemctl restart xo-server
```

**4. Enable in XO UI:**
Navigate to **Settings → Plugins**, find `xo-server-affinity-manager`, click **+** to configure, then toggle it **ON**.

> 💡 **Tip:** After enabling or updating the plugin, always do a hard refresh (`Ctrl+Shift+R`)
> in your browser — XO caches the plugin configuration schema aggressively.

---

### Build from Source

If you prefer to build from source:

**1. Clone the repository:**
```bash
git clone https://github.com/johnezero/xo-server-affinity-manager.git
cd xo-server-affinity-manager
```

**2. Install dependencies and build:**
```bash
npm install
npm run build
```

**3. Link or copy to XO node_modules:**
```bash
sudo cp -r . /usr/local/lib/node_modules/xo-server-affinity-manager/
```

**4. Create `.babelrc` (if not present):**
```json
{
  "presets": [
    ["@babel/preset-env", {
      "targets": { "node": "current" },
      "modules": "commonjs"
    }]
  ]
}
```

**5. Restart xo-server:**
```bash
sudo systemctl restart xo-server
```

---

## Configuration

Once installed and enabled, configure the plugin via **Settings → Plugins → xo-server-affinity-manager → (+)**:

| Setting | Default | Options | Description |
| :--- | :--- | :--- | :--- |
| **Enforcement Schedule** | `15min` | `15min` / `hourly` / `daily` | How often placement rules are evaluated. `daily` runs at 2 AM. |
| **Dry Run Mode** | `ON` | `ON` / `OFF` | When ON, logs all intended actions without moving any VMs. **Recommended: keep ON until rules are verified.** |
| **Log Path** | `/mnt/logs` | Any valid path | Absolute path to the log directory. Created automatically if it does not exist. |

> The VM Tag Rules and Host Tag Examples sections at the bottom of the plugin page are
> read-only reference fields — they do not affect plugin behavior.

---

## Testing & Dry Run

1. Ensure **Dry Run Mode** is **ON** (default)
2. Tag one or more test VMs with `AM-KeepTogether_TestGroup`
3. Click the **Test** button in the plugin settings panel
4. Check your log file — you should see a full cycle output showing intended actions
5. Verify the logic matches your expectations
6. When satisfied, flip **Dry Run Mode: OFF** to go live

---

## Logging

Logs are written to the configured **Log Path** directory as `affinity-manager.log`.

**Log rotation:**
- Rotates at **10 MB**
- Retains **3 compressed `.gz` archives**
- Older archives are automatically deleted

**Sample log output:**
```
[2026-09-01T01:35:59.656Z] --- Cycle Starting (MANUAL-TEST) | v0.3.6 | Dry-Run: false ---
[2026-09-01T01:35:59.679Z] [INFO] Found 726 real VMs and 12 hosts.
[2026-09-01T01:35:59.712Z] [INFO] KeepTogether_AppStack1: Leader=web-vm-01 (xenhost3). Moving api-vm-01 → xenhost3 [DRY-RUN]
[2026-09-01T01:35:59.730Z] [INFO] KeepApart_DBCluster1: db-vm-01 on xenhost1, db-vm-02 on xenhost2 — already satisfied.
[2026-09-01T01:35:59.745Z] --- Cycle Complete ---
```

**Tail the live log:**
```bash
tail -f /your/log/path/affinity-manager.log
```

---

## Real-World Examples

### Example 1 — Pin VMs to a specific data center

**Goal:** Ensure all web-tier VMs run only on POOL-1, DC2 hosts.

**VM Tags** (applied to each web-tier VM in XO):
```
AM-RunOn_P1-DC2-HOST
```

**Host Tags** (applied to each DC2 host in XO):
```
P1-DC2-HOST
```

**Result:** Any web-tier VM found running on a non-DC2 host will be migrated to a DC2 host on the next enforcement cycle.

---

### Example 2 — Database High Availability (KeepApart)

**Goal:** Ensure two database VMs never share the same physical host.

**VM Tags** (applied to both DB VMs):
```
AM-KeepApart_DBCluster1
```

**Result:** The plugin ensures `db-vm-01` and `db-vm-02` always run on different hosts. If a host failure causes HA to restart both on the same host, the plugin will separate them on the next cycle.

---

### Example 3 — App Stack Co-location (KeepTogether)

**Goal:** Keep a web server and its API backend on the same host to minimize inter-VM latency.

**VM Tags** (applied to both VMs):
```
AM-KeepTogether_AppStack1
```

**Result:** Both VMs are co-located on the same host. The first VM processed in the cycle becomes the "leader" — all others migrate to its host.

---

### Example 4 — Combined Rules

**Goal:** Keep two AD servers together, but only on POOL-1 DC1 hosts.

**VM Tags** (applied to both AD VMs):
```
AM-KeepTogether_ADServers
AM-RunOn_P1-DC1-HOST
```

**Host Tags** (applied to each DC1 host):
```
P1-DC1-HOST
```

**Result:** Both AD VMs will be co-located on the same DC1 host. If they drift (e.g. after a host failure + HA restart), the plugin reunites them automatically.

---

## Technical Details

| Detail | Implementation |
| :--- | :--- |
| **Resident Host Lookup** | Uses `vm.$container` (UUID-based) for 100% accurate host identification |
| **Host Matching** | Exact string match — `AM-RunOn_P1-DC1-HOST` strips prefix → looks for host tagged exactly `P1-DC1-HOST` |
| **Object Enumeration** | `Object.values(xo.getObjects())` with dual-type filter (`obj.type \|\| obj.$type`) |
| **Pool Safety** | `$poolId` checked before every migration — cross-pool moves are always blocked |
| **Scheduler** | `@xen-orchestra/cron` `createSchedule().createJob()` pattern — restarts cleanly on config change |
| **Halted VMs** | Skipped automatically — plugin only acts on running VMs with a confirmed resident host |
| **Leader Election** | For `KeepTogether`, the first VM processed in the cycle becomes the leader. Stabilizes quickly in practice. |
| **KeepApart Limits** | Warns in logs if there are not enough unique hosts — never forces an impossible migration |

---

## Troubleshooting

### Plugin shows 0 hosts in logs
**Symptom:** `Found 726 real VMs and 0 hosts`
**Cause:** Host type filter mismatch — XO may return `obj.type` or `obj.$type` depending on version.
**Fix:** Ensure the host filter uses: `obj.type === 'host' || obj.$type === 'host'` (fixed in v0.3.1+)

### VMs not migrating despite correct tags
**Check 1:** Confirm **Dry Run Mode** is OFF.
**Check 2:** Verify host tags do NOT have the `AM-` prefix (e.g. `P1-DC1-HOST` not `AM-P1-DC1-HOST`).
**Check 3:** Confirm the VM tag suffix exactly matches the host tag (case-sensitive).
**Check 4:** Check logs for `[WARN]` entries — halted VMs are skipped.

### Plugin config page shows old syntax after update
**Cause:** XO caches the plugin configuration schema aggressively.
**Fix:** Hard refresh (`Ctrl+Shift+R`) or open XO in a private/incognito window.
**Note:** Syntax/example text lives in `index.mjs` (not `package.json`) — update and rebuild if changing reference text.

### Scheduler stops after config change
**Symptom:** Plugin runs once then stops enforcing on schedule.
**Fix:** Ensure `configure()` explicitly stops the old job and starts a new one (fixed in v0.3.2+).

### `journalctl` shows no xo-server output
**Cause:** Insufficient journal read permissions.
**Fix:** Use `sudo journalctl -u xo-server | grep -i affinity | tail -20`

---

## Changelog

### v0.3.6 *(current)*
- Packaged as `.tar.gz` release bundle for direct installation (no build tools required)
- Stability improvements and log output refinements

### v0.3.4 / v0.3.5
- Trimmed plugin UI to two clean reference tables (VM Tag Rules + Host Tag Examples)
- Confirmed syntax/example text must live in `index.mjs`, not `package.json`
- Generic naming (`DC1`, `DC2`, `POOL-1`, `POOL-2`) used throughout all documentation

### v0.3.3
- **Documentation Fix:** Clarified that host tags do NOT use the `AM-` prefix
- **Generic Examples:** Updated all docs to use generic `DC1`/`POOL-1` naming conventions

### v0.3.2
- **Scheduler Fix:** `configure()` now explicitly stops the old job and starts a new one on every config change
- **Immediate Start:** Scheduler now starts immediately on plugin `load()`
- Adopted robust scheduler lifecycle pattern from `xo-server-tag-automation` v0.9.8

### v0.3.1
- **Host Filter Fix:** Dual-type filter (`obj.type === 'host' || obj.$type === 'host'`) resolves "0 hosts" bug
- **Host Match Fix:** Switched from `h.id` to `h.uuid` for `$container` comparison (resolves all VMs showing "no resident host")

### v0.3.0
- **"Smoking Gun" Fix:** Switched to `vm.$container` for resident host detection — resolves host-matching failures across all XO versions
- **Exact Matching:** Implemented exact string matching for host tags — removed legacy priority parsing
- **UI Integration:** Named `export const configurationSchema` ensures the "+" configuration button appears in XO
- **Simplified Tag Syntax:** `AM-RunOn_` and `AM-NotOn_` replace the older `AM-RunOnHosts_` / `AM-NotOnHosts_` prefixes

### v0.2.x
- **Plugin Migration:** Transitioned from standalone shell scripts to a native XO-Server plugin
- **Log Rotation:** Added automated log rotation for NFS-mounted log paths
- **Syntax Update:** Simplified prefixes to `AM-RunOn_` and `AM-NotOn_`
- **Pool Safety:** Added `$poolId` guard to prevent cross-pool migration attempts

### v0.1.9
- Initial working plugin version
- Supported `AM-RunOnHosts_`, `AM-NotOnHosts_`, `AM-KeepTogether_`, `AM-KeepApart_` tag syntax
- Host groups used `AM-P1-` / `AM-P2-` priority prefix system (later removed)

---

## License

ISC

---

## Disclaimer

> ⚠️ This plugin performs live VM migrations. It is **strongly recommended** to run in
> **Dry Run Mode** after any major tag changes to verify intended behavior before going live.
> Always test in a non-production environment first.

---

**Author:** John Olsen
**GitHub:** [https://github.com/johnezero/xo-server-affinity-manager](https://github.com/johnezero/xo-server-affinity-manager)
