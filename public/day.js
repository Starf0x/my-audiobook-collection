// Which day it is, in degrees. The page turns with its covers: the same day
// number, the same 37° a day, so the whole app stands in one colour on any given
// day and takes a year to come back round.
//
// In the head of every page, so the first paint is already in today's colours
// rather than yesterday's for a frame. Without it the two glows keep the hues
// they were drawn in, which is day nought.
window.dayTint = (when = new Date()) => (Math.floor(
  (when.getTime() - when.getTimezoneOffset() * 60000) / 86400000) * 37) % 360;

const paintTheDay = () => document.documentElement.style
  .setProperty('--day', String(window.dayTint()));
paintTheDay();

// A page left open overnight — on a tablet in the kitchen, say — turns when the
// day does, the way it would if it had been reloaded.
const atMidnight = () => {
  const midnight = new Date();
  midnight.setHours(24, 0, 5, 0);
  setTimeout(() => {
    paintTheDay();
    atMidnight();
  }, Math.max(1000, midnight.getTime() - Date.now()));
};
atMidnight();
