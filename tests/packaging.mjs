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

// --- two scripts, and which machine each belongs on ----------------------
// `lxc-install.sh` installs the app onto whatever machine it runs on. The
// obvious place to paste a one-liner you found is the host's shell prompt, and
// there it installs node, ffmpeg, a NodeSource apt repository and a service onto
// the hypervisor. The owner did exactly that, and nothing in the command said it
// would. So it refuses, and names the two that do belong there.
//
// There used to be a third: a hand-rolled container creator with whiptail menus
// of its own. Offering it beside the helper script is what had the owner run the
// wrong one twice — there is a standard for this, and a second way of doing the
// same job is not a kindness. It is gone, and this is what keeps it gone.
const uninstaller = read('install/uninstall.sh');
const live = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

check('the installer refuses to run on the Proxmox host',
  [/\/etc\/pve/.test(live(script)), /command -v pct/.test(live(script))], [true, true]);
check('and sends you to the helper script, the one way in on a host',
  [/ct\/my-audiobook-collection\.sh/.test(script), /uninstall\.sh/.test(script)], [true, true]);
check('and no second way of making a container is offered beside it',
  fs.existsSync(path.join(ROOT, 'install/proxmox-create-lxc.sh')), false);
// The GUI is not ours to get right or wrong any more: the menu, the storage
// radiolist, the spinners and the banner all come from the engine the helper
// script loads. What is checked below is the little that is still ours — where
// the engine looks for this app's pieces, and what the end of it says.
//
// `lxc-install.sh` is the one that still fetches nothing to execute, and that
// stays a check because it is a decision rather than a detail.
check('the installer sources nothing over the network to run as root',
  [...live(script).matchAll(/(?:source|\.)\s+<\(/g)], []);

// --- the uninstaller removes what the installer wrote, and no more -------
// An uninstaller is only as good as its agreement with the installer: one that
// removes a path the installer never used does nothing, and one that removes a
// path it was not meant to is worse than having none.
for (const name of ['APP_DIR', 'ENV_FILE', 'UNIT']) {
  const mine = (text) => (text.match(new RegExp(`^${name}=(\\S+)`, 'm')) || [])[1];
  check(`the uninstaller's ${name} is the installer's ${name}`,
    mine(uninstaller), mine(script));
}
check('and takes the updater with it, or a path unit is left watching a folder',
  [/UPDATE_PATH=/.test(live(uninstaller)), /UPDATE_BIN=/.test(live(uninstaller)),
    /rm -f .*UPDATE_PATH/.test(live(uninstaller))], [true, true, true]);
check('it keeps the database and the settings unless asked for --purge',
  [/--purge/.test(uninstaller), /if \[ "\$purge" -eq 1 \]/.test(live(uninstaller))], [true, true]);
check('and reads where the database is from the settings file, not from a guess',
  /DATA_DIR:-/.test(live(uninstaller)), true);
check('both of them stop at the first failure',
  [script, uninstaller].map((s) => /^set -euo pipefail$/m.test(s)), [true, true]);

// --- the Proxmox VE Helper Script pair ------------------------------------
// `ct/my-audiobook-collection.sh` is the community-scripts entry point, and it
// behaves like theirs because it *is* theirs: the engine comes from
// community-scripts/core. What makes it work for an app outside their
// repository is one export. Their engine resolves two roots — its own files
// from COMMUNITY_SCRIPTS_CORE_URL, and `ct/` and `install/` from
// COMMUNITY_SCRIPTS_URL — and left unset the second is their script repo, so
// the install step would be fetched from there and 404.
const ct = read('ct/my-audiobook-collection.sh');
check('the helper script points the engine at this repository for ct/ and install/',
  /export COMMUNITY_SCRIPTS_URL=.*Starf0x\/my-audiobook-collection/.test(live(ct)), true);
check('and still loads the engine itself from community-scripts',
  /community-scripts\/core.*core\/build\.func/.test(live(ct)), true);

// The engine computes the installer's filename from the app's name: `${APP,,}`
// with the spaces taken out, plus `-install`. Rename either and it fetches
// something that is not there.
const app = (ct.match(/^APP="([^"]+)"/m) || [])[1] || '';
check('the installer is named what the engine will ask for',
  `install/${app.toLowerCase().replace(/ /g, '')}-install.sh`,
  'install/myaudiobookcollection-install.sh');
check('and that file is really here',
  shipped.includes(`${app.toLowerCase().replace(/ /g, '')}-install.sh`), true);

// It is the same app however it is installed, so the node it runs on is too.
const ctInstall = read('install/myaudiobookcollection-install.sh');
check('and installs the same major of node as the image',
  (ctInstall.match(/NODE_VERSION="(\d+)"/) || [])[1], major.image);

// The line the owner was missing: the address, at the end, in their shape.
check('the helper script ends by saying where the app now is',
  [/Completed successfully/.test(ct), /Access it using the following URL/.test(ct),
    /http:\/\/\$\{IP\}:8523/.test(ct)], [true, true, true]);
check('and the port it prints is the one the app listens on',
  (ct.match(/http:\/\/\$\{IP\}:(\d+)/) || [])[1], port.app);
// And how to mount the two folders, at the moment somebody needs it: the app is
// up and has nothing to show, because the collection is the host's to mount and
// the container has to be rebooted to see it. Two commands, no explaining.
check('and says how to mount the two folders, with the container it just made',
  [/-mp0 .*mp=\/audiobooks/.test(ct), /-mp1 .*mp=\/import/.test(ct),
    /pct reboot \$\{CTID\}/.test(ct)], [true, true, true]);

// --- taking a new version --------------------------------------------------
// The app runs as PUID, not root: `user.js` drops before anything is created.
// So it can neither write in /opt nor restart a unit, and that is right rather
// than an obstacle — a page that can run a root script runs it for whoever
// reaches it, and with no ADMIN_PASSWORD set this one is open to the network by
// design. It asks instead: a file in its own data folder, and a root-owned path
// unit watching for it. The root side only ever does one fixed thing, and
// nothing in that file is read, so asking is not an escalation.
const updater = read('install/update.sh');
const pathUnit = read('install/my-audiobook-collection-update.path');
const oneshot = read('install/my-audiobook-collection-update.service');
const updates = read('server/updates.js');

check('the app asks for an update rather than running one',
  [/writeFileSync\(ASK/.test(updates), /child_process|execSync|spawn/.test(updates)], [true, false]);
check('and the thing that does it is root, started by watching for that file',
  [/^PathExists=/m.test(pathUnit), /^Unit=my-audiobook-collection-update\.service$/m.test(pathUnit),
    /^Type=oneshot$/m.test(oneshot)], [true, true, true]);
check('the oneshot takes no argument, so the file cannot say what to run',
  (oneshot.match(/^ExecStart=(.+)$/m) || [])[1], '/usr/local/bin/my-audiobook-collection-update');

// The watch and the app have to agree on one folder, or the file is written
// where nothing is looking and the button does nothing at all.
const envDefault = (envExample.match(/^DATA_DIR=(\S+)/m) || [])[1];
check('the path unit watches the folder the settings file names',
  (pathUnit.match(/^PathExists=(\S+)\/update-wanted$/m) || [])[1], envDefault);
check('and both installers substitute the real one in, for a DATA_DIR that differs',
  [/PathExists=.*update-wanted/.test(script), /PathExists=.*update-wanted/.test(ctInstall)],
  [true, true]);

// Clearing the request first is what stops it running for ever: left behind, the
// path unit fires again the moment the oneshot exits.
// `indexOf` returns -1 for something that is not there, and -1 is before
// everything — so "A comes before B" passes when A has been deleted outright,
// which is the case worth catching. Both have to be present first.
const before = (text, a, b) => {
  const [i, j] = [text.indexOf(a), text.indexOf(b)];
  return i >= 0 && j >= 0 && i < j;
};
check('the updater clears the request before doing anything else',
  before(live(updater), 'rm -f "$ASK"', 'fetch --tags'), true);
check('and stops the app before npm replaces what it is running from',
  before(live(updater), 'systemctl stop', 'npm ci'), true);
check('and looks again after starting it, since started is not running',
  /is-active --quiet/.test(live(updater)), true);
check('and leaves word of how it went, because it restarted whoever asked',
  [/update-said\.json/.test(updater), /SAID/.test(live(updater))], [true, true]);

// One update, however it is reached: the button, the command in the container
// and the helper script on the host must not be three different procedures.
// The steps, not the spelling: the updater runs git with `-C "$APP_DIR"` and
// the helper script runs it from a `cd`, which is the same thing said twice.
check('the helper script, the shell command and the button do the same thing',
  ['fetch --tags', 'npm ci --omit=dev', 'tag --sort=-v:refname']
    .filter((step) => !(new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(live(updater))
      && new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(ct))), []);

// --- which of two versions is the newer one ------------------------------
// This project numbers in eights and rolls over, so it reaches 2.11.64 while
// 2.9.80 still exists — and compared as text, "2.9.80" sorts above "2.11.64"
// because "9" is after "1". A version check that got this wrong would offer an
// update backwards, or stay silent on a real one for ever.
const { newer: isNewer } = await import('../server/updates.js');
check('a later minor wins, however the two read as text', [
  isNewer('2.11.64', '2.9.80'), isNewer('2.9.80', '2.11.64'),
], [true, false]);
check('and the rest of it behaves', [
  isNewer('2.11.64', '2.11.64'), isNewer('v2.11.72', '2.11.64'),
  isNewer('3.0.0', '2.11.64'), isNewer('2.11.8', '2.11.64'),
  isNewer('2.12.0', '2.11.64'), isNewer('', '2.11.64'),
], [false, true, true, false, true, false]);

// --- ffmpeg, which converting needs --------------------------------------
check('both ways to install it bring ffmpeg, which converting needs',
  [/apk add .*ffmpeg/.test(dockerfile), /apt-get install .*ffmpeg/.test(script)], [true, true]);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
