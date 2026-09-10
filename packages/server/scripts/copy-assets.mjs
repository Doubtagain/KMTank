// tsc only emits JavaScript, so non-TS assets are copied alongside the build.
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await cp(join(root, 'src/db/schema.sql'), join(root, 'dist/db/schema.sql'));
console.log('[build] copied schema.sql');
