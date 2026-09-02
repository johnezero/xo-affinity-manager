/**
 * Plugin:      xo-server-affinity-manager
 * Version:     0.3.6
 * Description: Tag-based affinity and anti-affinity management for XCP-ng/XO
 * Author:      John Olsen
 * License:     ISC
 */

const PLUGIN_VERSION = '0.3.6';

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { createSchedule } from '@xen-orchestra/cron';

const appendFile = promisify(fs.appendFile);
const stat       = promisify(fs.stat);

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

const FILE_LOG      = 'xo-affinity-manager.log';
const LOG_MAX_SIZE  = 10 * 1024 * 1024; // 10 MB
const LOG_MAX_FILES = 3;

const DEFAULTS = {
  schedule:   '15min',
  dryRun:     true,
  nfsLogPath: '/mnt/v0/code/affinity-manager/logs',
};

// ============================================================
// NAMED EXPORT -- Required for XO UI "+" button
// ============================================================

export const configurationSchema = {
  type: 'object',
  properties: {
    schedule: {
      type: 'string',
      enum: ['15min', 'hourly', 'daily'],
      default: '15min',
      title: 'Enforcement Schedule',
      description: 'How often affinity rules are evaluated. 15min | hourly | daily (2 AM).',
    },
    dryRun: {
      type: 'boolean',
      default: true,
      title: 'Dry Run Mode',
      description: 'When ON (default), logs all intended actions without moving any VMs. Turn OFF to enforce rules live.',
    },
    nfsLogPath: {
      type: 'string',
      default: '/mnt/v0/code/affinity-manager/logs',
      title: 'Log Path',
      description: 'Absolute path to the log directory. Created automatically if it does not exist.',
    },
    TagRule1: {
      type: 'string',
      title: 'VM TAG: AM-RunOn_{HostGrp}.................. ',
      default: '-- For reference only --',
      description: 'EXAMPLE: AM-RunOn_P1-DC2-HOST | MEANS: VM should run on P1-DC2-HOST tagged hosts',
    },
    TagRule2: {
      type: 'string',
      title: 'VM TAG: AM-NotOn_{HostGrp}.................. ',
      default: '-- For reference only --',
      description: 'EXAMPLE: AM-NotOn_P2-DC1-HOST | MEANS: VM should not run on P2-DC1-HOST tagged hosts',
    },
    TagRule3: {
      type: 'string',
      title: 'VM TAG: AM-KeepTogether_{GrpName} ',
      default: '-- For reference only --',
      description: 'EXAMPLE: AM-KeepTogether_GrpOne | MEANS: Keep GrpOne VMs on same host (follows Leader VM)',
    },
    TagRule4: {
      type: 'string',
      title: 'VM TAG: AM-KeepApart_{GrpName}........ ',
      default: '-- For reference only --',
      description: 'EXAMPLE: AM-KeepApart_GrpTwo | MEANS: Spread GrpTwo VMs across unique hosts (best effort)',
    },
    TagRule5: {
      type: 'string',
      title: 'HOST TAG: P#-{LOC}-HOST.......................... ',
      default: '-- For reference only --',
      description: 'EXAMPLE: P1-DC2-HOST | MEANS: POOL-1 - Data Center 2 - HOST',
    },
  },
};

// ============================================================
// LOGGING & ROTATION
// ============================================================

