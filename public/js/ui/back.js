// The Back button (or gesture) closes whatever is open on top of the page, such as a dialog or the
// menu drawer, rather than leaving the page, or closing the app when it was installed and this
// is the first page. While anything is open, one extra history entry with the same address sits
// on top. Back takes it off, which closes the top layer. Closing a layer some other way (its
// close button, Escape) takes the entry off again, so history stays as it was.
const layers = [];
let guarded = false; // our extra entry is on top of history
let ownBack = false; // a Back we started ourselves is on its way
let settling = null;

const isGuard = (state) => state?.briskLayer === true;

function pushGuard() {
  history.pushState({ briskLayer: true }, '');
  guarded = true;
}

// Open a layer. close() is called when Back is pressed; it returns false to stay open (a dialog
// that can't be dismissed yet). Returns a function to call when the layer closes by other means.
export function openLayer(close) {
  const layer = { close };
  layers.push(layer);
  if (!guarded) pushGuard();
  return () => dropLayer(layer);
}

function dropLayer(layer) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  if (layers.length || !guarded) return;
  guarded = false;
  // A link was followed meanwhile, so our entry is no longer on top: leave history alone
  if (!isGuard(history.state)) return;
  ownBack = true;
  settling = new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('popstate', done);
      ownBack = false;
      settling = null;
      resolve();
    };
    window.addEventListener('popstate', done);
    // In case the browser never moves (it always should), so the next real Back isn't swallowed
    timer = setTimeout(done, 1000);
  });
  history.back();
}

window.addEventListener('popstate', (event) => {
  if (ownBack) {
    ownBack = false;
    return;
  }
  if (!guarded || isGuard(event.state) || !layers.length) return;
  // Back was pressed with something open: close the top layer, and put the entry back while
  // anything is still open (or the layer chose to stay)
  guarded = false;
  const top = layers.pop();
  if (top.close() === false) layers.push(top);
  if (layers.length) pushGuard();
});

// Resolves once any Back started by closing a layer has finished. Navigating before then would
// be undone by that Back, so the router waits for this.
export const settled = () => settling || Promise.resolve();
