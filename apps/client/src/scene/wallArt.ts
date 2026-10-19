/**
 * The artwork on the office's walls, painted onto canvases at startup.
 *
 * Every picture is drawn here in code rather than shipped as an image: the
 * office's own little people with the green diamond floating over their heads,
 * a skyline, some posters. Nothing is copied from anywhere, nothing has to be
 * downloaded, and a picture is as sharp as the canvas it is painted on.
 *
 * Each painter draws into whatever size it is given, so one artwork can hang
 * in frames of different shapes. Randomness — lit windows, scribbles — comes
 * from a seeded generator, so a picture is the same on every client.
 */

import type { WallArt } from "@sim/shared";

type Ctx = CanvasRenderingContext2D;

const FONT_STACK = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

/** The diamond's two faces, lit and shaded. */
const PLUMBOB_LIGHT = "#7ee36a";
const PLUMBOB_DARK = "#2f9e3a";
const PLUMBOB_EDGE = "#1d6b27";

/** A small deterministic generator, so every client paints the same picture. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function verticalGradient(ctx: Ctx, h: number, stops: readonly string[]): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach((colour, index) => gradient.addColorStop(index / Math.max(1, stops.length - 1), colour));
  return gradient;
}

/** The floating diamond, centred on (x, y), `size` tall. */
export function paintPlumbob(ctx: Ctx, x: number, y: number, size: number): void {
  const half = size / 2;
  const width = size * 0.34;
  const waist = y - size * 0.12;
  ctx.save();
  ctx.shadowColor = "rgba(126, 227, 106, 0.7)";
  ctx.shadowBlur = size * 0.25;
  // The left faces lit, the right shaded, which is all it takes to read as a gem.
  ctx.fillStyle = PLUMBOB_LIGHT;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x - width, waist);
  ctx.lineTo(x, y + half);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = PLUMBOB_DARK;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + width, waist);
  ctx.lineTo(x, y + half);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = PLUMBOB_EDGE;
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x - width, waist);
  ctx.lineTo(x, y + half);
  ctx.lineTo(x + width, waist);
  ctx.closePath();
  ctx.moveTo(x - width, waist);
  ctx.lineTo(x + width, waist);
  ctx.stroke();
  ctx.restore();
}

interface SimLook {
  readonly skin: string;
  readonly hair: string;
  readonly shirt: string;
}

const SIM_LOOKS: readonly SimLook[] = [
  { skin: "#f2c9a0", hair: "#5a3a22", shirt: "#3f7fd1" },
  { skin: "#c68a5a", hair: "#1f1a17", shirt: "#e0574f" },
  { skin: "#8d5a3b", hair: "#20140e", shirt: "#f2b33d" },
  { skin: "#f6d7b8", hair: "#d9a441", shirt: "#7a5cc7" },
  { skin: "#e3b38a", hair: "#a3442a", shirt: "#3aa889" },
];

/**
 * One of the office's people, head and shoulders, with the diamond over its
 * head. `(x, y)` is the centre of the head and `r` its radius.
 */
function paintSim(ctx: Ctx, x: number, y: number, r: number, look: SimLook, smile = true): void {
  // Shoulders.
  ctx.fillStyle = look.shirt;
  ctx.beginPath();
  ctx.ellipse(x, y + r * 2.15, r * 1.55, r * 1.15, 0, Math.PI, 0);
  ctx.lineTo(x + r * 1.55, y + r * 2.6);
  ctx.lineTo(x - r * 1.55, y + r * 2.6);
  ctx.closePath();
  ctx.fill();
  // Neck and head.
  ctx.fillStyle = look.skin;
  ctx.fillRect(x - r * 0.3, y + r * 0.7, r * 0.6, r * 0.6);
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.85, r, 0, 0, Math.PI * 2);
  ctx.fill();
  // Hair, a cap over the top of the head.
  ctx.fillStyle = look.hair;
  ctx.beginPath();
  ctx.ellipse(x, y - r * 0.25, r * 0.92, r * 0.85, 0, Math.PI * 1.02, Math.PI * 1.98);
  ctx.closePath();
  ctx.fill();
  // Eyes and a smile.
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y + r * 0.05, r * 0.09, 0, Math.PI * 2);
  ctx.arc(x + r * 0.32, y + r * 0.05, r * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#7a3b2e";
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath();
  if (smile) {
    ctx.arc(x, y + r * 0.3, r * 0.3, Math.PI * 0.15, Math.PI * 0.85);
  } else {
    ctx.moveTo(x - r * 0.2, y + r * 0.5);
    ctx.lineTo(x + r * 0.2, y + r * 0.5);
  }
  ctx.stroke();
  paintPlumbob(ctx, x, y - r * 1.75, r * 0.9);
}

