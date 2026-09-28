// What somebody has finished, and what that is called.
//
// The count is of books **played to the end**, and it is kept as its own record
// rather than worked out from the listening data. That is the whole point of it:
// clearing your place in a book, unticking it, or starting it again says
// something about what you are listening to now, and nothing about what you have
// finished. A tally that fell when somebody tidied up would not be worth having.
//
// Ticking a book by hand is not a completion either. It is a useful thing to be
// able to say — "I have heard this one" — but it is a statement, and this counts
// what the app watched happen: the last track ran out.
//
// The levels are named by the owner. Nought to nine has no name and shows
// nothing at all beside a listener's name: a level everybody starts at is not an
// accomplishment, and a badge saying so is noise.
export const LEVELS = [
  { at: 100, name: 'Audio Legend Ultimate Level', icon: '⭐' },
  { at: 90, name: 'Grand Master Level', icon: '👑' },
  { at: 80, name: 'Audio Master Level', icon: '🏆' },
  { at: 70, name: 'Audio Expert Level', icon: '🎖️' },
  { at: 60, name: 'Story Master Level', icon: '📖' },
  { at: 50, name: 'Book Master Level', icon: '📚' },
  { at: 40, name: 'Story Seeker Level', icon: '🧭' },
  { at: 30, name: 'Book Hunter Level', icon: '🔍' },
  { at: 20, name: 'Listener Level', icon: '🎧' },
  { at: 10, name: 'Rookie Level', icon: '🌱' },
];

// The top level is what unlocks downloading. It is named here rather than
// written as 100 in three places, because the two ideas — "the highest level"
// and "may download" — are the same idea and must not drift apart.
export const TOP = LEVELS[0].at;

// What this many finished books is called, or null below the first level.
export function levelOf(finished) {
  const n = Number(finished) || 0;
  const got = LEVELS.find((l) => n >= l.at);
  if (!got) return { finished: n, at: 0, name: '', icon: '', next: LEVELS[LEVELS.length - 1] };
  const next = [...LEVELS].reverse().find((l) => l.at > n) || null;
  return { finished: n, at: got.at, name: got.name, icon: got.icon, next };
}

// Whether somebody may take a whole book away. The top level earns it, and the
// admin can hand it to anybody — which is the same switch, not a second one: a
// listener at the top who is then refused by the admin would be a puzzle.
export const mayDownload = (finished, granted) => !!granted || (Number(finished) || 0) >= TOP;
