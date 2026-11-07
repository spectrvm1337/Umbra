// A number shown as drums of digits that turn to the new value, blurred while they move, like a
// counter's; separators and words stay put. Lined up from the right, so units stay units, and a
// digit that is new (the number got longer) turns up from 0. Used by the currency card and by the
// numbers in Settings. A classic script: its functions are globals.
const FX_DIGITS = /^\d$/;
function fxCell(ch) {
  const cell = document.createElement("span");
  if (!FX_DIGITS.test(ch)) {
    cell.className = "fx-tc";
    cell.textContent = ch;
    return cell;
  }
  cell.className = "fx-dg";
  cell.style.setProperty("--d", ch);
  // The hidden copy gives the cell its width and baseline; the drum turns above it, clipped to a line.
  cell.innerHTML = `<span class="fx-dg-ghost">${ch}</span><span class="fx-reel"><i>0</i><i>1</i><i>2</i><i>3</i><i>4</i><i>5</i><i>6</i><i>7</i><i>8</i><i>9</i></span>`;
  return cell;
}
function fxTokens(text) {
  return text.match(/\d|\D+/g) || [];
}
function fxSetDigit(cell, ch) {
  cell.style.setProperty("--d", ch);
  cell.firstChild.textContent = ch;
}
function fxRoll(el, text, animate) {
  let cells = el._fxCells;
  if (!cells || cells.some((c) => c.parentNode !== el)) {
    // Plain text so far (a new card, a placeholder): made into cells as it stands, to turn from.
    cells = fxTokens(el.textContent).map(fxCell);
    el.replaceChildren(...cells);
  }
  if (!animate) el.classList.add("fx-still");
  // Each digit is a cell; a run of anything else is one, so words keep their kerning.
  const chars = fxTokens(text);
  const next = [];
  const turned = [];
  const fresh = [];
  for (let k = 1; k <= chars.length; k++) {
    const ch = chars[chars.length - k];
    const old = cells[cells.length - k];
    const digit = FX_DIGITS.test(ch);
    let cell;
    if (old && digit && old.classList.contains("fx-dg")) {
      cell = old;
      if (old.style.getPropertyValue("--d") !== ch) {
        fxSetDigit(old, ch);
        turned.push(old);
      }
    } else if (old && !digit && old.classList.contains("fx-tc") && old.textContent === ch) {
      cell = old;
    } else {
      cell = fxCell(digit && animate ? "0" : ch);
      if (digit && animate) fresh.push([cell, ch]);
    }
    next[chars.length - k] = cell;
  }
  const keep = new Set(next);
  for (const c of cells) if (!keep.has(c)) c.remove();
  // Into place from the right; cells already in place are not touched, so their drums keep turning.
  let after = null;
  for (let i = next.length - 1; i >= 0; i--) {
    const c = next[i];
    if (c.parentNode !== el || c.nextSibling !== after) el.insertBefore(c, after);
    after = c;
  }
  el._fxCells = next;
  if (fresh.length || turned.length || !animate) void el.offsetWidth;
  for (const [cell, ch] of fresh) {
    fxSetDigit(cell, ch);
    turned.push(cell);
  }
  if (!animate) {
    el.classList.remove("fx-still");
    return;
  }
  for (const c of turned) c.classList.remove("rolling");
  void el.offsetWidth;
  for (const c of turned) c.classList.add("rolling");
}

// A number in Settings (the radius, the zoom...): rolled to its new text, quickly (.roll-val), and
// set without a turn the first time and with Movement off. Read it back with rollText: once rolled,
// the element's own text is the drums' 0-9, not the number.
function rollSet(el, text) {
  text = String(text);
  if (el._rollText === text) return;
  const animate = el._rollText !== undefined && document.documentElement.dataset.animMove !== "off";
  el.classList.add("roll-val");
  el._rollText = text;
  fxRoll(el, text, animate);
}
function rollText(el) {
  return el._rollText !== undefined ? el._rollText : el.textContent;
}

// A whole line that turns over to new text: the old one rolls up and away out of a blur, the new one
// comes up from below. The hint over the drag bar. `animate` false (or no line yet) sets it at once.
function lineRollTo(el, text, animate) {
  const make = (cls) => {
    const line = document.createElement("span");
    line.className = cls ? "lr-line " + cls : "lr-line";
    line.textContent = text;
    return line;
  };
  const old = el.querySelector(":scope > .lr-line:not(.lr-out)");
  if (!animate || !old) {
    el.replaceChildren(make());
    return;
  }
  if (old.textContent === text) return;
  old.classList.add("lr-out");
  old.addEventListener("animationend", () => old.remove(), { once: true });
  setTimeout(() => old.remove(), 1500); // in case the animation never runs (Movement off)
  const line = make("below");
  el.appendChild(line);
  void line.offsetWidth;
  line.classList.remove("below");
}

// A line of text that turns over to new text like a drum, letter after letter: the old letters
// roll up and away out of a blur, the new ones come up from below. Used by the example queries in
// the empty search box. `animate` false sets it at once.
const CHAR_STAGGER_MS = 14;
function charLine(text, cls) {
  const line = document.createElement("span");
  line.className = "cr-line";
  [...text].forEach((ch, i) => {
    const c = document.createElement("span");
    c.className = cls ? "cr-ch " + cls : "cr-ch";
    c.textContent = ch;
    c.style.transitionDelay = Math.min(i * CHAR_STAGGER_MS, 300) + "ms";
    line.appendChild(c);
  });
  return line;
}
function charRollTo(el, text, animate) {
  const old = el.querySelector(":scope > .cr-line:not(.cr-out)");
  if (!animate) {
    el.replaceChildren(charLine(text));
    return;
  }
  if (old && old.textContent === text) return;
  if (old) {
    old.classList.add("cr-out");
    for (const c of old.children) c.classList.add("above");
    const ms = typeof motionMs === "function" ? motionMs("move", 500) : 500;
    setTimeout(() => old.remove(), ms + 350);
  }
  const line = charLine(text, "below");
  el.appendChild(line);
  void line.offsetWidth;
  for (const c of line.children) c.classList.remove("below");
}
