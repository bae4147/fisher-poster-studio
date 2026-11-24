/* Simple 16 x 16 pixel character, assembled from a few traits read from a photo.
   Same style as the default figure; the mouth keeps class "mouth" so it can animate.
   Traits: skin, hair_color, hair_style, hair_volume, hair_part, face_shape, eyebrows, smile,
           glasses, facial_hair, top, top_color, tie_color. Missing traits fall back to defaults. */
(function () {
  const HEX = /^#[0-9a-f]{6}$/i;
  const col = (v, d) => HEX.test(v || "") ? v : d;
  const mix = (a, b, t) => "#" + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("");
  const r = (x, y, w, h, f, cls) => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
  const INK = "#14242a", WHITE = "#f4ecd6", LIP = "#6b2e2e", BLUSH = "#e07a6a";

  function spriteSVG(t) {
    t = t || {};
    const skin = col(t.skin, "#c98f62"), hair = col(t.hair_color, "#2b2b2b"), top = col(t.top_color, "#2e4a7a"), tie = col(t.tie_color, "#c2410c");
    const shade = mix(skin, INK, .18), brow = mix(hair, INK, .35);
    const style = t.hair_style || "short", vol = t.hair_volume || "normal", part = t.hair_part || "none", shape = t.face_shape || "oval";
    const longHair = style === "long" || style === "medium";
    let s = "";

    /* hair behind the head */
    if (style === "long") s += r(3, 3, 1, 9, hair) + r(12, 3, 1, 9, hair);
    if (style === "medium") s += r(3, 3, 1, 6, hair) + r(12, 3, 1, 6, hair);
    if (style === "curly") s += r(2, 3, 1, 4, hair) + r(13, 3, 1, 4, hair);

    /* ears and face */
    if (shape !== "round" && !longHair) s += r(3, 6, 1, 2, shade) + r(12, 6, 1, 2, shade);
    if (shape === "round") s += r(4, 4, 8, 6, skin) + r(3, 6, 1, 3, skin) + r(12, 6, 1, 3, skin) + r(5, 10, 6, 1, skin);
    else if (shape === "long") s += r(4, 4, 8, 7, skin) + r(5, 11, 6, 1, skin);
    else if (shape === "square") s += r(4, 4, 8, 7, skin) + r(4, 10, 8, 1, shade);
    else s += r(4, 4, 8, 6, skin) + r(5, 10, 6, 1, skin);                                    // oval
    if (shape !== "long") s += r(6, 11, 4, 1, shade);                                          // neck

    /* facial hair under the features */
    if (t.facial_hair === "stubble") s += r(5, 9, 6, 2, mix(skin, hair, .3));
    if (t.facial_hair === "beard") s += r(4, 8, 1, 2, hair) + r(11, 8, 1, 2, hair) + r(4, 10, 8, 1, hair) + r(5, 11, 6, 1, hair) + r(5, 9, 1, 1, hair) + r(10, 9, 1, 1, hair);

    /* hair on top */
    const topRow = vol === "flat" || style === "buzz" ? 3 : 2;
    if (style === "bald") s += r(3, 5, 1, 2, hair) + r(12, 5, 1, 2, hair);
    else if (style === "buzz") s += r(4, 3, 8, 1, hair);
    else {
      if (style === "curly") s += r(3, 1, 10, 3, hair) + r(4, 0, 2, 1, hair) + r(7, 0, 2, 1, hair) + r(10, 0, 2, 1, hair);
      else s += r(4, topRow, 8, 4 - topRow, hair) + r(3, 3, 1, 2, hair) + r(12, 3, 1, 2, hair);
      if (vol === "tall" && style !== "curly") s += part === "right" ? r(5, 1, 6, 1, hair) + r(5, 0, 3, 1, hair) : r(5, 1, 6, 1, hair) + r(8, 0, 3, 1, hair);
      if (style === "bun") s += r(6, 0, 4, 2, hair);
      if (style === "spiky") s += r(4, 1, 1, 1, hair) + r(6, 1, 1, 1, hair) + r(9, 1, 1, 1, hair) + r(11, 1, 1, 1, hair);
      /* fringe */
      if (style === "bangs") s += r(4, 4, 8, 1, hair) + r(4, 5, 1, 1, hair) + r(11, 5, 1, 1, hair);
      else if (part === "left") s += r(4, 4, 4, 1, hair) + r(4, 5, 1, 1, hair);
      else if (part === "right") s += r(8, 4, 4, 1, hair) + r(11, 5, 1, 1, hair);
      else if (part === "center") s += r(4, 4, 3, 1, hair) + r(9, 4, 3, 1, hair);
      if (longHair) s += r(3, 3, 1, 1, hair) + r(12, 3, 1, 1, hair);
    }

    /* eyebrows, eyes, nose */
    if (t.eyebrows === "thick") s += r(5, 5, 2, 1, brow) + r(9, 5, 2, 1, brow);
    else if (part !== "left" && part !== "right" && style !== "bangs") s += r(5, 5, 2, 1, mix(skin, brow, .6)) + r(9, 5, 2, 1, mix(skin, brow, .6));
    const big = t.smile === "big";
    if (t.glasses === "clear" || t.glasses === "dark") {
      const lens = t.glasses === "dark" ? INK : "#9fd8ff";
      s += r(5, 6, 2, 2, INK) + r(9, 6, 2, 2, INK) + r(7, 6, 2, 1, INK) + r(5, 6, 1, 1, lens) + r(9, 6, 1, 1, lens);
    } else if (big) s += r(5, 7, 2, 1, INK) + r(9, 7, 2, 1, INK);                               // smiling eyes
    else s += r(6, 6, 1, 2, INK) + r(9, 6, 1, 2, INK);
    s += r(7, 8, 1, 1, shade);
    if (t.facial_hair === "mustache") s += r(6, 8, 4, 1, hair);

    /* mouth */
    if (big) s += r(5, 8, 1, 1, BLUSH) + r(10, 8, 1, 1, BLUSH) + r(6, 9, 4, 1, LIP, "mouth") + r(6, 9, 4, 1, WHITE) + r(7, 10, 2, 1, LIP);
    else if (t.smile === "slight") s += r(6, 9, 4, 1, LIP, "mouth") + r(5, 8, 1, 1, mix(skin, LIP, .35)) + r(10, 8, 1, 1, mix(skin, LIP, .35));
    else s += r(7, 9, 2, 1, t.facial_hair === "beard" ? mix(hair, LIP, .6) : LIP, "mouth");

    /* clothes */
    s += r(2, 12, 12, 4, top);
    switch (t.top) {
      case "suit_tie": s += r(6, 12, 1, 2, WHITE) + r(9, 12, 1, 2, WHITE) + r(7, 12, 2, 4, tie) + r(5, 12, 1, 3, mix(top, INK, .35)) + r(10, 12, 1, 3, mix(top, INK, .35)); break;
      case "suit":     s += r(6, 12, 4, 1, WHITE) + r(7, 13, 2, 3, WHITE) + r(5, 12, 1, 3, mix(top, INK, .35)) + r(10, 12, 1, 3, mix(top, INK, .35)); break;
      case "sweater":  s += r(6, 12, 4, 1, mix(top, INK, .3)) + r(2, 15, 12, 1, mix(top, INK, .2)); break;
      case "blouse":   s += r(6, 12, 4, 1, skin) + r(7, 13, 2, 1, skin); break;
      case "tshirt":   s += r(7, 12, 2, 1, skin); break;
      default:         s += r(6, 12, 1, 1, mix(top, WHITE, .5)) + r(9, 12, 1, 1, mix(top, WHITE, .5)) + r(7, 13, 1, 3, mix(top, INK, .25));   // shirt
    }
    return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
  }

  window.spriteSVG = spriteSVG;
})();
