// packaging — the two ways to install this app, kept saying the same thing.
//
// The Docker image and the LXC installer describe one app twice. The image pins
// a node, sets a port and names every setting; the installer and its systemd
// unit and its settings file do all of that again, in four more places. Nothing
// makes them agree, and nothing would notice for months: an install path is
// exercised once, by somebody who then has a working machine and never looks
// again. The suites run every push.
//
// So this reads them and holds them to each other. It checks facts that are
// written down twice, not behaviour — the behaviour is every other suite.
//
// Run: node tests/packaging.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const dockerfile = read('Dockerfile');
const script = read('install/lxc-install.sh');
const unit = read('install/my-audiobook-collection.service');
const envExample = read('install/my-audiobook-collection.env.example');
const workflow = read('.github/workflows/test.yml');
const index = read('server/index.js');

// --- one runtime, however it is installed --------------------------------
// `node:sqlite` is the database, and which major it is stable in is the whole
// reason this app pins one. A container on 26 and an LXC on whatever Debian
// ships would be two different apps with one set of checks.
const major = {
  image: (dockerfile.match(/FROM node:(\d+)-/) || [])[1],
  installer: (script.match(/^NODE_MAJOR=(\d+)/m) || [])[1],
  checks: (workflow.match(/node-version: '(\d+)'/) || [])[1],
};
check('the image, the installer and the checks all run one major of node',
  [major.image === major.installer, major.image === major.checks, major.image],
  [true, true, '26']);

// --- one port ------------------------------------------------------------
const port = {
  app: (index.match(/process\.env\.PORT \|\| (\d+)/) || [])[1],
  image: (dockerfile.match(/PORT=(\d+)/) || [])[1],
  settings: (envExample.match(/^PORT=(\d+)/m) || [])[1],
};
check('and one port, in the app, the image and the settings file',
  [port.app === port.image, port.app === port.settings, port.app],
  [true, true, '8523']);

// --- every setting the app reads is offered to somebody installing it -----
// This is the one that will actually catch something. A new `process.env.X`
// goes into the code and the compose file, and the LXC settings file is the
// copy nobody remembers — so the setting exists, is documented, and cannot be
// set on half the installs.
const reads = [...new Set([...fs.readdirSync(path.join(ROOT, 'server'))
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => [...read(`server/${f}`).matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))])]
  .sort();
// `NODE_ENV` and friends belong to the runtime, not to this app; nothing here
// sets them and nobody installing it should be offered one.
const OURS = reads.filter((n) => !['NODE_ENV', 'npm_package_version'].includes(n));
const offered = (text) => OURS.filter((n) => new RegExp(`^#?\\s*${n}=`, 'm').test(text));
check('every setting the server reads can be set in the LXC settings file',
  OURS.filter((n) => !offered(envExample).includes(n)), []);
// The image carries its own defaults for the two that describe where it runs —
// `ENV DATA_DIR=/data PORT=8523` — and compose maps a volume and a port against
// them rather than setting them again. An LXC has no image to carry anything,
// which is why its settings file names them and this does not ask compose to.
const fromImage = [...dockerfile.matchAll(/^ENV (.+)$/gm)]
  .flatMap((m) => m[1].split(/\s+/)).map((kv) => kv.split('=')[0]);
check('and in the compose file, apart from the two the image sets itself',
  OURS.filter((n) => !fromImage.includes(n))
    .filter((n) => !new RegExp(`^\\s*#?\\s*${n}:`, 'm').test(read('docker-compose.yml'))), []);

// --- the pieces point at each other --------------------------------------
// Three paths written twice: where the app is put, where the settings go, and
// what starts. A unit naming a directory the installer does not create is a
// service that will not start, and the installer is the only thing that would
// have told you.
const inScript = (name) => (script.match(new RegExp(`^${name}=(\\S+)`, 'm')) || [])[1];
check('the unit runs the app out of the directory the installer puts it in',
  (unit.match(/^WorkingDirectory=(\S+)/m) || [])[1], inScript('APP_DIR'));
