/* =============================================================================
 *  拾光花园 —— 背景樱花飘落 + 升级烟花（纯 Canvas，零依赖）
 *  · 背景层 #sakura (z-index 0)：粉色花瓣缓缓飘落
 *  · 前景层 #fxcanvas (z-index 20)：烟花，window.GardenFx.fireworks() 触发
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  function mkCanvas(z) {
    const c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '' + z });
    (document.body || document.documentElement).appendChild(c);
    return c;
  }
  const bg = mkCanvas(0), fxc = mkCanvas(20);
  const ctx = bg.getContext('2d'), fctx = fxc.getContext('2d');

  const COLORS = ['#ffd6e7', '#ffc2d6', '#ffb3c9', '#ffcfe0', '#ffdbe8'];
  const FX_COLORS = ['#ff7eae', '#ffd166', '#ffb3c9', '#a6db78', '#ff5e7e', '#ffe08a', '#9d7bff'];
  let W = 0, H = 0, petals = [], fx = [];

  function makePetal(spread) {
    const size = rand(7, 15);
    return {
      x: rand(0, W || window.innerWidth),
      y: spread ? rand(-H, H) : rand(-40, -10),
      size, vy: rand(0.25, 0.7) * (size / 11),
      swayAmp: rand(12, 34), swayPhase: rand(0, Math.PI * 2), swaySpeed: rand(0.006, 0.016),
      rot: rand(0, Math.PI * 2), rotSpeed: rand(-0.012, 0.012),
      color: COLORS[(Math.random() * COLORS.length) | 0], alpha: rand(0.45, 0.85),
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // 降分辨率省电（花瓣柔和，看不出差）
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [bg, fxc]) { c.width = W * dpr; c.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = reduce ? 0 : Math.min(16, Math.round((W * H) / 60000));  // 减少花瓣数量
    while (petals.length < target) petals.push(makePetal(true));
    if (petals.length > target) petals.length = target;
  }

  function drawPetal(p) {
    const s = p.size;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = p.alpha; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.moveTo(0, -s);
    ctx.bezierCurveTo(s * 0.62, -s * 0.55, s * 0.62, s * 0.55, 0, s);
    ctx.bezierCurveTo(-s * 0.62, s * 0.55, -s * 0.62, -s * 0.55, 0, -s);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = p.alpha * 0.35; ctx.strokeStyle = '#ff9ec2'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(0, -s * 0.7); ctx.lineTo(0, s * 0.7); ctx.stroke();
    ctx.restore();
  }

  // 烟花
  function burst(x, y) {
    const n = 26 + (Math.random() * 12 | 0);
    const base = FX_COLORS[(Math.random() * FX_COLORS.length) | 0];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.15, 0.15);
      const sp = rand(2, 5.5);
      fx.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: rand(0.012, 0.026),
        color: Math.random() < 0.6 ? base : FX_COLORS[(Math.random() * FX_COLORS.length) | 0],
        size: rand(2, 4),
      });
    }
  }
  function fireworks() {
    if (reduce) return;
    burst(W / 2, H * 0.4);
    burst(W / 2 - W * 0.2, H * 0.4 + H * 0.06);
    burst(W / 2 + W * 0.2, H * 0.4 + H * 0.03);
  }
  window.GardenFx = { fireworks };

  function render() {
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.swayPhase += p.swaySpeed; p.y += p.vy;
      p.x += Math.sin(p.swayPhase) * p.swayAmp * 0.02; p.rot += p.rotSpeed;
      if (p.y > H + p.size * 2) Object.assign(p, makePetal(false));
      else if (p.x < -40) p.x = W + 30; else if (p.x > W + 40) p.x = -30;
      drawPetal(p);
    }
    fctx.clearRect(0, 0, W, H);
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.vy += 0.045; f.vx *= 0.99; f.vy *= 0.99;
      f.x += f.vx; f.y += f.vy; f.life -= f.decay;
      if (f.life <= 0) { fx.splice(i, 1); continue; }
      fctx.save(); fctx.globalAlpha = Math.max(0, f.life); fctx.fillStyle = f.color;
      fctx.beginPath(); fctx.arc(f.x, f.y, f.size, 0, Math.PI * 2); fctx.fill();
      fctx.restore();
    }
  }

  // ≤30fps + 后台暂停，降低耗电
  let raf = null, last = 0; const DT = 1000 / 30;
  function loop(now) {
    raf = null;
    if (now - last >= DT) { render(); last = now; }
    if (!document.hidden) raf = requestAnimationFrame(loop);
  }
  function start() { if (raf == null && !document.hidden) raf = requestAnimationFrame(loop); }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = 0; start(); } });
  resize();
  if (reduce) render();      // 减少动效：仅画一帧静态
  else start();
})();
