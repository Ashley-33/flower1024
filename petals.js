/* =============================================================================
 *  拾光花园 —— 背景樱花飘落（独立模块，纯 Canvas，零依赖）
 *  在页面背景层（#app 之后）缓缓飘落粉色花瓣，不拦截任何点击。
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.createElement('canvas');
  canvas.id = 'sakura';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '0',
  });
  (document.body || document.documentElement).appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const COLORS = ['#ffd6e7', '#ffc2d6', '#ffb3c9', '#ffcfe0', '#ffdbe8'];
  const rand = (a, b) => a + Math.random() * (b - a);
  let W = 0, H = 0, petals = [];

  function makePetal(spread) {
    const size = rand(7, 15);
    return {
      x: rand(0, W || window.innerWidth),
      y: spread ? rand(-H, H) : rand(-40, -10),
      size,
      vy: rand(0.25, 0.7) * (size / 11),     // 慢慢飘落
      swayAmp: rand(12, 34),
      swayPhase: rand(0, Math.PI * 2),
      swaySpeed: rand(0.006, 0.016),
      rot: rand(0, Math.PI * 2),
      rotSpeed: rand(-0.012, 0.012),
      color: COLORS[(Math.random() * COLORS.length) | 0],
      alpha: rand(0.45, 0.85),
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = reduce ? 0 : Math.min(28, Math.round((W * H) / 42000));
    while (petals.length < target) petals.push(makePetal(true));
    if (petals.length > target) petals.length = target;
  }

  function drawPetal(p) {
    const s = p.size;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.bezierCurveTo(s * 0.62, -s * 0.55, s * 0.62, s * 0.55, 0, s);
    ctx.bezierCurveTo(-s * 0.62, s * 0.55, -s * 0.62, -s * 0.55, 0, -s);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = p.alpha * 0.35;          // 花瓣中线淡痕
    ctx.strokeStyle = '#ff9ec2';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(0, -s * 0.7); ctx.lineTo(0, s * 0.7); ctx.stroke();
    ctx.restore();
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.swayPhase += p.swaySpeed;
      p.y += p.vy;
      p.x += Math.sin(p.swayPhase) * p.swayAmp * 0.02;  // 轻微左右摇摆
      p.rot += p.rotSpeed;
      if (p.y > H + p.size * 2) { Object.assign(p, makePetal(false)); }
      else if (p.x < -40) p.x = W + 30;
      else if (p.x > W + 40) p.x = -30;
      drawPetal(p);
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  resize();
  if (reduce) { for (const p of petals) drawPetal(p); }   // 减少动效：静态少量
  else requestAnimationFrame(tick);
})();
