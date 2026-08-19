/* Reading a garment's colour off its photograph.

   The COLOUR axis counted the word the shop printed, and shops name moods
   rather than colours: ONYX, SUNRISE, REEF, SUN KISSED BROWN, HEATWAVE — five
   ones, no two shops using the same words, and nothing a designer can compare
   across brands. The photograph is the one thing every shop publishes in the
   same language.

   Product shots are made of a backdrop, a model and the garment, so the
   fixtures here are built the same way and the reader has to come back with
   the garment. Synthetic, because that is the only way to know the right
   answer in advance — a real photograph can only be argued about.

   Run: node tests/colour-test.js */
"use strict";
const C = require("../report/colour.js");

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  if (!good) console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};

console.log("familyOf — the neutrals, which are most of a wardrobe");
ok("pure black", C.familyOf(0, 0, 0), "Black");
ok("off black", C.familyOf(22, 22, 24), "Black");
ok("charcoal", C.familyOf(70, 70, 72), "Grey");
ok("mid grey", C.familyOf(150, 150, 152), "Grey");
ok("a paler grey", C.familyOf(200, 200, 202), "Light grey");
ok("white", C.familyOf(252, 252, 250), "White");
ok("cream", C.familyOf(245, 236, 216), "Cream");
ok("beige", C.familyOf(214, 196, 166), "Beige");
ok("camel is a brown at this depth", C.familyOf(140, 100, 55), "Brown");

console.log("familyOf — and the colours a season is named after");
ok("navy", C.familyOf(20, 30, 70), "Navy");
ok("mid blue", C.familyOf(60, 110, 200), "Blue");
ok("red", C.familyOf(200, 40, 40), "Red");
ok("pink", C.familyOf(240, 170, 190), "Pink");
ok("olive-green", C.familyOf(90, 130, 60), "Green");
ok("teal", C.familyOf(40, 140, 150), "Teal");
ok("mustard", C.familyOf(210, 180, 40), "Yellow");
ok("purple", C.familyOf(120, 70, 180), "Purple");

console.log("the skin band nominates; it does not convict");
ok("light skin is in the band", C.inSkinBand(232, 190, 160), true);
ok("deep skin is in the band", C.inSkinBand(120, 82, 58), true);
ok("a red dress is not", C.inSkinBand(200, 40, 40), false);
ok("a grey knit is not", C.inSkinBand(150, 150, 150), false);
/* …and beige is, which is exactly why the band cannot be the whole rule: a
   beige dress on a model came back as nothing at all when it was. */
ok("but so is beige — the case that broke it", C.inSkinBand(214, 196, 166), true);

/* ---- whole pictures ------------------------------------------------------

   Each fixture is a product shot: a backdrop, a garment block in the middle,
   and — where it matters — a model's skin around it. */
const W = 60, H = 80;
function shot(backdrop, garment, opts) {
  opts = opts || {};
  const px = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, c) => {
    const i = ((y * W) + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, backdrop);
  // the model: a body-wide skin column, so the garment sits on a person
  if (opts.skin) {
    for (let y = 8; y < H - 6; y++) for (let x = 16; x < W - 16; x++) put(x, y, opts.skin);
  }
  // the garment, centred, covering most of the middle band
  const gx0 = opts.gx0 == null ? 18 : opts.gx0, gx1 = opts.gx1 == null ? W - 18 : opts.gx1;
  const gy0 = opts.gy0 == null ? 20 : opts.gy0, gy1 = opts.gy1 == null ? H - 16 : opts.gy1;
  for (let y = gy0; y < gy1; y++) for (let x = gx0; x < gx1; x++) put(x, y, garment);
  return px;
}
const read = (bd, g, o) => C.readSwatch(shot(bd, g, o), W, H);

console.log("a whole product shot");
const WHITE_BD = [250, 250, 250], GREY_BD = [232, 232, 230], SKIN = [232, 190, 160];

let r = read(WHITE_BD, [18, 18, 20], { skin: SKIN });
ok("black dress on white, on a model", r && r.family, "Black");

r = read(WHITE_BD, [250, 248, 245], { skin: SKIN });
ok("a WHITE garment on a white backdrop is still found", r && r.family, "White");

r = read(GREY_BD, [30, 40, 82], { skin: SKIN });
ok("navy on grey", r && r.family, "Navy");

r = read(WHITE_BD, [205, 45, 45], { skin: SKIN });
ok("red on white", r && r.family, "Red");

r = read(WHITE_BD, [214, 196, 166], { skin: SKIN });
ok("beige — the one skin would have stolen", r && r.family, "Beige");

r = read([40, 40, 44], [242, 238, 232], {});
ok("a light garment on a dark backdrop", r && r.family, "White");

console.log("and it reports the frame rather than inventing one");
/* A frame that is nothing but backdrop is that colour, and saying so is
   honest — it is what the picture shows. What it must never do is name a
   colour that is not in the picture at all. */
r = C.readSwatch(shot(WHITE_BD, WHITE_BD, {}), W, H);
ok("a frame that is all backdrop reads as that colour", r && r.family, "White");
r = C.readSwatch(new Uint8ClampedArray(W * H * 4), W, H);   // fully transparent
ok("a frame with nothing in it says nothing", r, null);
/* Several things at once — no single colour holds the frame. */
const mixed = shot(WHITE_BD, [200, 40, 40], { gx0: 18, gx1: 30, gy0: 20, gy1: 64 });
(function paintSecond() {
  for (let y = 20; y < 64; y++) for (let x = 30; x < 42; x++) {
    const i = ((y * W) + x) * 4;
    mixed[i] = 40; mixed[i + 1] = 90; mixed[i + 2] = 200; mixed[i + 3] = 255;
  }
})();
r = C.readSwatch(mixed, W, H);
ok("two garments split the frame, so one of them is still named",
  !!(r && (r.family === "Red" || r.family === "Blue")), true);

console.log("hex, for the swatch on the card");
ok("black", C.hex([18, 18, 20]), "#121214");
ok("clamps", C.hex([300, -4, 128]), "#ff0080");

console.log(`\n${pass} passed, ${fail} failing`);
process.exit(fail ? 1 : 0);
