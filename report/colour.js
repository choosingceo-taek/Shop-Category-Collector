/* What colour the garment actually is, read from its photograph.

   The COLOUR axis has always counted the word the shop printed, and shops do
   not name colours — they name moods. A week of "ONYX · SUNRISE · REEF · SUN
   KISSED BROWN · HEATWAVE" is five ones, tells a designer nothing about what
   the season looks like, and cannot be compared across brands because no two
   shops invent the same words. The photograph is the one thing every shop
   publishes in the same language.

   Two pure pieces live here, so both are testable without a browser:

     familyOf(r,g,b)   one colour → one name from a CLOSED vocabulary
     readSwatch(px, w, h)  a decoded image → the garment's colour

   The vocabulary is closed on purpose, for the same reason the fibre list is:
   colour families are settled trade language, and the whole point is that
   twelve brands land in the same buckets. Inventing a bucket per shop would
   rebuild the problem this replaces.

   What readSwatch has to get past is a product shot: a backdrop, a model, and
   the garment. It never asks which shop it is — the rules are about the
   picture:

     · the BACKDROP is whatever the corners agree on, so it is measured from
       this image rather than assumed to be white. A garment photographed on
       white and the same garment on grey both work, and a white garment on
       white is still found because only pixels close to the corner colour go.
     · SKIN is a bounded warm, unsaturated band. Dropping it is what stops
       every model shot reading as "beige".
     · the CENTRE holds the garment. Product photography puts it there; the
       edges hold backdrop, props and the model's limbs.

   What is left is bucketed by family and the biggest bucket wins, rather than
   averaging: the mean of a red dress and a white wall is pink, which is a
   colour nobody made. */
