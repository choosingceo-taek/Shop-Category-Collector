/* Cotton On colour-source probe — paste this into DevTools Console on the SAME
   product page you already ran diagnose-pdp.js on. Size was found via
   aria-label="Size X, available" buttons; colour wasn't. This widens the
   search: any aria-label mentioning colour ANYWHERE (not just under a
   colour-classed ancestor), and sibling product links (other colour variants
   of this same item, since cottonon.com gives each colour its own PDP URL
   sharing the same slug). Read-only; copy the whole output back. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const cap = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 120);

  log("=== COLOUR SOURCE PROBE ===");
  log("URL:", location.href);

  // 1) ANY element whose aria-label mentions colour, wherever it sits
  const colourAria = [...document.querySelectorAll("[aria-label]")]
    .filter(el => /colou?r/i.test(el.getAttribute("aria-label") || ""))
    .slice(0, 20);
  log("\n[aria-label mentions colour]:", colourAria.length, "elements");
  colourAria.forEach(el => log(`  <${el.tagName.toLowerCase()} class="${cap(el.className, 50)}"> aria-label="${cap(el.getAttribute("aria-label"), 60)}"`));

  // 2) sibling PDP links: other colours of the SAME product share this slug
  const slug = location.pathname.split("/").filter(Boolean).slice(-2, -1)[0] || "";
  const siblings = [...document.querySelectorAll(`a[href*="/${slug}/"]`)].slice(0, 20);
  log(`\n[sibling links sharing slug "${slug}"]:`, siblings.length);
  siblings.forEach(a => {
    const img = a.querySelector("img");
    log(`  href="${cap(a.getAttribute("href"), 70)}" | aria-label="${cap(a.getAttribute("aria-label"), 40)}" | title="${cap(a.getAttribute("title"), 40)}" | img-alt="${cap(img && img.getAttribute("alt"), 40)}"`);
  });

  // 3) "Colour" as visible label text anywhere (e.g. a heading like "Colour: Black")
  const bodyText = document.body ? document.body.textContent : "";
  const colourLabel = bodyText.match(/colou?r\s*[:\-]?\s*[A-Za-z][A-Za-z .]{1,30}/i);
  log("\n[visible 'Colour: ...' text]:", colourLabel ? cap(colourLabel[0], 60) : "(not found)");

  // 4) any element with a title/data attribute naming a colour-ish word
  const colourWords = /black|white|navy|grey|gray|beige|cream|khaki|olive|pink|red|blue|green|brown|tan|denim|wash/i;
  const titled = [...document.querySelectorAll("[title]")]
    .filter(el => colourWords.test(el.getAttribute("title") || ""))
    .slice(0, 15);
  log("\n[title attrs matching a colour word]:", titled.length);
  titled.forEach(el => log(`  <${el.tagName.toLowerCase()}> title="${cap(el.getAttribute("title"), 40)}" href="${cap(el.getAttribute("href"), 60)}"`));

  // 5) Details/Composition tab — is it a lazy-load trigger?
  const detailsBtn = [...document.querySelectorAll("button, a, [role=tab]")]
    .find(el => /details|composition|fabric|materials/i.test(el.textContent || ""));
  log("\n[Details/Composition tab trigger]:", detailsBtn ? `<${detailsBtn.tagName.toLowerCase()}> "${cap(detailsBtn.textContent, 40)}"` : "(none found)");

  log("\n=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
