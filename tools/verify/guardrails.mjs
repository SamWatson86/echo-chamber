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

checkWorkflowGuardrails();
checkRootPackageGuardrails();
checkCargoWorkspaceGuardrails();
checkArchiveGuardrails();
checkCodexOperatingModelGuardrails();

if (failures.length > 0) {
  console.error('[guardrails] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[guardrails] ok');
