// Draws the middle CELLS x CELLS of each captured frame (the page's GRID x GRID square).
const CELLS = 15;
const canvas = document.getElementById("px");
const ctx = canvas.getContext("2d");
const img = ctx.createImageData(CELLS, CELLS);
window.__TAURI__.event.listen("color-pick", (e) => {
  const px = e.payload.pixels;
  if (!px || !px.length) return;
  const grid = Math.round(Math.sqrt(px.length));
  const from = (grid - CELLS) >> 1;
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < CELLS; x++) {
      const hex = px[(from + y) * grid + from + x];
      const o = (y * CELLS + x) * 4;
      img.data[o] = parseInt(hex.slice(1, 3), 16);
      img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
});
