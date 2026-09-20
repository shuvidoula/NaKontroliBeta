/** Reproducible local SDK bundle. No CDN imports are used by the shipped PWA. */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../node_modules/firebase/package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../js/vendor/', import.meta.url), { recursive: true });
await build({
  stdin: {
    contents: `export { initializeApp, deleteApp } from 'firebase/app';
export { getAuth, initializeAuth, setPersistence, inMemoryPersistence, signInWithEmailAndPassword, updatePassword, getIdTokenResult, signOut, connectAuthEmulator } from 'firebase/auth';
export { getFirestore, initializeFirestore, memoryLocalCache, connectFirestoreEmulator, doc, collection, getDoc, getDocFromServer, getDocs, getDocsFromServer, query, where, runTransaction, setDoc, updateDoc, serverTimestamp, Timestamp, deleteDoc, writeBatch, limit, orderBy, documentId, deleteField, terminate, disableNetwork, enableNetwork } from 'firebase/firestore';`,
    resolveDir: new URL('..', import.meta.url).pathname,
    sourcefile: 'firebase-local-entry.js',
  },
  outfile: new URL('../js/vendor/firebase.js', import.meta.url).pathname,
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  legalComments: 'linked', sourcemap: false,
  banner: { js: `/* Firebase JS SDK ${version}. Bundled locally by scripts/bundle-firebase.mjs. */` },
});
await writeFile(new URL('../js/vendor/README.md', import.meta.url), `# Local Firebase SDK\n\nFirebase JS SDK ${version}, bundled from the official npm firebase package.\nRebuild with npm ci followed by npm run build:firebase.\nLicense notices: firebase.js.LEGAL.txt. No CDN is required at runtime.\n`);
console.log(`Bundled Firebase ${version} → js/vendor/firebase.js`);
