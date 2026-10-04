// Same file selection as hypit/test/run.mjs; cap concurrency on small WSL hosts.
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../hypit/', import.meta.url)));
const files = [...new Set(['packages/*/test/**/*.test.ts','services/*/test/**/*.test.ts','test/**/*.test.ts','examples/*/packages/*/test/**/*.test.ts'].flatMap(p => globSync(p)))].sort();
if (!files.length) throw new Error('No upstream tests found');
const r=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=2','--test-timeout=120000',...files],{stdio:'inherit',windowsHide:true});
if(r.error) throw r.error;
process.exit(r.status ?? 1);
