/* Simple 16 x 16 pixel character, assembled from a few traits read from a photo.
   Same style and coordinates as the default figure; the mouth keeps class "mouth" so it can animate. */
(function () {
  const HEX = /^#[0-9a-f]{6}$/i;
  const col = (v, d) => HEX.test(v || "") ? v : d;
  const mix = (a, b, t) => "#" + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("");
  const r = (x, y, w, h, f, cls) => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
  const INK = "#14242a", WHITE = "#f4ecd6";

  const HAIR = {
    short:     [[4,2,8,2],[3,3,1,2],[12,3,1,2]],
    side_part: [[4,2,8,2],[3,3,1,3],[12,3,1,2],[4,4,3,1]],
    spiky:     [[4,2,8,2],[4,1,1,1],[6,1,1,1],[8,1,1,1],[10,1,1,1],[3,3,1,2],[12,3,1,2]],
    curly:     [[3,1,10,3],[3,4,1,3],[12,4,1,3]],
    medium:    [[4,2,8,2],[3,3,1,6],[12,3,1,6]],
    long:      [[4,2,8,2],[3,3,1,9],[12,3,1,9]],
    bun:       [[6,0,4,2],[4,2,8,2],[3,3,1,3],[12,3,1,3]],
    buzz:      [[4,3,8,1]],
    bald:      [[3,5,1,2],[12,5,1,2]]
  };

  function spriteSVG(t) {
    t = t || {};
    const skin = col(t.skin, "#c98f62"), hair = col(t.hair_color, "#2b2b2b"), top = col(t.top_color, "#2e4a7a"), tie = col(t.tie_color, "#c2410c");
    const style = HAIR[t.hair_style] ? t.hair_style : "short";
    let s = "";
    if (style === "long" || style === "medium") s += HAIR[style].slice(1).map(a => r(...a, hair)).join("");   // hair behind the face
    s += r(3, 6, 1, 2, mix(skin, INK, .15)) + r(12, 6, 1, 2, mix(skin, INK, .15));                          // ears
    s += r(4, 4, 8, 7, skin) + r(6, 11, 4, 1, mix(skin, INK, .2));                                          // face, neck
    if (t.facial_hair === "stubble") s += r(5, 9, 6, 2, mix(skin, hair, .3));
    if (t.facial_hair === "beard") s += r(4, 9, 8, 2, hair) + r(5, 11, 6, 1, hair);
    s += (style === "long" || style === "medium" ? HAIR[style].slice(0, 1) : HAIR[style]).map(a => r(...a, hair)).join("");
    if (t.glasses === "clear" || t.glasses === "dark") {
      const lens = t.glasses === "dark" ? INK : "#9fd8ff";
      s += r(5, 6, 2, 2, INK) + r(9, 6, 2, 2, INK) + r(7, 6, 2, 1, INK) + r(5, 6, 1, 1, lens) + r(9, 6, 1, 1, lens);
    } else {
      s += r(6, 6, 1, 2, INK) + r(9, 6, 1, 2, INK);
    }
    if (t.facial_hair === "mustache") s += r(6, 8, 4, 1, hair);
    s += r(7, 9, 2, 1, t.facial_hair === "beard" ? mix(hair, "#6b2e2e", .6) : "#6b2e2e", "mouth");
    s += r(2, 12, 12, 4, top);                                                                               // body
    switch (t.top) {
      case "suit_tie": s += r(6, 12, 1, 2, WHITE) + r(9, 12, 1, 2, WHITE) + r(7, 12, 2, 4, tie); break;
      case "suit":     s += r(7, 12, 2, 4, WHITE); break;
      case "sweater":  s += r(6, 12, 4, 1, mix(top, INK, .3)); break;
      case "blouse":
      case "tshirt":   s += r(7, 12, 2, 1, skin); break;
      default:         s += r(6, 12, 1, 1, mix(top, WHITE, .4)) + r(9, 12, 1, 1, mix(top, WHITE, .4));         // shirt collar
    }
    return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
  }

  window.spriteSVG = spriteSVG;
})();