function centredText(ctx: Ctx, text: string, x: number, y: number, size: number, colour: string, weight = 800): void {
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y, ctx.canvas.width * 0.9);
}

function paintSimPortrait(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#ffe7c2", "#f7b6a8"]);
  ctx.fillRect(0, 0, w, h);
  paintSim(ctx, w / 2, h * 0.5, Math.min(w, h) * 0.2, SIM_LOOKS[0] ?? { skin: "#f2c9a0", hair: "#333", shirt: "#36c" });
}

function paintSimsTeam(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#8fd3ff", "#d7f1ff"]);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#6cbf55";
  ctx.fillRect(0, h * 0.82, w, h * 0.18);
  const count = 4;
  const r = Math.min(w / (count * 3.4), h * 0.13);
  for (let index = 0; index < count; index += 1) {
    const look = SIM_LOOKS[index % SIM_LOOKS.length] ?? SIM_LOOKS[0];
    if (look !== undefined) {
      paintSim(ctx, (w * (index + 0.5)) / count, h * 0.52 + (index % 2) * r * 0.25, r, look);
    }
  }
}

function paintEmployeeOfMonth(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#1f3a5f";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#e7c65a";
  ctx.lineWidth = w * 0.03;
  ctx.strokeRect(w * 0.04, w * 0.04, w * 0.92, h - w * 0.08);
  centredText(ctx, "EMPLOYEE", w / 2, h * 0.12, h * 0.075, "#e7c65a");
  centredText(ctx, "OF THE MONTH", w / 2, h * 0.2, h * 0.055, "#e7c65a", 700);
  ctx.fillStyle = "#cfe3f5";
  ctx.fillRect(w * 0.18, h * 0.28, w * 0.64, h * 0.58);
  const look = SIM_LOOKS[2];
  if (look !== undefined) {
    paintSim(ctx, w / 2, h * 0.6, Math.min(w * 0.13, h * 0.08), look);
  }
  centredText(ctx, "★ ★ ★", w / 2, h * 0.92, h * 0.05, "#e7c65a");
}

function paintPlumbobArt(ctx: Ctx, w: number, h: number): void {
  const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  glow.addColorStop(0, "#1f6f78");
  glow.addColorStop(1, "#0b1e2d");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  const random = seeded(7);
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  for (let index = 0; index < 40; index += 1) {
    const size = 1 + random() * 3;
    ctx.fillRect(random() * w, random() * h, size, size);
  }
  paintPlumbob(ctx, w / 2, h / 2, Math.min(w * 1.3, h) * 0.7);
}

function paintCityscape(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#2b1d4a", "#c4527a", "#f6a65a"]);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ffe08a";
  ctx.beginPath();
  ctx.arc(w * 0.7, h * 0.62, h * 0.12, 0, Math.PI * 2);
  ctx.fill();
  const random = seeded(31);
  let x = 0;
  while (x < w) {
    const width = w * (0.05 + random() * 0.08);
    const top = h * (0.25 + random() * 0.45);
    ctx.fillStyle = random() > 0.5 ? "#1a1430" : "#241a3d";
    ctx.fillRect(x, top, width, h - top);
    // A spire on some of the tall ones.
    if (top < h * 0.4 && random() > 0.5) {
      ctx.fillRect(x + width * 0.45, top - h * 0.08, width * 0.1, h * 0.08);
    }
    ctx.fillStyle = "#ffd36b";
    for (let wy = top + h * 0.03; wy < h - h * 0.03; wy += h * 0.045) {
      for (let wx = x + width * 0.15; wx < x + width * 0.85; wx += width * 0.22) {
        if (random() > 0.55) {
          ctx.fillRect(wx, wy, width * 0.1, h * 0.02);
        }
      }
    }
    x += width + w * 0.005;
  }
}

