/**
 * Plugin:      xo-server-affinity-manager
 * Version:     0.1.1
 * Description: Tag-based affinity and anti-affinity management for XCP-ng/XO
 * Author:      John Olsen
 * License:     ISC
 *
 * Supported AM Rule Tags:
 *   AM-RunOnHosts=xen##,xen##     (ShouldRunOn   -- soft host affinity)
 *   AM-NotOnHosts=xen##,xen##     (ShouldNotRunOn -- soft host anti-affinity)
 *   AM-KeepTogether={GroupName}   (Co-locate group VMs on leader's host)
 *   AM-KeepAppart={GroupName}     (Spread group VMs across unique hosts)
 *
 * Scope / Pool Boundary:
 *   ⚠️  This plugin operates STRICTLY within a single pool.
 *   - VMs will only be migrated to hosts within their CURRENT pool.
 *   - Cross-pool migration is NOT supported and will never be attempted.
 *   - If a tag references a host name that does not exist in the VM's
 *     current pool, the action is logged as a SKIP and the VM is left
 *     in place. Nothing is blocked or crashed.
 *   - VM.pool_migrate (the underlying XAPI call) enforces this at the
 *     XAPI level as well -- refs from other pools are not resolvable.
 *
 * Notes:
 *   - All rules are SOFT -- if a target host is unavailable, the action
 *     is logged as a warning and the VM is left in place. Nothing is blocked.
 *   - Dry Run mode logs all intended actions without performing any migrations.
 *   - Log rotation compresses to .gz when log exceeds 10MB (max 3 rotated files).
 */

const PLUGIN_VERSION = '0.1.1';

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import _ from 'lodash';
import { createSchedule } from '@xen-orchestra/cron';

const appendFile = promisify(fs.appendFile);
const stat = promisify(fs.stat);

// --- Configuration Schema for XO UI ---
const configurationSchema = {
  type: 'object',
  properties: {
    schedule: {
      type: 'string',
      enum: ['15min', 'hourly', 'daily'],
      default: '15min',
      title: 'Enforcement Schedule'
    },
    dryRun: {
      type: 'boolean',
      default: true,
      title: 'Dry Run Mode',
      description: 'Log actions without moving VMs'
    },
    nfsLogPath: {
      type: 'string',
      default: '/mnt/v0/code/affinity-manager/logs',
      title: 'NFS Log Path'
    }
  }
};

class AffinityManagerPlugin {
  constructor(xo) {
    this._xo = xo;
    this._running = false;
    this._job = null;
  }

  async configure(config) {
    this._config = config;
    if (this._running) {
      this._setupScheduler();
    }
  }

  async test() {
    await this._enforcePolicies('MANUAL-TEST');
  }

  activate() {
    this._running = true;
    this._setupScheduler();
  }

  deactivate() {
    this._running = false;
    if (this._job) {
      this._job.stop();
    }
  }

  // --- Logging & v0.9.8 Rotation Logic ---
  async _log(message) {
    const { nfsLogPath } = this._config;
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    const logFile = path.join(nfsLogPath, 'xo-affinity-manager.log');

    try {
      if (!fs.existsSync(nfsLogPath)) {
        fs.mkdirSync(nfsLogPath, { recursive: true });
      }
      await appendFile(logFile, logEntry);
      await this._rotateLogs(logFile);
    } catch (err) {
      console.error('Affinity Manager Logging Error:', err);
    }
  }

