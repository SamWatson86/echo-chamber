import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function listFiles(relativeDir, predicate = () => true) {
  const dir = path.join(root, relativeDir);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) return listFiles(relativePath, predicate);
      return predicate(relativePath) ? [relativePath] : [];
    });
}

function checkWorkflowGuardrails() {
  const forbiddenFiles = [
    '.github/workflows/release.yml',
    '.github/workflows/build-macos.yml',
  ];

  for (const file of forbiddenFiles) {
    assert(!exists(file), `${file} must not exist; releases are local Windows-only operations.`);
  }

  const workflowFiles = listFiles('.github/workflows', (file) => /\.ya?ml$/i.test(file));
  const forbiddenPatterns = [
    {
      pattern: /cargo\s+tauri\s+build/i,
      reason: 'GitHub workflows must not build Tauri installers.',
    },
    {
      pattern: /macos-latest/i,
      reason: 'GitHub workflows must not run macOS jobs.',
    },
    {
      pattern: /build-macos/i,
      reason: 'GitHub workflows must not keep macOS build jobs.',
    },
    {
      pattern: /bundle\/dmg|bundle\\dmg|--bundles\s+(?:app,)?dmg/i,
      reason: 'GitHub workflows must not build or upload DMG artifacts.',
    },
    {
      pattern: /softprops\/action-gh-release/i,
      reason: 'GitHub workflows must not publish release assets for normal releases.',
    },
  ];

  for (const file of workflowFiles) {
    const content = read(file);
    for (const { pattern, reason } of forbiddenPatterns) {
      assert(!pattern.test(content), `${file}: ${reason}`);
    }
  }
}

function checkRootPackageGuardrails() {
  assert(!exists('package-lock.json'), 'package-lock.json must not return for the retired root npm workspace.');

  const packageJson = JSON.parse(read('package.json'));
  const workspaces = packageJson.workspaces ?? [];
  assert(
    !workspaces.some((workspace) => /^apps[\\/]/.test(workspace)),
    'package.json must not point at retired apps/* workspaces.',
  );
}

function checkCargoWorkspaceGuardrails() {
  const cargoToml = read('core/Cargo.toml');
  const membersMatch = cargoToml.match(/members\s*=\s*\[([\s\S]*?)\]/);
  assert(Boolean(membersMatch), 'core/Cargo.toml must declare workspace members.');

  const membersBlock = membersMatch?.[1] ?? '';
  assert(!/"hook"/.test(membersBlock), 'core/hook must not be an active Cargo workspace member.');

  assert(
    /exclude\s*=\s*\[[\s\S]*"hook"[\s\S]*"client\/src\/archive\/hook"[\s\S]*\]/.test(cargoToml),
    'core/Cargo.toml must explicitly exclude hook crates from the active workspace.',
  );

  const lockfile = read('core/Cargo.lock');
  assert(!/name = "echo-game-hook"/.test(lockfile), 'core/Cargo.lock must not contain echo-game-hook.');
  assert(!/name = "minhook"/.test(lockfile), 'core/Cargo.lock must not contain minhook from the archived hook.');
}

function checkArchiveGuardrails() {
  const requiredFiles = [
    'core/client/src/archive/AGENTS.md',
    'core/client/src/archive/README.md',
    'core/hook/AGENTS.md',
    'core/hook/README.md',
  ];

  for (const file of requiredFiles) {
    assert(exists(file), `${file} must exist to mark legacy capture code as archived.`);
  }

  assert(
    /reference-only/i.test(read('core/client/src/archive/AGENTS.md')),
    'core/client/src/archive/AGENTS.md must clearly mark the archive as reference-only.',
  );
  assert(
    /not an active build target/i.test(read('core/hook/AGENTS.md')),
    'core/hook/AGENTS.md must clearly state core/hook is not an active build target.',
  );

  const capturePipeline = read('core/docs/CAPTURE_PIPELINE.md');
  assert(
    /start_screen_share_monitor[\s\S]*not the production picker path/i.test(capturePipeline),
    'core/docs/CAPTURE_PIPELINE.md must warn that WGC monitor capture is not production picker path.',
  );
  assert(
    /DXGI Desktop Duplication/i.test(capturePipeline),
    'core/docs/CAPTURE_PIPELINE.md must document DXGI Desktop Duplication as the monitor/fallback path.',
  );
}

