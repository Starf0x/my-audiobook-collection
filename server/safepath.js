// Where a path is allowed to be.
//
// Three routes in this app take a path from somewhere and hand it to the disk:
// the cover a book's row names, the folder an import moves, and the folder a
// skipped book is filed from. Each of them trusted what it was given, and each
// of them reaches past the collection when what it was given is not what was
// meant:
//
// * `books.cover` is written by `POST /api/apply/:id`, which is admin-only —
//   but `GET /api/cover/:id` is not, so a cover of `../../etc/passwd` turned an
//   admin's write into a file anybody on the network could read.
// * `POST /api/import` and `/api/skipped/file` move `source` to a new folder,
//   and neither asked whether the source was inside the import folder or the
//   library at all. Any folder on the host could be moved into the collection.
//
// So the rule is in one place, and it is the same rule every time: resolve both
// sides, follow the symlinks, and require the real path to sit under the real
// root. A path that cannot be resolved is not inside anything.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getLibraries } from './db.js';

// The path as the disk really sees it, or '' when it is not there. Symlinks are
// followed, because a link inside the collection pointing at /etc is exactly the
// case a string comparison would miss.
const real = (p) => {
  try {
    return fs.realpathSync(String(p || ''));
  } catch {
    return '';
  }
};

// Is `p` inside `root`? The root itself does not count: importing the import
// folder, or filing the library root as a book, is not a thing to allow either.
export function inside(root, p) {
  const top = real(root);
  const here = real(p);
  if (!top || !here) return false;
  return here !== top && here.startsWith(top + path.sep);
}

// The same, against any of a list of roots.
export const insideAny = (roots, p) => (roots || []).some((r) => inside(r, p));

// Every library folder, resolved. A book's own cover file lives beside its audio,
// so these are the only folders a `file:` cover may point into.
export const libraryRoots = () => getLibraries().map((l) => l.path).filter(Boolean);

// A cover this app stored is named after the image and nothing else: the hash of
// its bytes and an extension covers.js keeps. Anything else in that column was
// not put there by the scanner, the lookup or the paste route.
export const STORED_COVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpe?g|png)$/i;
export const storedCover = (name) => STORED_COVER.test(String(name || ''))
  && !String(name).includes('..');

// The file a book's `cover` column names, or '' when it names something this app
// has no business opening. Both kinds are checked, because both are written from
// places that can be wrong: the stored kind must be a bare name under
// `covers/`, and the kind that lives beside the audio must be a real file inside
// a library folder.
export function coverFile(cover) {
  const said = String(cover || '');
  if (!said) return '';
  if (!said.startsWith('file:')) {
    if (!storedCover(said)) return '';
    const here = path.join(DATA_DIR, 'covers', said);
    return fs.existsSync(here) ? here : '';
  }
  const beside = said.slice(5);
  if (!insideAny(libraryRoots(), beside)) return '';
  const here = real(beside);
  try {
    return here && fs.statSync(here).isFile() ? here : '';
  } catch {
    return '';
  }
}