  async _rotateLogs(logFile) {
    try {
      const stats = await stat(logFile);
      if (stats.size > 10 * 1024 * 1024) { // 10MB Limit
        const LOG_MAX_FILES = 3;

        // Shift existing rotated logs: 2->3, 1->2 (loop from top down to avoid overwrite)
        for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
          const oldFile = `${logFile}.${i}.gz`;
          const newFile = `${logFile}.${i + 1}.gz`;
          if (fs.existsSync(oldFile)) {
            fs.renameSync(oldFile, newFile);
          }
        }

        // Compress current log to .1.gz
        const gzip = zlib.createGzip();
        const source = fs.createReadStream(logFile);
        const destination = fs.createWriteStream(`${logFile}.1.gz`);
        source.pipe(gzip).pipe(destination);

        destination.on('finish', () => {
          fs.truncateSync(logFile, 0);
          fs.appendFileSync(
            logFile,
            `[${new Date().toISOString()}] Log rotated. Previous log compressed to .1.gz\n`
          );
        });
      }
    } catch (e) {
      // Fail silently to prevent plugin crash
    }
  }

  // --- Core Enforcement Logic ---
  async _enforcePolicies(trigger = 'SCHEDULED') {
    const { dryRun } = this._config;
    await this._log(`--- xo-affinity-manager v${PLUGIN_VERSION} | Enforcement Cycle Starting (${trigger}) | Dry-Run: ${dryRun} ---`);

    const allObjects = this._xo.getObjects();
    const vms = _.filter(allObjects, vm => this._isRealVm(vm));
    const hosts = _.filter(allObjects, { type: 'host' });

    const togetherMap = {}; // groupName -> hostName (leader host)
    const apartMap = {};    // groupName -> [hostNames already claimed]

    for (const vm of vms) {
      const rules = this._parseTags(vm.tags || []);
      if (!rules.hasRules) continue;

      const xapi = this._xo.getXapi(vm);
      const currentHost = _.find(hosts, { _xapiRef: vm.resident_on });
      if (!currentHost) continue;

      // Only consider hosts in the SAME pool as the VM (pool boundary enforcement)
      const poolHosts = hosts.filter(h => h.$poolId === vm.$poolId);

      // 1. Host Affinity (RunOnHosts / NotOnHosts)
      await this._handleHostAffinity(vm, rules, currentHost, poolHosts, xapi);

      // 2. KeepTogether (Leader Strategy)
      if (rules.keepTogether) {
        await this._handleKeepTogether(vm, rules.keepTogether, togetherMap, currentHost, poolHosts, xapi);
      }

      // 3. KeepAppart (Separation Strategy)
      if (rules.keepAppart) {
        await this._handleKeepAppart(vm, rules.keepAppart, apartMap, currentHost, poolHosts, xapi);
      }
    }

    await this._log(`--- Enforcement Cycle Complete ---`);
  }

  // --- VM Filter (excludes templates, control domains, backup snapshots) ---
  _isRealVm(vm) {
    if (!vm.uuid || vm.$type !== 'VM' || vm.is_a_template || vm.is_control_domain) return false;
    const name = vm.name_label || '';
    if (
      name.startsWith('[XO Backup') ||
      name.startsWith('[ESXI]') ||
      name.includes('import from V2V')
    ) return false;
    return true;
  }

  // --- Tag Parser ---
  // Supported tags:
  //   AM-RunOnHosts=xen01,xen02   (ShouldRunOn -- soft affinity)
  //   AM-NotOnHosts=xen03,xen04   (ShouldNotRunOn -- soft anti-affinity)
  //   AM-KeepTogether={GroupName} (Co-locate group on leader's host)
  //   AM-KeepAppart={GroupName}   (Spread group across unique hosts)
  _parseTags(tags) {
    const rules = {
      runOn: [],
      notOn: [],
      keepTogether: null,
      keepAppart: null,
      hasRules: false
    };

    tags.forEach(tag => {
      if (tag.startsWith('AM-RunOnHosts=')) {
        rules.runOn = tag.split('=')[1].split(',').map(s => s.trim());
        rules.hasRules = true;
      } else if (tag.startsWith('AM-NotOnHosts=')) {
        rules.notOn = tag.split('=')[1].split(',').map(s => s.trim());
        rules.hasRules = true;
      } else if (tag.startsWith('AM-KeepTogether=')) {
        rules.keepTogether = tag.split('=')[1].trim();
        rules.hasRules = true;
      } else if (tag.startsWith('AM-KeepAppart=')) {
        rules.keepAppart = tag.split('=')[1].trim();
        rules.hasRules = true;
      }
    });

    return rules;
  }

  // --- Rule Handlers ---

  async _handleHostAffinity(vm, rules, currentHost, poolHosts, xapi) {
    const { dryRun } = this._config;
    const isForbidden = rules.notOn.includes(currentHost.name_label);
    const isNotPreferred = rules.runOn.length > 0 && !rules.runOn.includes(currentHost.name_label);

    if (isForbidden || isNotPreferred) {
      let targetHostName = null;

      if (rules.runOn.length > 0) {
        // Pick first preferred host that is not the current host (must be in same pool)
        const preferred = rules.runOn.find(h =>
          h !== currentHost.name_label &&
          poolHosts.some(ph => ph.name_label === h)
        );
        targetHostName = preferred || null;
      } else {
        // Pick any pool host not in the forbidden list
        const validHost = poolHosts.find(h => !rules.notOn.includes(h.name_label));
        targetHostName = validHost ? validHost.name_label : null;
      }

      if (targetHostName) {
        await this._migrateVM(vm, targetHostName, xapi, dryRun, 'Host Affinity Rule');
      } else {
        await this._log(`[WARN] Host Affinity: No valid target host found in pool for "${vm.name_label}"`);
      }
    }
  }

  async _handleKeepTogether(vm, groupName, togetherMap, currentHost, poolHosts, xapi) {
    const { dryRun } = this._config;

    if (!togetherMap[groupName]) {
      // First VM seen in this group becomes the leader
      togetherMap[groupName] = currentHost.name_label;
      await this._log(
        `[INFO] KeepTogether [${groupName}]: Leader set to "${vm.name_label}" on host ${currentHost.name_label}`
      );
    } else {
      const leaderHostName = togetherMap[groupName];
      if (currentHost.name_label !== leaderHostName) {
        await this._migrateVM(vm, leaderHostName, xapi, dryRun, `KeepTogether Group [${groupName}]`);
      }
    }
  }

  async _handleKeepAppart(vm, groupName, apartMap, currentHost, poolHosts, xapi) {
    const { dryRun } = this._config;

    if (!apartMap[groupName]) {
      // First VM in this group -- claim its host
      apartMap[groupName] = [currentHost.name_label];
    } else {
      if (apartMap[groupName].includes(currentHost.name_label)) {
        // Host already claimed by this group -- find a free pool host
        const emptyHost = poolHosts.find(h => !apartMap[groupName].includes(h.name_label));
        if (emptyHost) {
          const success = await this._migrateVM(
            vm, emptyHost.name_label, xapi, dryRun, `KeepAppart Group [${groupName}]`
          );
          if (success || dryRun) {
            apartMap[groupName].push(emptyHost.name_label);
          }
        } else {
          await this._log(
            `[WARN] KeepAppart [${groupName}]: No unique hosts available in pool for "${vm.name_label}"`
          );
        }
      } else {
        // Host is free for this group -- claim it
        apartMap[groupName].push(currentHost.name_label);
      }
    }
  }

  // --- Migration (positional XAPI args -- v0.9.8 standard) ---
  async _migrateVM(vm, targetHostName, xapi, dryRun, reason) {
    if (dryRun) {
      await this._log(`[DRY-RUN] ${reason}: VM "${vm.name_label}" should move to ${targetHostName}`);
      return true;
    }

    try {
      const allObjects = this._xo.getObjects();

      // Find target host -- must be in the same pool as the VM
      const targetHost = _.find(allObjects, {
        type: 'host',
        name_label: targetHostName
      });

      if (!targetHost) {
        throw new Error(`Target host "${targetHostName}" not found or offline`);
      }

      // ⚠️ Pool boundary check -- cross-pool migration is not supported.
      // VM.pool_migrate enforces this at the XAPI level too, but we check
      // here first to produce a clean, informative log entry.
      if (targetHost.$poolId !== vm.$poolId) {
        await this._log(
          `[SKIP] ${reason}: Target host "${targetHostName}" is in a different pool. ` +
          `Cross-pool migration is not supported. VM "${vm.name_label}" left in place.`
        );
        return false;
      }

      // Positional arguments required -- named object causes MISMATCH error (v0.9.8 lesson)
      await xapi.call('VM.pool_migrate', vm._xapiRef, targetHost._xapiRef, {});
      await this._log(`[SUCCESS] ${reason}: Migrated "${vm.name_label}" to ${targetHostName}`);
      return true;
    } catch (e) {
      await this._log(
        `[ERROR] ${reason}: Failed to move "${vm.name_label}" to ${targetHostName}. Error: ${e.message}`
      );
      return false;
    }
  }

  // --- Scheduler ---
  _setupScheduler() {
    if (this._job) this._job.stop();

    const cronMap = {
      '15min': '*/15 * * * *',
      'hourly': '0 * * * *',
      'daily':  '0 2 * * *'
    };

    const cronExpr = cronMap[this._config.schedule] || cronMap['15min'];
    this._job = createSchedule(cronExpr).createJob(() => this._enforcePolicies());
    this._job.start();
    this._log(`[INFO] Scheduler started: ${this._config.schedule} (${cronExpr})`);
  }
}

export default (xo) => new AffinityManagerPlugin(xo);
export { configurationSchema };