check('and reads the settings file the installer writes',
  (unit.match(/^EnvironmentFile=(\S+)/m) || [])[1], inScript('ENV_FILE'));
check('and starts what the image starts',
  (unit.match(/^ExecStart=\S*node (\S+)/m) || [])[1],
  (dockerfile.match(/CMD \["node", "(\S+?)"\]/) || [])[1]);
check('and the installer installs the unit it ships under the name it uses',
  [script.includes('install/$UNIT'), (script.match(/^UNIT=(\S+)/m) || [])[1]],
  [true, 'my-audiobook-collection.service']);

// --- the installer is a script a stranger is asked to pipe into a shell ---
// So the two things that make that survivable are checked: it stops at the
// first failure rather than carrying on past one, and it refuses to overwrite
// a settings file that already holds somebody's password.
check('it stops at the first failure', /^set -euo pipefail$/m.test(script), true);
check('and never overwrites a settings file that is already there',
  /if \[ -f "\$ENV_FILE" \]/.test(script), true);

// --- the one thing that catches people on Proxmox ------------------------
// An unprivileged container shifts every id: PUID=99 inside is 100099 on the
// host, which owns nothing, so the app is refused permission to write in a
// collection whose permissions look perfectly right from the host. The installer
// reads /proc/self/uid_map and says so, because this is a whole afternoon to
// work out from the other end and one line to be told.
// Comments off first. The paragraph above that check explains what it reads and
// why, so a grep over the whole file passes on the explanation after the code
// has gone — which is how a check in `one-at-a-time` once passed for the wrong
// reason, in this same project, over this same mistake.
const runs = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
check('the installer really reads uid_map, rather than only mentioning it',
  /\/proc\/self\/uid_map/.test(runs), true);
check('and warns about shifted ids when it finds them',
  /unprivileged container/.test(runs), true);
check('and says it carries on, since it is about writing, not about starting',
  /Install carries on/.test(script), true);

// --- what Linux has to execute is stored the way Linux reads it ----------
// This is written on Windows and run on Linux, and git converts line endings on
// checkout by default. A shell script with CRLF does not run at all — the kernel
// reads `#!/usr/bin/env bash\r`, reports "bad interpreter", and names a program
// that plainly exists. `.gitattributes` pins these to LF; this is what notices
// if that file is lost or if one of them stops being covered by it.
const attrs = read('.gitattributes');
const shipped = fs.readdirSync(path.join(ROOT, 'install')).sort();
for (const ext of ['.sh', '.service']) {
  check(`every ${ext} is pinned to LF, or Linux will not run it`,
    new RegExp(`^\\*${ext.replace('.', '\\.')}\\s+text eol=lf`, 'm').test(attrs), true);
}
check('and no file in install/ carries the other kind',
  shipped.filter((f) => read(`install/${f}`).includes('\r')), []);

// --- three scripts, and which machine each belongs on --------------------
// `lxc-install.sh` installs the app onto whatever machine it runs on. The
// obvious place to paste a one-liner you found is the host's shell prompt, and
// there it installs node, ffmpeg, a NodeSource apt repository and a service onto
// the hypervisor. The owner did exactly that, and nothing in the command said it
// would. So it refuses, and names the two scripts that do belong there.
const creator = read('install/proxmox-create-lxc.sh');
const uninstaller = read('install/uninstall.sh');
const live = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

check('the installer refuses to run on the Proxmox host',
  [/\/etc\/pve/.test(live(script)), /command -v pct/.test(live(script))], [true, true]);
check('and says there what to run instead',
  [/proxmox-create-lxc\.sh/.test(script), /uninstall\.sh/.test(script)], [true, true]);
check('the creator refuses to run anywhere but the Proxmox host',
  /command -v pct >\/dev\/null \|\| die/.test(live(creator)), true);