function paintLandscape(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#7cc6f2", "#e8f6ff"]);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff3b0";
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.25, h * 0.1, 0, Math.PI * 2);
  ctx.fill();
  const hills: readonly [string, number, number][] = [
    ["#8fcf6a", 0.62, 0.3],
    ["#5fae4a", 0.75, 0.55],
    ["#3e8a3a", 0.88, 0.2],
  ];
  for (const [colour, level, phase] of hills) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 24) {
      ctx.lineTo(x, h * level - Math.sin((x / w) * Math.PI * 2 + phase * 6) * h * 0.06);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
  // A tree on the near hill.
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(w * 0.22, h * 0.62, w * 0.02, h * 0.16);
  ctx.fillStyle = "#2f7a33";
  ctx.beginPath();
  ctx.arc(w * 0.23, h * 0.58, h * 0.09, 0, Math.PI * 2);
  ctx.fill();
}

function paintAbstract(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#f4efe6";
  ctx.fillRect(0, 0, w, h);
  const random = seeded(101);
  const colours = ["#e94f37", "#f6c90e", "#3f88c5", "#44bba4", "#393e41"];
  for (let index = 0; index < 9; index += 1) {
    ctx.fillStyle = colours[index % colours.length] ?? "#333";
    const x = random() * w;
    const y = random() * h;
    const size = Math.min(w, h) * (0.12 + random() * 0.25);
    ctx.beginPath();
    switch (index % 3) {
      case 0:
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        break;
      case 1:
        ctx.rect(x - size / 2, y - size / 3, size, size / 1.5);
        break;
      default:
        ctx.moveTo(x, y - size / 2);
        ctx.lineTo(x + size / 2, y + size / 2);
        ctx.lineTo(x - size / 2, y + size / 2);
        ctx.closePath();
    }
    ctx.fill();
  }
  ctx.strokeStyle = "#393e41";
  ctx.lineWidth = Math.min(w, h) * 0.015;
  ctx.beginPath();
  ctx.moveTo(w * 0.05, h * 0.8);
  ctx.bezierCurveTo(w * 0.3, h * 0.2, w * 0.6, h * 1.1, w * 0.95, h * 0.3);
  ctx.stroke();
}

function paintPosterShipIt(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#14213d", "#283b6e"]);
  ctx.fillRect(0, 0, w, h);
  // A rocket, nose up, with its flame.
  const cx = w / 2;
  const top = h * 0.12;
  const body = h * 0.4;
  const half = w * 0.11;
  ctx.fillStyle = "#f77f00";
  ctx.beginPath();
  ctx.moveTo(cx - half * 0.7, top + body);
  ctx.lineTo(cx, top + body + h * 0.12);
  ctx.lineTo(cx + half * 0.7, top + body);
  ctx.fill();
  ctx.fillStyle = "#e5e5e5";
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.quadraticCurveTo(cx + half * 1.4, top + body * 0.35, cx + half, top + body);
  ctx.lineTo(cx - half, top + body);
  ctx.quadraticCurveTo(cx - half * 1.4, top + body * 0.35, cx, top);
  ctx.fill();
  ctx.fillStyle = "#d62828";
  ctx.beginPath();
  ctx.moveTo(cx - half, top + body * 0.7);
  ctx.lineTo(cx - half * 1.8, top + body);
  ctx.lineTo(cx - half, top + body);
  ctx.moveTo(cx + half, top + body * 0.7);
  ctx.lineTo(cx + half * 1.8, top + body);
  ctx.lineTo(cx + half, top + body);
  ctx.fill();
  ctx.fillStyle = "#4cc9f0";
  ctx.beginPath();
  ctx.arc(cx, top + body * 0.42, half * 0.45, 0, Math.PI * 2);
  ctx.fill();
  centredText(ctx, "SHIP IT", w / 2, h * 0.76, h * 0.11, "#fcbf49");
  centredText(ctx, "Done beats perfect", w / 2, h * 0.88, h * 0.045, "#e5e5e5", 600);
}

