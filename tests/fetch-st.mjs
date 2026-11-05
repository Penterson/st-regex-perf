// Downloads the SillyTavern files the tests run against into tests/.st/<name>/. st-version.json pins one commit per
// name (release, staging); ST_REF picks the name, default staging. SillyTavern is AGPL-3.0, so its code is fetched
// at test time instead of being copied into this repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(await readFile(join(here, 'st-version.json'), 'utf8'));
export const ST_REF = process.env.ST_REF || 'staging';
const pin = pins[ST_REF];
if (!pin) throw new Error(`ST_REF=${ST_REF}: not in tests/st-version.json (${Object.keys(pins).join(', ')})`);
export const ST_DIR = join(here, '.st', ST_REF);

/** Makes sure every pinned file is present for the pinned commit. */
export async function fetchSt() {
    const marker = join(ST_DIR, 'COMMIT');
    const have = await readFile(marker, 'utf8').catch(() => '');
    if (have.trim() === pin.commit) return;
    for (const file of pin.files) {
        const url = `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${file}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
        const dest = join(ST_DIR, file);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    }
    await writeFile(marker, pin.commit + '\n');
    console.log(`SillyTavern ${pin.commit.slice(0, 10)} (${pin.ref}): ${pin.files.length} files in tests/.st/${ST_REF}/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchSt();
