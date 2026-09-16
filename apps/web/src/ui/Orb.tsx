/**
 * Port of MuralOrb (Design.swift): a twelve-point blob masked over a warm mesh-like gradient,
 * with a highlight, a butter ring, a feathered shadow and two floating dots. Canvas-drawn so it
 * animates smoothly at any size; energy comes straight from the transport's level meter.
 */
import { useEffect, useRef } from "react";

interface OrbProps {
  energy?: number;
  levels?: (listener: (input: number, output: number) => void) => () => void;
  listening?: boolean;
  active?: boolean;
  size?: number;
  className?: string;
}

const COLORS = { peach: "#ffe3cf", orange: "#ff8a4d" };

function blobPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: number, phase: number, energy: number) {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    const wave = Math.sin(a * 3 + phase) * 0.021 + Math.cos(a * 2 - phase * 0.7) * (0.012 + energy * 0.025);
    const radius = side * (0.47 + wave);
    points.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  ctx.beginPath();
  for (let i = 0; i < 12; i += 1) {
    const current = points[i]!, next = points[(i + 1) % 12]!;
    const mid: [number, number] = [(current[0] + next[0]) / 2, (current[1] + next[1]) / 2];
    if (i === 0) {
      const previous = points[11]!;
      ctx.moveTo((previous[0] + current[0]) / 2, (previous[1] + current[1]) / 2);
    }
    ctx.quadraticCurveTo(current[0], current[1], mid[0], mid[1]);
  }
  ctx.closePath();
}

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, energy: number, listening: boolean, reduceMotion: boolean) {
  ctx.clearRect(0, 0, width, height);
  const side = Math.min(width, height) * 0.86;
  const cx = width / 2;
  const phase = reduceMotion ? 0 : t * 0.72;
  const e = reduceMotion ? 0 : Math.min(1, Math.max(0, energy));
  const bob = reduceMotion ? 0 : Math.sin(t * 0.9) * 4 - 5;
  const cy = height / 2 + bob;

  // Ground shadow.
  ctx.save();
  ctx.filter = "blur(10px)";
  ctx.fillStyle = "rgba(255, 138, 77, 0.14)";
  ctx.beginPath();
  ctx.ellipse(cx, height / 2 + side * 0.47, side * 0.285, side * 0.0375, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Listening rings.
  if (listening) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 138, 77, 0.18)";
    ctx.beginPath(); ctx.arc(cx, height / 2, side / 2 + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255, 138, 77, 0.10)";
    ctx.beginPath(); ctx.arc(cx, height / 2, side / 2 + 16, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((Math.sin(phase * 0.5) * 3 * Math.PI) / 180);
  ctx.scale(1 + e * 0.045, 1 + e * 0.045);
  ctx.translate(-cx, -cy);
  ctx.shadowColor = "rgba(255, 138, 77, 0.12)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 10;
  blobPath(ctx, cx, cy, side, phase, e);
  ctx.fillStyle = COLORS.orange;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.clip();

  // Mesh approximation: warm base plus moving colour pools.
  const base = ctx.createLinearGradient(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2);
  base.addColorStop(0, "#fff8d1");
  base.addColorStop(0.35, "#ffb36b");
  base.addColorStop(0.62, COLORS.orange);
  base.addColorStop(1, "#f56b59");
  ctx.fillStyle = base;
  ctx.fillRect(cx - side, cy - side, side * 2, side * 2);

  const mx = cx + Math.sin(phase) * side * 0.08;
  const my = cy + Math.cos(phase) * side * 0.06;
  const pools: Array<[number, number, number, string]> = [
    [cx - side * 0.28, cy - side * 0.3, side * 0.55, "rgba(255, 244, 205, 0.95)"],
    [cx + side * 0.38, cy + side * 0.05, side * 0.42, "rgba(214, 186, 240, 0.62)"],
    [cx + side * 0.3, cy + side * 0.38, side * 0.4, "rgba(224, 200, 244, 0.6)"],
    [cx - side * 0.34, cy + side * 0.34, side * 0.42, "rgba(245, 107, 89, 0.7)"],
    [mx, my, side * 0.36, "rgba(255, 138, 77, 0.55)"],
  ];
  for (const [x, y, r, color] of pools) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255, 138, 77, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - side, cy - side, side * 2, side * 2);
  }

  // Highlight.
  ctx.save();
  ctx.filter = "blur(13px)";
  ctx.translate(cx - side * 0.17, cy - side * 0.28);
  ctx.rotate((-28 * Math.PI) / 180);
  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.beginPath(); ctx.ellipse(0, 0, side * 0.24, side * 0.075, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Butter ring near the bottom.
  ctx.save();
  ctx.filter = "blur(12px)";
  ctx.translate(cx, cy + side * 0.54);
  ctx.rotate((-15 * Math.PI) / 180);
  ctx.strokeStyle = "rgba(255, 241, 199, 0.48)";
  ctx.lineWidth = 16;
  ctx.beginPath(); ctx.ellipse(0, 0, side * 0.6, side * 0.25, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.restore();

  // Floating dots.
  const dot = ctx.createRadialGradient(cx + side * 0.55 - 4, height / 2 - side * 0.24 - 4, 0, cx + side * 0.55, height / 2 - side * 0.24, 6);
  dot.addColorStop(0, "#fff");
  dot.addColorStop(0.5, COLORS.peach);
  dot.addColorStop(1, "rgba(255, 138, 77, 0.5)");
  ctx.fillStyle = dot;
  ctx.beginPath(); ctx.arc(cx + side * 0.55, height / 2 - side * 0.24, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COLORS.peach;
  ctx.beginPath(); ctx.arc(cx - side * 0.54, height / 2 + side * 0.26, 3.5, 0, Math.PI * 2); ctx.fill();
}

export function Orb({ energy = 0, levels, listening = false, active = true, size, className }: OrbProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const state = useRef({ energy, listening, active });
  state.current.energy = energy;
  state.current.listening = listening;
  state.current.active = active;

  useEffect(() => {
    if (!levels) return;
    return levels((input, output) => { state.current.energy = Math.max(output, input * 0.45); });
  }, [levels]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = 0;
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (document.hidden) return;
      if (!state.current.active && now - last < 500) return;
      if (now - last < 1000 / 30) return;
      last = now;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, rect.width, rect.height, now / 1000, state.current.active ? state.current.energy : 0, state.current.listening, reduceMotion);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} className={className} style={size ? { width: size, height: size } : undefined} aria-hidden="true" />;
}
