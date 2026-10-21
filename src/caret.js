// The search box's text caret and selection, drawn by hand so they can move smoothly: the caret
// glides to where the next character goes, and a selection grows out of the caret to both sides
// instead of appearing at once. The native ones are hidden in styles.css; both are placed from
// the text's measured width and follow the input's own horizontal scroll.
(function () {
  const input = document.getElementById("search-input");
  const field = document.getElementById("input-field");
  if (!input || !field) return;
  const sel = document.createElement("div");
  sel.id = "sel";
  sel.setAttribute("aria-hidden", "true");
  const caret = document.createElement("div");
  caret.id = "caret";
  caret.setAttribute("aria-hidden", "true");
  field.append(sel, caret);
  const ctx = document.createElement("canvas").getContext("2d");
  let steadyTimer = 0;
  let caretX = null;
  let selShown = false;
  function xAt(pos, cs) {
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = ctx.measureText(input.value.slice(0, pos)).width;
    const left = w + parseFloat(cs.paddingLeft || 0) - input.scrollLeft;
    return Math.round(Math.max(0, Math.min(left, input.clientWidth)) * 2) / 2;
  }
  function setSel(left, width) {
    sel.style.transform = `translate(${left}px, -50%)`;
    sel.style.width = `${width}px`;
  }
  function update() {
    const focused = document.activeElement === input;
    const collapsed = input.selectionStart === input.selectionEnd;
    const cs = getComputedStyle(input);
    // The caret.
    caret.classList.toggle("on", focused && collapsed);
    if (collapsed) {
      const left = xAt(input.selectionStart, cs);
      if (left !== caretX) {
        caretX = left;
        caret.style.transform = `translate(${left}px, -50%)`;
        // Solid while it moves, fading in and out again once it has been still for a moment.
        caret.classList.add("moving");
        clearTimeout(steadyTimer);
        steadyTimer = setTimeout(() => caret.classList.remove("moving"), 520);
      }
    }
    // The selection.
    if (focused && !collapsed) {
      const a = xAt(input.selectionStart, cs);
      const b = xAt(input.selectionEnd, cs);
      if (!selShown) {
        // Starts as nothing at the caret, then opens out to the selection.
        sel.style.transition = "none";
        setSel(caretX ?? a, 0);
        void sel.offsetWidth;
        sel.style.transition = "";
        selShown = true;
        sel.classList.add("on");
      }
      setSel(a, Math.max(0, b - a));
    } else if (selShown) {
      selShown = false;
      sel.classList.remove("on");
      // Closes back into the caret.
      setSel(caretX ?? 0, 0);
    }
  }
  const later = () => requestAnimationFrame(update);
  for (const ev of ["input", "keydown", "keyup", "click", "mouseup", "mousemove", "focus", "blur", "select", "scroll"]) {
    input.addEventListener(ev, later);
  }
  document.addEventListener("selectionchange", later);
  // The box is cleared and refilled from code too (history, Tab, clear button).
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(input, "value", {
    get() { return valueDesc.get.call(this); },
    set(v) { valueDesc.set.call(this, v); later(); },
    configurable: true,
  });
  window.addEventListener("language-changed", later);
  // The caret's place depends on the font, which can change under it (Settings > Font).
  if (document.fonts) document.fonts.addEventListener("loadingdone", later);
  new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ["data-font"] });
  update();
})();