async function rotateLogs(config) {
  const logFile = path.join(config.nfsLogPath, FILE_LOG);
  if (!fs.existsSync(logFile)) return;
  try {
    const { size } = await stat(logFile);
    if (size < LOG_MAX_SIZE) return;

    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const src = `${logFile}.${i}.gz`;
      const dst = `${logFile}.${i + 1}.gz`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    const gzip = zlib.createGzip();
    const src  = fs.createReadStream(logFile);
    const dst  = fs.createWriteStream(`${logFile}.1.gz`);
    src.pipe(gzip).pipe(dst);
    dst.on('finish', () => {
      fs.truncateSync(logFile, 0);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Log rotated.\n`);
    });
  } catch (err) {
    console.error('[xo-affinity-manager] Rotation error:', err);
  }
}

async function writeLog(config, message) {
  const logFile = path.join(config.nfsLogPath, FILE_LOG);
  const entry   = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (!fs.existsSync(config.nfsLogPath)) {
      fs.mkdirSync(config.nfsLogPath, { recursive: true });
    }
    await appendFile(logFile, entry);
    await rotateLogs(config);
  } catch (err) {
    console.error('[xo-affinity-manager] Log write error:', err);
  }
}

// ============================================================
// HELPERS
// ============================================================

function getCron(schedule) {
  if (schedule === 'hourly') return '0 * * * *';
  if (schedule === 'daily')  return '0 2 * * *';
  return '*/15 * * * *'; // default: 15min
}

function isRealVm(obj) {
  if (!obj || !obj.uuid)                             return false;
  if (obj.$type !== undefined && obj.$type !== 'VM') return false;
  if (obj.is_a_template)                             return false;
  if (obj.is_control_domain)                         return false;
  const name = (obj.name_label || '').trim();
  if (!name)                                         return false;
  if (name.startsWith('[XO Backup'))                 return false;
  if (name.startsWith('[ESXI]'))                     return false;
  if (name.includes('import from V2V'))              return false;
  return true;
}

function parseVmTags(tags) {
  const rules = {
    runOnTags:          [],
    notOnTags:          [],
    keepTogetherGroups: [],
    keepApartGroups:    [],
    hasRules: false,
  };

  for (const tag of tags) {
    if (tag.startsWith('AM-RunOn_')) {
      rules.runOnTags.push(tag.slice('AM-RunOn_'.length));
      rules.hasRules = true;
    } else if (tag.startsWith('AM-NotOn_')) {
      rules.notOnTags.push(tag.slice('AM-NotOn_'.length));
      rules.hasRules = true;
    } else if (tag.startsWith('AM-KeepTogether_')) {
      rules.keepTogetherGroups.push(tag.slice('AM-KeepTogether_'.length));
      rules.hasRules = true;
    } else if (tag.startsWith('AM-KeepApart_')) {
      rules.keepApartGroups.push(tag.slice('AM-KeepApart_'.length));
      rules.hasRules = true;
    }
  }
  return rules;
}

// ============================================================
// MIGRATION
// ============================================================

async function migrateVm(vm, targetHost, xapi, dryRun, reason, config) {
  if (dryRun) {
    await writeLog(config, `[DRY-RUN] ${reason}: "${vm.name_label}" should move to "${targetHost.name_label}"`);
    return true;
  }
  try {
    if (targetHost.$poolId !== vm.$poolId) {
      await writeLog(config, `[SKIP] ${reason}: "${targetHost.name_label}" is in a different pool. Blocked.`);
      return false;
    }
    // Positional args fix
    await xapi.call('VM.pool_migrate', vm._xapiRef, targetHost._xapiRef, {});
    await writeLog(config, `[SUCCESS] ${reason}: Migrated "${vm.name_label}" to "${targetHost.name_label}"`);
    return true;
  } catch (err) {
    await writeLog(config, `[ERROR] ${reason}: Failed to move "${vm.name_label}". ${err.message}`);
    return false;
  }
}

// ============================================================
// ENFORCEMENT CYCLE
// ============================================================

async function runEnforcementCycle(xo, config, trigger = 'SCHEDULED') {
  const { dryRun } = config;
  await writeLog(config, `--- Cycle Starting (${trigger}) | v${PLUGIN_VERSION} | Dry-Run: ${dryRun} ---`);

  const allObjects = Object.values(xo.getObjects());
  const vms = allObjects.filter(obj => isRealVm(obj));
  const hosts = allObjects.filter(obj => obj.type === 'host' || obj.$type === 'host');

  await writeLog(config, `[INFO] Found ${vms.length} real VMs and ${hosts.length} hosts.`);

  const togetherMap = {};
  const apartMap    = {};

  for (const vm of vms) {
    const rules = parseVmTags(vm.tags || []);
    if (!rules.hasRules) continue;

    let xapi;
    try {
      xapi = xo.getXapi(vm);
    } catch (err) {
      await writeLog(config, `[WARN] Could not get XAPI for "${vm.name_label}": ${err.message}`);
      continue;
    }

    const currentHost = hosts.find(h => h.uuid === vm.$container);
    if (!currentHost) {
      await writeLog(config, `[WARN] "${vm.name_label}" has no resident host ($container="${vm.$container}") — may be halted. Skipping.`);
      continue;
    }

    const poolHosts = hosts.filter(h => h.$poolId === vm.$poolId);

    for (const groupName of rules.keepTogetherGroups) {
      if (!togetherMap[groupName]) {
        togetherMap[groupName] = currentHost;
        await writeLog(config, `[INFO] KeepTogether [${groupName}]: Leader = "${vm.name_label}" on "${currentHost.name_label}"`);
      } else if (currentHost.uuid !== togetherMap[groupName].uuid) {
        await migrateVm(vm, togetherMap[groupName], xapi, dryRun, `KeepTogether [${groupName}]`, config);
      }
    }

    for (const groupName of rules.keepApartGroups) {
      if (!apartMap[groupName]) {
        apartMap[groupName] = [currentHost.uuid];
      } else if (apartMap[groupName].includes(currentHost.uuid)) {
        const freeHost = poolHosts.find(h => !apartMap[groupName].includes(h.uuid));
        if (freeHost) {
          const ok = await migrateVm(vm, freeHost, xapi, dryRun, `KeepApart [${groupName}]`, config);
          if (ok || dryRun) apartMap[groupName].push(freeHost.uuid);
        } else {
          await writeLog(config, `[WARN] KeepApart [${groupName}]: No unique host available for "${vm.name_label}"`);
        }
      } else {
        apartMap[groupName].push(currentHost.uuid);
      }
    }

    for (const hostTag of rules.runOnTags) {
      const groupHosts = poolHosts.filter(h => (h.tags || []).includes(hostTag));
      if (groupHosts.length === 0) {
        await writeLog(config, `[WARN] RunOn [${hostTag}]: No hosts in this pool tagged "${hostTag}"`);
        continue;
      }
      const alreadyOnGroup = groupHosts.some(h => h.uuid === currentHost.uuid);
      if (!alreadyOnGroup) {
        await migrateVm(vm, groupHosts[0], xapi, dryRun, `RunOn [${hostTag}]`, config);
      }
    }

    for (const hostTag of rules.notOnTags) {
      const forbiddenHosts = poolHosts.filter(h => (h.tags || []).includes(hostTag));
      const onForbidden    = forbiddenHosts.some(h => h.uuid === currentHost.uuid);
      if (onForbidden) {
        const safeHost = poolHosts.find(h => !forbiddenHosts.some(fh => fh.uuid === h.uuid));
        if (safeHost) {
          await migrateVm(vm, safeHost, xapi, dryRun, `NotOn [${hostTag}]`, config);
        } else {
          await writeLog(config, `[WARN] NotOn [${hostTag}]: No safe host available for "${vm.name_label}"`);
        }
      }
    }
  }

  await writeLog(config, `--- Cycle Complete ---`);
}

// ============================================================
// PLUGIN EXPORT
// ============================================================

export default function affinityManagerPlugin({ xo }) {
  let _config  = { ...DEFAULTS };
  let _job     = null;

  function stopScheduler() {
    if (_job) {
      try { _job.stop(); } catch (_) {}
      _job = null;
    }
  }

  function setupScheduler() {
    stopScheduler();
    const cron = getCron(_config.schedule);
    _job = createSchedule(cron).createJob(async () => {
      try {
        await runEnforcementCycle(xo, _config);
      } catch (err) {
        await writeLog(_config, `[ERROR] Scheduled run failed: ${err.message}`);
      }
    });
    _job.start();
    writeLog(_config, `[INFO] Scheduler started: ${_config.schedule} (${cron})`);
  }

  return {
    async load() {
      await writeLog(_config, `Plugin loaded v${PLUGIN_VERSION}`);
      setupScheduler(); // Start immediately on load
    },

    async unload() {
      stopScheduler();
      await writeLog(_config, 'Plugin unloaded');
    },

    configure(rawConfig) {
      _config = { ...DEFAULTS, ...rawConfig };
      setupScheduler(); // Restart immediately on config change
      writeLog(_config, `[INFO] configure() called -- schedule="${_config.schedule}"`);
    },

    activate() {
      setupScheduler();
    },

    deactivate() {
      stopScheduler();
    },

    testSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['Run Now'],
          default: 'Run Now',
        },
      },
    },

    async test() {
      await runEnforcementCycle(xo, _config, 'MANUAL-TEST');
      return 'Enforcement cycle complete — check NFS logs for details.';
    },
  };
}