// It asks, the way the community scripts do — a menu, then the defaults or
// every setting one at a time.
check('the creator asks, with a Default and an Advanced way through',
  [/whiptail/.test(live(creator)), /--menu/.test(live(creator)),
    /advanced\)/.test(live(creator))], [true, true, true]);
// The storage was pickable only under Advanced, so the quick path silently put
// the container on whichever pool `pvesm` listed first. A host with several has
// them for a reason. It is asked in both paths now, in the shape the scripts
// this is modelled on use: a radiolist with the free space beside each name,
// because "local-lvm or tank?" cannot be answered from the names alone.
const defaultBranch = (creator.match(/\n\s*default\)([\s\S]*?)\n\s*;;/) || [])[1] || '';
check('the storage is asked for in the quick path too, not only under Advanced',
  [/pick_storage/.test(defaultBranch),
    (live(creator).match(/^\s*\[ -n "\$storage" \] \|\| pick_storage$/gm) || []).length], [true, 2]);
// Scoped to the function that asks it. The template question is a radiolist
// too, so looking for one anywhere in the file passes whatever the storage
// question has become — which is exactly what it did.
const picker = (creator.match(/\npick_storage\(\) \{([\s\S]*?)\n\}/) || [])[1] || '';
check('and asked as a radiolist with the free space beside each pool',
  [/--radiolist/.test(picker), /Free: /.test(picker)], [true, true]);
check('and not asked at all when the host has only one, since that is not a choice',
  /-eq 1 \]; then\n\s*storage=/.test(picker), true);

// And only when there is somewhere to ask. `curl … | bash` leaves stdin as the
// pipe, and whiptail would read the rest of the script as the answers.
check('and only when there is a terminal to ask at',
  /\[ -t 0 \]/.test(live(creator)), true);
check('and every setting is still a flag, for a run with nobody watching',
  ['--id', '--hostname', '--storage', '--template', '--bridge', '--cores',
    '--memory', '--disk', '--books', '--import', '--unprivileged', '--yes']
    // `--yes|-y)` is a case with an alternative in it, so the flag is followed
    // by `)` or by `|`, not always by `)`
    .filter((f) => !new RegExp(`\\s${f}[)|]`, 'm').test(live(creator))), []);

// The community scripts pull a shared `build.func` from another repository and
// run it as root on the hypervisor. That is a fair trade for a framework
// covering hundreds of apps and a poor one for a single script somebody ought to
// be able to read in full, so none of these fetch code to execute. Said as a
// check because it is a decision, not a detail, and decisions drift.
check('none of the three sources code over the network to run as root',
  [script, creator, uninstaller].flatMap((s) => [...live(s).matchAll(/(?:source|\.)\s+<\(/g)]), []);
check('and installs by running the installer inside the container it made',
  /pct exec .*lxc-install\.sh/.test(live(creator)), true);

// --- the uninstaller removes what the installer wrote, and no more -------
// An uninstaller is only as good as its agreement with the installer: one that
// removes a path the installer never used does nothing, and one that removes a
// path it was not meant to is worse than having none.
for (const name of ['APP_DIR', 'ENV_FILE', 'UNIT']) {
  const mine = (text) => (text.match(new RegExp(`^${name}=(\\S+)`, 'm')) || [])[1];
  check(`the uninstaller's ${name} is the installer's ${name}`,
    mine(uninstaller), mine(script));
}
check('it keeps the database and the settings unless asked for --purge',
  [/--purge/.test(uninstaller), /if \[ "\$purge" -eq 1 \]/.test(live(uninstaller))], [true, true]);
check('and reads where the database is from the settings file, not from a guess',
  /DATA_DIR:-/.test(live(uninstaller)), true);
check('every one of the three stops at the first failure',
  [script, creator, uninstaller].map((s) => /^set -euo pipefail$/m.test(s)), [true, true, true]);

// --- ffmpeg, which converting needs --------------------------------------
check('both ways to install it bring ffmpeg, which converting needs',
  [/apk add .*ffmpeg/.test(dockerfile), /apt-get install .*ffmpeg/.test(script)], [true, true]);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