function paintPosterTeamwork(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#f4a259";
  ctx.fillRect(0, 0, w, h);
  const r = w * 0.09;
  for (let index = 0; index < 3; index += 1) {
    const look = SIM_LOOKS[(index + 1) % SIM_LOOKS.length];
    if (look !== undefined) {
      paintSim(ctx, w * (0.25 + index * 0.25), h * 0.38, r, look);
    }
  }
  centredText(ctx, "TEAMWORK", w / 2, h * 0.74, h * 0.09, "#2d1e2f");
  centredText(ctx, "makes the dream work", w / 2, h * 0.85, h * 0.045, "#2d1e2f", 600);
}

function paintPosterCoffee(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#f3e9dc";
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h * 0.4;
  const cup = w * 0.28;
  ctx.fillStyle = "#5e3023";
  ctx.beginPath();
  ctx.moveTo(cx - cup, cy - cup * 0.6);
  ctx.lineTo(cx + cup, cy - cup * 0.6);
  ctx.lineTo(cx + cup * 0.75, cy + cup * 0.8);
  ctx.lineTo(cx - cup * 0.75, cy + cup * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#5e3023";
  ctx.lineWidth = cup * 0.14;
  ctx.beginPath();
  ctx.arc(cx + cup * 0.95, cy, cup * 0.32, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  // Steam.
  ctx.strokeStyle = "#a47551";
  ctx.lineWidth = cup * 0.08;
  for (const offset of [-0.4, 0, 0.4]) {
    ctx.beginPath();
    ctx.moveTo(cx + cup * offset, cy - cup * 0.75);
    ctx.bezierCurveTo(
      cx + cup * (offset + 0.25),
      cy - cup * 1.0,
      cx + cup * (offset - 0.25),
      cy - cup * 1.2,
      cx + cup * offset,
      cy - cup * 1.45,
    );
    ctx.stroke();
  }
  centredText(ctx, "BUT FIRST,", w / 2, h * 0.72, h * 0.07, "#5e3023");
  centredText(ctx, "COFFEE", w / 2, h * 0.83, h * 0.1, "#895737");
}

function paintCertificate(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#fbf6e6";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#b08d3c";
  ctx.lineWidth = Math.min(w, h) * 0.025;
  ctx.strokeRect(w * 0.05, h * 0.06, w * 0.9, h * 0.88);
  ctx.lineWidth = Math.min(w, h) * 0.008;
  ctx.strokeRect(w * 0.08, h * 0.1, w * 0.84, h * 0.8);
  centredText(ctx, "CERTIFICATE", w / 2, h * 0.24, h * 0.11, "#3b2f1b", 800);
  centredText(ctx, "of Excellence in Shipping", w / 2, h * 0.37, h * 0.06, "#6b5a3a", 600);
  ctx.fillStyle = "#c9b98f";
  for (const y of [0.52, 0.6, 0.68]) {
    ctx.fillRect(w * 0.2, h * y, w * 0.6, h * 0.018);
  }
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.76, h * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e7c65a";
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.76, h * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

function paintOfficeSign(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#1b1f27";
  ctx.fillRect(0, 0, w, h);
  paintPlumbob(ctx, h * 0.55, h / 2, h * 0.7);
  ctx.fillStyle = "#f2f2f2";
  ctx.font = `800 ${h * 0.42}px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("AGENT OFFICE", h * 1.05, h * 0.53, w - h * 1.2);
}

const PAINTERS: Readonly<Record<WallArt, (ctx: Ctx, w: number, h: number) => void>> = {
  simPortrait: paintSimPortrait,
  simsTeam: paintSimsTeam,
  employeeOfMonth: paintEmployeeOfMonth,
  plumbob: paintPlumbobArt,
  cityscape: paintCityscape,
  landscape: paintLandscape,
  abstract: paintAbstract,
  posterShipIt: paintPosterShipIt,
  posterTeamwork: paintPosterTeamwork,
  posterCoffee: paintPosterCoffee,
  certificate: paintCertificate,
  officeSign: paintOfficeSign,
};

/** Paints `art` over the whole of a `w` by `h` canvas. */
export function paintArt(ctx: Ctx, art: WallArt, w: number, h: number): void {
  PAINTERS[art](ctx, w, h);
}

/** A whiteboard with the last meeting still on it. */
export function paintWhiteboard(ctx: Ctx, w: number, h: number, seed: number): void {
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, w, h);
  const random = seeded(seed);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `700 ${h * 0.09}px ${FONT_STACK}`;
  ctx.fillStyle = "#1d4ed8";
  ctx.fillText(seed % 2 === 0 ? "SPRINT GOALS" : "STANDUP", w * 0.05, h * 0.06);
  // Bullet lines of illegible handwriting.
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = h * 0.012;
  for (let line = 0; line < 4; line += 1) {
    const y = h * (0.28 + line * 0.13);
    ctx.beginPath();
    ctx.arc(w * 0.07, y, h * 0.012, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w * 0.1, y);
    const end = w * (0.3 + random() * 0.2);
    for (let x = w * 0.1; x < end; x += w * 0.015) {
      ctx.lineTo(x, y + (random() - 0.5) * h * 0.04);
    }
    ctx.stroke();
  }
  // A box-and-arrow diagram.
  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = h * 0.015;
  ctx.strokeRect(w * 0.6, h * 0.2, w * 0.14, h * 0.18);
  ctx.strokeRect(w * 0.8, h * 0.55, w * 0.14, h * 0.18);
  ctx.beginPath();
  ctx.moveTo(w * 0.74, h * 0.32);
  ctx.lineTo(w * 0.86, h * 0.55);
  ctx.lineTo(w * 0.85, h * 0.49);
  ctx.moveTo(w * 0.86, h * 0.55);
  ctx.lineTo(w * 0.81, h * 0.52);
  ctx.stroke();
  // Sticky notes.
  const notes = ["#fde68a", "#a7f3d0", "#fbcfe8"];
  notes.forEach((colour, index) => {
    ctx.fillStyle = colour;
    ctx.fillRect(w * (0.58 + index * 0.08), h * 0.74, w * 0.065, h * 0.17);
  });
  paintPlumbob(ctx, w * 0.5, h * 0.2, h * 0.2);
}

/** The conference room's slide: a roadmap and a chart going the right way. */
export function paintTvSlide(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = verticalGradient(ctx, h, ["#0f172a", "#1e293b"]);
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#f8fafc";
  ctx.font = `800 ${h * 0.1}px ${FONT_STACK}`;
  ctx.fillText("Q4 Roadmap", w * 0.05, h * 0.07);
  ctx.fillStyle = "#94a3b8";
  ctx.font = `500 ${h * 0.05}px ${FONT_STACK}`;
  ctx.fillText("Issues closed per week", w * 0.05, h * 0.2);
  const bars = [0.25, 0.35, 0.3, 0.5, 0.62, 0.78];
  const base = h * 0.88;
  const left = w * 0.06;
  const span = w * 0.5;
  bars.forEach((value, index) => {
    ctx.fillStyle = index === bars.length - 1 ? "#7ee36a" : "#38bdf8";
    const bw = span / bars.length;
    ctx.fillRect(left + index * bw + bw * 0.15, base - value * h * 0.55, bw * 0.7, value * h * 0.55);
  });
  ctx.fillStyle = "#475569";
  ctx.fillRect(left, base, span, h * 0.008);
  const items = ["✓ Lobby & lifts", "✓ Standups", "• Wall decor", "• Sticker boards"];
  ctx.font = `600 ${h * 0.065}px ${FONT_STACK}`;
  items.forEach((item, index) => {
    ctx.fillStyle = item.startsWith("✓") ? "#7ee36a" : "#e2e8f0";
    ctx.fillText(item, w * 0.63, h * (0.32 + index * 0.13));
  });
  paintPlumbob(ctx, w * 0.93, h * 0.12, h * 0.13);
}

/** A clock face: twelve marks round a white dial. */
export function paintClockFace(ctx: Ctx, size: number): void {
  const centre = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#fdfdfb";
  ctx.beginPath();
  ctx.arc(centre, centre, centre, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#222";
  for (let mark = 0; mark < 12; mark += 1) {
    const angle = (mark / 12) * Math.PI * 2;
    const long = mark % 3 === 0;
    ctx.lineWidth = size * (long ? 0.035 : 0.018);
    ctx.beginPath();
    ctx.moveTo(centre + Math.sin(angle) * centre * (long ? 0.72 : 0.8), centre - Math.cos(angle) * centre * (long ? 0.72 : 0.8));
    ctx.lineTo(centre + Math.sin(angle) * centre * 0.9, centre - Math.cos(angle) * centre * 0.9);
    ctx.stroke();
  }
}
