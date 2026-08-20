// Build cloud/jka-editions.json - the SERVER's allowlist of genuine Jedi Academy data files.
//
// The Cloud Locker accepts an upload only if it can place the file in this list: either the MD5
// matches a recorded build ('exact'), or the name is known and the size is within tolerance
// ('size'). Anything else is refused, so the locker can only ever hold real game data rather than
// becoming arbitrary object storage. server.js also derives the accepted file extensions from this
// file, so a manifest of .pk3 entries is what restricts uploads to .pk3.
//
// UNLIKE ja2-web there is no upstream source of truth to generate this from. Stracciatella ships
// resource-pack JSON listing every file of every supported edition with size and MD5; Raven's GPL
// drop ships nothing equivalent, and the retail archives are not redistributable, so the list has
// to be built by hashing installs we can actually see.
//
//   node cloud/build-editions.mjs <path-to-GameData> [<path-to-GameData> ...]
//
// Each path is the GameData folder (or the base folder inside it) of a legal install. Run it again
// with more installs to widen coverage; entries are merged, and a (size, md5) pair already present
// is not duplicated.
//
// COVERAGE, stated plainly: an edition that has never been hashed here is NOT rejected. Its files
// fall through to the size tier - same name, size within SIZE_TOLERANCE - which is exactly the
// graceful degradation server.js is built around. Adding an edition upgrades it from 'size' to
// 'exact'; it does not decide whether it works at all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node cloud/build-editions.mjs <path-to-GameData> [more...]');
  process.exit(2);
}
const OUT = path.join(import.meta.dirname, 'jka-editions.json');

// Merge into whatever is already recorded rather than replacing it: each run usually sees one
// install, and the point is to accumulate editions over time.
let files = {};
try { files = JSON.parse(fs.readFileSync(OUT, 'utf8')).files || {}; } catch { /* first run */ }

const md5 = (p) => {
  const h = crypto.createHash('md5');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
};

// The archives live in base/ (retail) or demo/ (the free demo mission). Accept being pointed at
// GameData, at base itself, or at a tree containing them.
function* archives(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (/\.pk3$/i.test(e.name)) yield full;
    }
  }
}

let added = 0, seen = 0, installs = 0;
for (const root of args) {
  if (!fs.existsSync(root)) { console.error(`skip (no such path): ${root}`); continue; }
  installs++;
  for (const full of archives(root)) {
    seen++;
    // Key by bare archive name: the engine looks paks up by name on its search path, and the same
    // assets0.pk3 is valid whether it came from base/ or demo/.
    const key = path.basename(full).toLowerCase();
    const size = fs.statSync(full).size;
    const hash = md5(full);
    const list = (files[key] ||= []);
    if (!list.some((e) => e.size === size && e.md5 === hash)) { list.push({ size, md5: hash }); added++; }
  }
}

fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), installs, files }));
const variants = Object.values(files).reduce((n, l) => n + l.length, 0);
console.log(`wrote ${OUT}`);
console.log(`  ${Object.keys(files).length} distinct archives, ${variants} variants total`);
console.log(`  this run: ${installs} install(s), ${seen} archive(s) hashed, ${added} new variant(s)`);
