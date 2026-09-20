/** Package only public application assets. No build dependencies or network. */
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const publicFiles = Object.freeze([
  'index.html', 'styles.css', 'guide.css', 'bootstrap.min.css',
  'manifest.webmanifest', 'sw.js', '.nojekyll',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'js/app.js', 'js/store.js', 'js/dates.js', 'js/steps.js', 'js/recurrence.js',
  'js/alerts.js', 'js/pin-pad.js', 'js/teams.js', 'js/login.js', 'js/guide.js', 'js/firebase-config.js',
  'js/firebase-transport.js', 'js/vendor/firebase.js', 'js/vendor/firebase.js.LEGAL.txt',
  'js/vendor/README.md',
  'firebase/firestore.rules', 'firebase/firestore.indexes.json',
  'docs/FIREBASE-SETUP.md',
]);

export async function regularFile(root, name) {
  const parts = name.split('/');
  let path = root;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await lstat(path).catch((error) => {
      throw new Error(`Missing deployment asset: ${name}`, { cause: error });
    });
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Deployment assets must be regular files, without symbolic links: ${name}`);
    }
  }
  return path;
}

export async function packagePages(rootDirectory = projectRoot) {
  const root = await realpath(rootDirectory);
  // Adding a file to the source tree never makes it public automatically.
  const files = [...publicFiles].sort();
  // Validate everything before replacing a previous successful package.
  for (const name of files) await regularFile(root, name);
  const destination = join(root, 'dist');
  try {
    const previous = await lstat(destination);
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('Refusing to replace dist: it must be a regular directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(root, '.pages-build-'));
  try {
    for (const name of files) {
      const target = join(staging, name);
      if (relative(staging, target).startsWith(`..${sep}`)) throw new Error(`Invalid asset path: ${name}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, name), target);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory: destination, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await packagePages();
    console.log(`Prepared ${result.files.length} public files in dist/.`);
    console.log('No server, tests, dependencies, source maps or private configuration included.');
  } catch (error) {
    console.error(`Pages packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
