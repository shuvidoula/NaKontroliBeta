/** Create a reproducible upload archive from explicitly approved source files. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicFiles, regularFile } from './package-pages.mjs';

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const releaseSourceFiles = Object.freeze([...new Set([
  ...publicFiles,
  '.gitignore', '.github/workflows/pages.yml', 'README.md',
  'docs/TEAMS-ARCHITECTURE.md', 'docs/TEST-REPORT.md',
  'scripts/package-pages.mjs', 'scripts/package-release.mjs',
  'scripts/bundle-firebase.mjs', 'scripts/manage-accounts.mjs',
])].sort());

export function releaseManifest(source) {
  for (const [group, names] of Object.entries({ dependencies: ['firebase'], devDependencies: ['esbuild', 'firebase-admin'] })) {
    for (const name of names) {
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(source[group]?.[name] || '')) {
        throw new Error(`Release dependency needs an exact version: ${name}`);
      }
    }
  }
  return {
    name: 'na-kontroli', ...(source.version ? { version: source.version } : {}),
    private: true, type: 'module', engines: { node: '>=24' },
    scripts: {
      'build:pages': 'node scripts/package-pages.mjs',
      'build:release': 'node scripts/package-release.mjs',
      'build:firebase': 'node scripts/bundle-firebase.mjs',
      accounts: 'node scripts/manage-accounts.mjs',
    },
    dependencies: { firebase: source.dependencies.firebase },
    devDependencies: { esbuild: source.devDependencies.esbuild, 'firebase-admin': source.devDependencies['firebase-admin'] },
  };
}

const archivePython = `import hashlib, json, pathlib, sys, zipfile
root, output, names = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), json.loads(sys.argv[3])
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in names:
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / name).read_bytes(), compresslevel=9)
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None or archive.namelist() != names:
        raise RuntimeError('Archive verification failed')
    for name in names:
        if archive.read(name) != (root / name).read_bytes():
            raise RuntimeError('Archive content mismatch: ' + name)
print(json.dumps({'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))
`;

export async function packageRelease(rootDirectory = projectRoot) {
  const root = await realpath(rootDirectory);
  const sourceFiles = [...releaseSourceFiles, 'package.json', 'package-lock.json'];
  for (const name of sourceFiles) await regularFile(root, name);
  const manifest = releaseManifest(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  const destination = join(root, 'NaKontroli-GitHub.zip');
  try {
    const previous = await lstat(destination);
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('Refusing to replace release archive: it must be a regular file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(root, '.release-build-'));
  try {
    for (const name of sourceFiles) {
      const target = join(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, name), target);
    }
    await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Reuse the pinned lock; prune emulator/test-only dependencies without network access.
    await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', join(staging, '.npm-cache')], { cwd: staging, timeout: 60_000 });
    const lock = JSON.parse(await readFile(join(staging, 'package-lock.json'), 'utf8'));
    if (JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(manifest.dependencies)
      || JSON.stringify(lock.packages?.['']?.devDependencies) !== JSON.stringify(manifest.devDependencies)
      || lock.packages?.['node_modules/firebase-tools'] || lock.packages?.['node_modules/@firebase/rules-unit-testing']) {
      throw new Error('Release lockfile still contains development-only dependencies.');
    }
    // A helper or document modified during packaging must not silently create a mixed release.
    for (const name of releaseSourceFiles) {
      if (!(await readFile(join(staging, name))).equals(await readFile(join(root, name)))) {
        throw new Error(`Source changed during release packaging: ${name}`);
      }
    }
    const files = sourceFiles.sort();
    const archive = join(staging, 'release.zip');
    const { stdout } = await run('python3', ['-c', archivePython, staging, archive, JSON.stringify(files)], { timeout: 60_000 });
    const verified = JSON.parse(stdout);
    await rename(archive, destination);
    return { archive: destination, files, ...verified };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await packageRelease();
    console.log(`Prepared ${result.files.length} verified files in NaKontroli-GitHub.zip (${result.bytes} bytes).`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log('No test data, emulator settings, credentials, logs or installed dependencies included.');
  } catch (error) {
    console.error(`Release packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
