// Putting text on the clipboard, for the pages that offer to copy something.
//
// Its own file since 2.14.88, when the Home Assistant page wanted it too: it
// lived in `app.js`, which that page does not load, and a second copy written
// there would be the one that forgot the fallback below.
//
// `navigator.clipboard` exists only in a secure context, and this app is reached
// at http://192.168.x.x on a LAN — so on the one machine that matters it is not
// there at all, and the copy goes through a selected textarea instead (2.13.8).
async function toClipboard(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const box = document.createElement('textarea');
  box.value = text;
  box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  // Inside whichever dialog is open, because a modal one makes the rest of the
  // document inert and a textarea in the body could not be selected. With none
  // open — a copy button on a card, say — the body is where it has to go, since
  // a closed dialog is not rendered and nothing in it can be selected either.
  (document.querySelector('dialog[open]') || document.body).append(box);
  box.select();
  const ok = document.execCommand('copy');
  box.remove();
  return ok;
}
