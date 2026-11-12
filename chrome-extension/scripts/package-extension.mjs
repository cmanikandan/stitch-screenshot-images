#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const distDir = path.resolve(repoRoot, 'dist');

// Read and parse manifest.json
const manifestPath = path.join(extensionRoot, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`Error: manifest.json not found at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version || '1.0.0';
const name = manifest.name || 'PageStitch';

console.log(`Packaging ${name} v${version} for Chrome Web Store / deployment...`);

// Explicit production file list to guarantee zero test or dev files in production package
const productionFiles = [
  'manifest.json',
  'background/service-worker.js',
  'content/page-inspector.js',
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'shared/gemini-client.js',
  'shared/stitch-math.js',
  'icons/icon-16.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
];

// Verify all files exist
for (const relPath of productionFiles) {
  const fullPath = path.join(extensionRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Error: Required production file missing: ${relPath}`);
    process.exit(1);
  }
}

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const zipFileName = `pagestitch-chrome-extension-v${version}.zip`;
const zipFilePath = path.join(distDir, zipFileName);
const latestZipFilePath = path.join(distDir, 'pagestitch-chrome-extension-latest.zip');

// Remove old zip if present
if (fs.existsSync(zipFilePath)) {
  fs.unlinkSync(zipFilePath);
}
if (fs.existsSync(latestZipFilePath)) {
  fs.unlinkSync(latestZipFilePath);
}

// Use python3 zipfile for 100% cross-platform standard compression
const pythonScript = `
import zipfile, sys, os

zip_path = sys.argv[1]
ext_root = sys.argv[2]
files = sys.argv[3:]

with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for rel_path in files:
        full_path = os.path.join(ext_root, rel_path)
        zf.write(full_path, arcname=rel_path)

print(f"Zip created successfully: {len(files)} files archived.")
`;

try {
  execFileSync('python3', ['-c', pythonScript, zipFilePath, extensionRoot, ...productionFiles], {
    stdio: 'inherit'
  });
} catch (err) {
  console.error('Failed to create zip package:', err);
  process.exit(1);
}

// Copy to latest.zip
fs.copyFileSync(zipFilePath, latestZipFilePath);

// Validate zip output
const stat = fs.statSync(zipFilePath);
console.log(`\nDeployment package created successfully:`);
console.log(`  Artifact: ${zipFilePath}`);
console.log(`  Latest:   ${latestZipFilePath}`);
console.log(`  Size:     ${(stat.size / 1024).toFixed(2)} KB (${stat.size} bytes)`);
console.log(`  Files:    ${productionFiles.length}`);
productionFiles.forEach(f => console.log(`    - ${f}`));
console.log('\nReady for upload to the Chrome Web Store Developer Dashboard or manual sideloading.\n');