(function (root) {
  "use strict";

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  /* One colour, one name.

     Judged on CHROMA — how far apart the channels are, in plain 0..255 — and
     not on HSL saturation. Saturation is a ratio that blows up where it
     matters most: #fcfcfa is eight units of spread and reads as 25% saturated,
     so every off-white was leaving the neutral branch and coming back "Beige".
     Measured on the fixtures, that one substitution fixed the whole pale end.

     Neutrals are decided first, because most of a wardrobe is neutral, and a
     very dark blue is Navy while a very dark anything else is Black — which is
     how the trade names them. */
  function familyOf(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;                       // 0..255
    const [h] = rgbToHsl(r, g, b);
    const l = (mx + mn) / 510;                    // 0..1

    if (chroma <= 12) {
      if (l >= 0.88) return "White";
      if (l >= 0.62) return "Light grey";
      if (l >= 0.22) return "Grey";
      return "Black";
    }
    if (l <= 0.12) return "Black";
    if (l <= 0.22) return (h >= 195 && h < 265) ? "Navy" : "Black";

    if (h < 15 || h >= 345) return l >= 0.74 ? "Pink" : "Red";
    if (h < 45) {
      // the warm quarter, where a wardrobe keeps most of its neutrals
      if (l <= 0.45) return "Brown";
      if (chroma <= 60) return l >= 0.82 ? "Cream" : "Beige";
      return l >= 0.70 ? "Peach" : "Orange";
    }
    if (h < 70) return chroma <= 60 ? "Beige" : "Yellow";
    if (h < 165) return "Green";
    if (h < 195) return "Teal";
    if (h < 265) return l <= 0.38 ? "Navy" : "Blue";
    if (h < 300) return "Purple";
    return l >= 0.62 ? "Pink" : "Magenta";
  }

  /* Is this pixel in the skin band? A bounded warm range — but the band also
     covers beige, camel and tan, which are half a wardrobe. Measured: a beige
     dress on a model came back as nothing at all, because every pixel of it
     was thrown away as an arm.

     So the band alone never decides. It only nominates; what convicts is
     appearing OUTSIDE the garment as well (see skinTones). A model's arms and
     neck are in the outer ring of the frame and the garment is not, so a warm
     tone found in both places is a person and a warm tone found only in the
     middle is the clothes. */
  function inSkinBand(r, g, b) {
    const [h, s, l] = rgbToHsl(r, g, b);
    return h >= 6 && h <= 42 && s >= 0.12 && s <= 0.62 &&
      l >= 0.32 && l <= 0.86 && r > g && g > b;
  }

  const near = (a, b, tol) =>
    Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

  /* px: RGBA bytes (canvas getImageData), w×h. Returns
       { family, rgb:[r,g,b], share, counted }  or null when there is nothing
     to say — which is a real answer and better than a colour we invented. */
  function readSwatch(px, w, h, opts) {
    opts = opts || {};
    const tol = opts.backdropTol == null ? 26 : opts.backdropTol;
    const at = (x, y) => {
      const i = ((y * w) + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    // the backdrop is what the corners agree on, measured from this image
    const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)]
      .filter(c => c[3] > 20);
    let backdrop = null;
    for (const c of corners) {
      const agree = corners.filter(o => near(o, c, tol)).length;
      if (agree >= 3) { backdrop = c; break; }
    }

    /* The middle of the frame. Product photography puts the garment there;
       the outer band is backdrop, props and the model's limbs. */
    const x0 = Math.floor(w * 0.28), x1 = Math.ceil(w * 0.72);
    const y0 = Math.floor(h * 0.22), y1 = Math.ceil(h * 0.78);

    /* Which warm tones belong to the person. Collected from the ring OUTSIDE
       the garment: whatever is warm out there is an arm, a neck or a leg, and
       the same tone in the middle is the same person. A beige coat is warm in
       the middle and nowhere else, so it survives. */
    const skinTones = [];
    const noteSkin = p => {
      if (!inSkinBand(p[0], p[1], p[2])) return;
      if (backdrop && near(p, backdrop, tol)) return;
      if (skinTones.some(t => near(t, p, 18))) return;
      if (skinTones.length < 6) skinTones.push(p);
    };
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;   // that is the garment
        const p = at(x, y);
        if (p[3] >= 128) noteSkin(p);
      }
    }
    /* Tight, because skin and sand sit almost on top of each other: measured,
       a beige dress at (214,196,166) is eighteen units from the model's arm at
       (232,190,160), and at a loose tolerance the dress was being erased as an
       arm. Twelve keeps them apart. Several tones are collected rather than
       one, which is what covers the range a real arm spans across a photo.

       The limit is real and worth writing down: a garment the exact colour of
       the model's skin cannot be told from the model. It returns null there
       rather than naming the wrong thing. */
    const isPerson = p => skinTones.some(t => near(t, p, 12));
    const buckets = new Map();
    let counted = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = at(x, y);
        if (p[3] < 128) continue;                       // transparent
        if (backdrop && near(p, backdrop, tol)) continue;
        if (isPerson(p)) continue;
        const fam = familyOf(p[0], p[1], p[2]);
        let b = buckets.get(fam);
        if (!b) { b = { n: 0, r: 0, g: 0, bl: 0 }; buckets.set(fam, b); }
        b.n++; b.r += p[0]; b.g += p[1]; b.bl += p[2];
        counted++;
      }
    }
    /* A garment the same colour as its backdrop is exactly what the backdrop
       filter removes — white on white is the commonest product shot there is.
       When almost nothing survives, the middle of the frame IS the backdrop
       colour, so read it again without that filter rather than declining. */
    const centre = (x1 - x0) * (y1 - y0);
    if (counted < centre * 0.06) {
      buckets.clear(); counted = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = at(x, y);
          if (p[3] < 128) continue;
          if (isPerson(p)) continue;
          const fam = familyOf(p[0], p[1], p[2]);
          let bb = buckets.get(fam);
          if (!bb) { bb = { n: 0, r: 0, g: 0, bl: 0 }; buckets.set(fam, bb); }
          bb.n++; bb.r += p[0]; bb.g += p[1]; bb.bl += p[2];
          counted++;
        }
      }
    }
    if (!counted) return null;

    let best = null, bestName = "";
    buckets.forEach((b, name) => { if (!best || b.n > best.n) { best = b; bestName = name; } });
    /* One colour has to actually hold the frame. Below this the picture is
       several things at once — a flat lay, a campaign shot — and naming one of
       them would be a guess. */
    const share = best.n / counted;
    if (share < 0.25) return null;
    return {
      family: bestName,
      rgb: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.bl / best.n)],
      share, counted,
    };
  }

  const hex = rgb => "#" + rgb.map(v =>
    Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");

  /* …and onto the shelf the LAB counts on.

     familyOf reads a pixel as finely as a pixel can be read — Navy is not
     Blue, Cream is not White — and that is worth keeping where a swatch is
     shown. But the axis has twelve names, the ones a shop's own colour filter
     offers, and a colour read from a photograph has to land in the same twelve
     as a colour read from a colourway word, or the same garment counts twice
     under two spellings of one colour. One vocabulary, two ways in. */
  const SHELF = {
    White: "White", Cream: "White",
    "Light grey": "Grey", Grey: "Grey",
    Black: "Black",
    Navy: "Blue", Blue: "Blue", Teal: "Blue",
    Beige: "Beige", Brown: "Brown",
    Peach: "Orange", Orange: "Orange",
    Yellow: "Yellow", Green: "Green",
    Pink: "Pink", Magenta: "Pink", Purple: "Purple", Red: "Red",
  };
  const shelfOf = name => SHELF[name] || "";

  const API = { familyOf, shelfOf, SHELF, readSwatch, inSkinBand, rgbToHsl, hex };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.LensColour = API;
})(typeof self !== "undefined" ? self : this);