function checkCodexOperatingModelGuardrails() {
  assert(exists('docs/CODEX.md'), 'docs/CODEX.md must document the canonical Codex operating model.');

  const codexDoc = read('docs/CODEX.md');
  assert(
    /Echo Chamber - Main/.test(codexDoc),
    'docs/CODEX.md must name Echo Chamber - Main as the canonical Codex project.',
  );
  assert(
    /Do not create additional Codex projects/i.test(codexDoc),
    'docs/CODEX.md must warn against creating additional Echo Codex projects.',
  );

  const agents = read('AGENTS.md');
  assert(
    /Echo Chamber - Main/.test(agents),
    'AGENTS.md must point future agents at the canonical Echo Chamber - Main project.',
  );
}

function checkProductionNetworkGuardrails() {
  const operations = read('docs/OPERATIONS.md');
  const networkGuard = read('core/deploy/production-network-lib.ps1');
  const deployWatcher = read('core/deploy/deploy-watcher.ps1');
  const agents = read('AGENTS.md');
  const serviceGuardPath = 'core/deploy/echo-core-host-network-guard.ps1';
  const serviceGuardTestPath = 'core/deploy/test-echo-core-host-network-guard.ps1';
  const windowsNetworkGatePath = 'core/deploy/test-production-network.ps1';
  assert(exists(serviceGuardPath), `${serviceGuardPath} must guard the canonical production service.`);
  assert(exists(serviceGuardTestPath), `${serviceGuardTestPath} must cover the canonical production service guard.`);
  assert(exists(windowsNetworkGatePath), `${windowsNetworkGatePath} must execute the Windows production network tests.`);
  const serviceGuard = exists(serviceGuardPath) ? read(serviceGuardPath) : '';
  const serviceGuardTest = exists(serviceGuardTestPath) ? read(serviceGuardTestPath) : '';
  const windowsNetworkGate = exists(windowsNetworkGatePath) ? read(windowsNetworkGatePath) : '';
  const packageJson = JSON.parse(read('package.json'));

  assert(
    /Production network reachability invariant[\s\S]*`CORE_BIND=0\.0\.0\.0`[\s\S]*`CORE_PORT=9443`/i.test(operations),
    'docs/OPERATIONS.md must preserve the production CORE_BIND=0.0.0.0 and CORE_PORT=9443 invariant.',
  );
  assert(
    /candidate loopback bind must never be copied into the production environment/i.test(operations),
    'docs/OPERATIONS.md must forbid promoting a candidate loopback bind to production.',
  );
  assert(
    /`hosts` file overrides public DNS resolution[\s\S]*public-hostname `curl`[\s\S]*local-only service check/i.test(operations),
    'docs/OPERATIONS.md must warn that a server hosts override makes public-hostname curl local-only.',
  );
  assert(
    /Loopback \(server\):[\s\S]*LAN \(another device\):[\s\S]*External \(off-LAN\):/i.test(operations),
    'docs/OPERATIONS.md must require independent loopback, LAN, and external production verification.',
  );
  assert(
    /echo-core-host-network-guard\.ps1[\s\S]*-Action Preflight[\s\S]*-Action Start[\s\S]*-Action Restart/i.test(operations),
    'docs/OPERATIONS.md must require the canonical guard before and after manual service mutations.',
  );
  assert(
    /function Assert-ProductionControlEnvironment[\s\S]*function Assert-ProductionControlIngress/i.test(networkGuard),
    'The committed production network guard must expose environment and ingress assertions.',
  );
  assert(
    /production-network-lib\.ps1[\s\S]*Assert-WatcherProductionEnvironment[\s\S]*Assert-WatcherProductionActivation/i.test(deployWatcher),
    'The deploy watcher must load and enforce the production network guard before and after activation.',
  );
  assert(
    /C:\\ProgramData\\Echo Chamber\\echo-core-host\.json[\s\S]*Assert-ProductionControlEnvironment[\s\S]*ServiceMutationProvider[\s\S]*Wait-EchoCoreHostProductionIngress/i.test(serviceGuard),
    'The canonical service guard must validate the active host environment before mutating and verify ingress afterward.',
  );
  assert(
    /exactly one direct echo-core-control\.exe child[\s\S]*Assert-ProductionControlListener[\s\S]*Assert-ProductionControlLanProbe/i.test(serviceGuard),
    'The canonical service guard must bind ingress verification to exactly one direct control child.',
  );
  assert(
    /VerificationAttempts[\s\S]*for \(\$attempt = 1; \$attempt -le \$Attempts; \$attempt\+\+\)/i.test(serviceGuard),
    'The canonical service guard must use bounded post-start verification retries.',
  );
  assert(
    /CORE_BIND=127\.0\.0\.1[\s\S]*unsafe config never reaches the service mutation provider[\s\S]*localhost-only live child never passes post-start verification/i.test(serviceGuardTest),
    'The canonical service guard tests must reject localhost-only configuration before and after activation.',
  );
  assert(
    !/\[string\]\$HostConfigPath/i.test(serviceGuard) &&
      /\$canonicalHostConfigPath = "C:\\ProgramData\\Echo Chamber\\echo-core-host\.json"[\s\S]*-ConfigPath \$canonicalHostConfigPath/i.test(serviceGuard),
    'The production service entry point must not expose a host-config override and must always use the canonical ProgramData JSON.',
  );
  assert(
    /fully qualified Windows drive-rooted path[\s\S]*Guarded Start requires EchoCoreHost to be Stopped[\s\S]*Guarded Restart did not replace either/i.test(serviceGuard),
    'The canonical service guard must reject ambiguous env paths and prove Start/Restart transitions.',
  );
  assert(
    /top-level JSON object[\s\S]*root must deserialize to a PSCustomObject[\s\S]*control_env_file must be a JSON string/i.test(serviceGuard),
    'The canonical service guard must enforce the Rust HostConfig JSON object/string shape under PowerShell 5.1.',
  );
  assert(
    /Stop-EchoCoreHostAfterFailedMutation[\s\S]*EchoAncillaryLanFailure[\s\S]*EchoSafeNoTransition[\s\S]*Stop-EchoCoreHostAfterFailedMutation @cleanupArgs/i.test(serviceGuard),
    'Hard post-mutation failures must stop partial-live state without treating ancillary LAN failures or a proven-safe no-op as hard.',
  );
  assert(
    /mutationProviderFailed[\s\S]*Assert-EchoCoreHostProductionHardSafetyOnce[\s\S]*safeUnchangedMutationFailure[\s\S]*Stop-EchoCoreHostAfterFailedMutation @cleanupArgs/i.test(serviceGuard),
    'A throwing service mutation must preserve only unchanged hard-safe service/control PIDs and clean up all other post-error states.',
  );
  assert(
    /already-running service before mutation[\s\S]*unchanged service and control PID[\s\S]*safe no-op Restart preserves[\s\S]*unsafe no-op Restart stops[\s\S]*ancillary LAN failure does not stop/i.test(serviceGuardTest),
    'The canonical service tests must cover transition proof and hard-versus-ancillary cleanup behavior.',
  );
  assert(
    /non-object host JSON root is rejected[\s\S]*non-PSCustomObject host root is rejected[\s\S]*non-string control_env_file is rejected/i.test(serviceGuardTest),
    'The canonical service tests must cover PowerShell 5.1 HostConfig root and field type rejection.',
  );
  assert(
    /throwing provider does not stop unchanged hard-safe[\s\S]*throwing provider with changed PIDs stops[\s\S]*throwing provider stops unchanged PIDs when hard safety cannot be proven/i.test(serviceGuardTest),
    'The canonical service tests must cover safe preservation and cleanup after a throwing mutation provider.',
  );
  assert(
    /test-production-network-lib\.ps1[\s\S]*test-echo-core-host-network-guard\.ps1[\s\S]*test-viewer-runtime-lib\.ps1/i.test(windowsNetworkGate),
    'The Windows production network gate must execute library, canonical service, and watcher integration tests.',
  );
  assert(
    packageJson.scripts?.['verify:production-network:windows'] ===
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File core/deploy/test-production-network.ps1',
    'package.json must expose the Windows production network verification gate.',
  );
  assert(
    /npm run verify:production-network:windows/i.test(operations),
    'docs/OPERATIONS.md must run the Windows production network verification gate during release preflight.',
  );
  assert(
    /echo-core-host-network-guard\.ps1[\s\S]*Preflight[\s\S]*genuine off-LAN verification/i.test(agents),
    'AGENTS.md must require the canonical service guard and genuine off-LAN verification.',
  );

  for (const file of listFiles('core/deploy', (candidate) => /\.ps1$/i.test(candidate))) {
    if (file === serviceGuardPath) continue;
    assert(
      !/(?:Start|Restart)-Service\s+(?:-Name\s+)?["']?EchoCoreHost\b/i.test(read(file)),
      `${file} must route EchoCoreHost Start/Restart through the canonical production service guard.`,
    );
  }
}

checkWorkflowGuardrails();
checkRootPackageGuardrails();
checkCargoWorkspaceGuardrails();
checkArchiveGuardrails();
checkCodexOperatingModelGuardrails();
checkProductionNetworkGuardrails();

if (failures.length > 0) {
  console.error('[guardrails] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[guardrails] ok');
