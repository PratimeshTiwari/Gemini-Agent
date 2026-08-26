#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainJs = resolve(__dirname, 'main.js');

let tsxPath = resolve(__dirname, '../node_modules/.bin/tsx');
if (!existsSync(tsxPath)) {
  tsxPath = resolve(__dirname, '../../node_modules/.bin/tsx');
}

if (!existsSync(tsxPath)) {
  console.error("❌ 'tsx' not found. Please run 'npm install' in the workspace root or server directory.");
  process.exit(1);
}

// Forward execution to tsx so that JSX/TypeScript files work natively
const result = spawnSync(tsxPath, [mainJs, ...process.argv.slice(2)], { 
  stdio: 'inherit' 
});

process.exit(result.status ?? 0);
