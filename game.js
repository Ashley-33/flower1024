/* =============================================================================
 *  1024 能量版 —— 游戏逻辑 + 渲染 + 输入（纯原生，无依赖）
 *  数值全部来自 window.GAME_CONFIG（config.js）。
 * ========================================================================== */
(function () {
  'use strict';
  const C = window.GAME_CONFIG;
  const SIZE = C.board.size;

  const emptyGrid = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  const cloneGrid = (g) => g.map((r) => r.slice());
  const ri = (n) => Math.floor(Math.random() * n);

  /* ============================ 游戏核心 ============================ */
  class Game {
    constructor(levelId) { this.start(levelId); }

    start(levelId) {
      this.level = levelId != null ? C.levels.find((l) => l.id === levelId) : null;
      this.grid = emptyGrid();
      this.energy = 0; this.cumEnergy = 0; this.combo = 0; this.bestCombo = 0;
      this.score = 0;                // 街机得分 = 所有合成结果数值之和
      this.steps = 0; this.maxTile = 0; this.reached = new Set();
      this.undoUses = 0; this.magicCd = 0; this.fertUsed = false; this.itemsUsed = 0;
      this.shield = null;            // { r, c, turns }
      this.history = null;           // 单步快照（maxHistory = 1）
      this.manualMult = null;        // 玩家手动选的倍速（null = 跟随步数自动）
      this.lastStepGain = 0;
      this.status = 'playing';       // playing | won | lost | stuck
      this.message = '';
      for (let i = 0; i < C.board.startTiles; i++) this.addRandom();
      this.updateMax();
    }

    emptyCells() {
      const a = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (this.grid[r][c] === 0) a.push([r, c]);
      return a;
    }
    // 自动倍速等级（按步数）；手动选择优先
    autoMult() {
      const steps = (C.speed && C.speed.autoSteps) || [];
      let lv = 1; for (const s of steps) if (this.steps >= s) lv++;
      return Math.min(lv, (C.speed && C.speed.maxLevel) || 4);
    }
    effMult() { return this.manualMult != null ? this.manualMult : this.autoMult(); }
    addRandom() {
      const e = this.emptyCells();
      if (!e.length) return null;
      const [r, c] = e[ri(e.length)];
      const base = Math.pow(2, this.effMult());            // m=1→2, 2→4, 3→8, 4→16
      this.grid[r][c] = Math.random() < C.board.spawn4Prob ? base * 2 : base;
      return [r, c];
    }
    updateMax() {
      let m = 0;
      for (const row of this.grid) for (const v of row) if (v > m) m = v;
      this.maxTile = m;
    }

    /* -------- 行内合并（向 index 0 方向，locked 为不可移动的墙） -------- */
    collapse(list) {
      const out = [], merges = [];
      let i = 0;
      while (i < list.length) {
        if (i + 1 < list.length && list[i] === list[i + 1]) {
          out.push(list[i] * 2); merges.push(list[i] * 2); i += 2;
        } else { out.push(list[i]); i++; }
      }
      return { out, merges };
    }
    // 行内合并，并追踪每个方块从哪个 index 移到哪个 index（供滑动动画用）
    lineMove(vals, locked) {
      const n = vals.length;
      const res = Array(n).fill(0);
      const merges = [];
      const tracks = [];   // { value, srcIdxs:[...], dstIdx, merged }
      for (let i = 0; i < n; i++) if (locked[i]) res[i] = vals[i];   // 墙原地保留
      let i = 0;
      while (i < n) {
        if (locked[i]) { i++; continue; }
        let j = i; while (j < n && !locked[j]) j++;                  // 段 [i, j-1]
        const seg = [];
        for (let k = i; k < j; k++) if (vals[k] !== 0) seg.push({ v: vals[k], idx: k });
        let out = i, p = 0;
        while (p < seg.length) {
          if (p + 1 < seg.length && seg[p].v === seg[p + 1].v) {
            res[out] = seg[p].v * 2; merges.push(seg[p].v * 2);
            tracks.push({ value: seg[p].v, srcIdxs: [seg[p].idx, seg[p + 1].idx], dstIdx: out, merged: true });
            p += 2;
          } else {
            res[out] = seg[p].v;
            tracks.push({ value: seg[p].v, srcIdxs: [seg[p].idx], dstIdx: out, merged: false });
            p++;
          }
          out++;
        }
        i = j;
      }
      const moved = vals.some((v, idx) => v !== res[idx]);
      return { res, merges, moved, tracks };
    }
    lineCoords(dir) {
      const lines = [];
      for (let i = 0; i < SIZE; i++) {
        const coords = [];
        for (let k = 0; k < SIZE; k++) {
          let r, c;
          if (dir === 'left') { r = i; c = k; }
          else if (dir === 'right') { r = i; c = SIZE - 1 - k; }
          else if (dir === 'up') { r = k; c = i; }
          else { r = SIZE - 1 - k; c = i; }
          coords.push([r, c]);
        }
        lines.push(coords);
      }
      return lines;
    }

    snapshot() {
      return {
        grid: cloneGrid(this.grid), energy: this.energy, cumEnergy: this.cumEnergy, score: this.score,
        combo: this.combo, bestCombo: this.bestCombo, steps: this.steps, maxTile: this.maxTile,
        reached: new Set(this.reached), magicCd: this.magicCd,
        shield: this.shield ? { ...this.shield } : null, fertUsed: this.fertUsed, itemsUsed: this.itemsUsed,
        manualMult: this.manualMult,
      };
    }

    move(dir) {
      if (this.status === 'won' || this.status === 'lost') return false;
      const snap = this.snapshot();
      const lines = this.lineCoords(dir);
      let movedAny = false; const allMerges = [];
      const slides = [];                 // { value, from:[r,c], to:[r,c] }
      const mergedCells = [];            // [r,c]（出现合成的目标格 -> 弹一下）
      for (const coords of lines) {
        const vals = coords.map(([r, c]) => this.grid[r][c]);
        const locked = coords.map(([r, c]) => !!(this.shield && this.shield.r === r && this.shield.c === c));
        const { res, merges, moved, tracks } = this.lineMove(vals, locked);
        if (moved) movedAny = true;
        allMerges.push(...merges);
        for (const t of tracks) {
          const to = coords[t.dstIdx];
          for (const s of t.srcIdxs) slides.push({ value: vals[s], from: coords[s], to });
          if (t.merged) mergedCells.push(to);
        }
        coords.forEach(([r, c], k) => { this.grid[r][c] = res[k]; });
      }
      if (!movedAny) return false;                 // 非法移动，不消耗回合

      // 得分结算（合成结果数值之和）
      for (const v of allMerges) this.score += v;
      // 能量结算
      let gain = 0;
      for (const v of allMerges) gain += (C.energy.mergeGain[v] || 0);
      if (allMerges.length > 0) { this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo); }
      else this.combo = 0;
      if (this.combo >= 2) gain += (C.energy.combo[Math.min(this.combo, 5)] || 0);
      this.updateMax();
      if (C.energy.milestoneBonus[this.maxTile] && !this.reached.has(this.maxTile)) {
        gain += C.energy.milestoneBonus[this.maxTile];
        this.reached.add(this.maxTile);
      }
      this.cumEnergy += gain;
      this.energy = Math.min(C.energy.cap, this.energy + gain);
      this.lastStepGain = gain;
      this.steps++;

      if (this.shield) { this.shield.turns--; if (this.shield.turns <= 0) this.shield = null; }
      if (this.magicCd > 0) this.magicCd--;

      this.history = snap;                          // 提交撤销快照（仅留 1 步）

      // 动画 + 音效数据
      const maxMerge = allMerges.length ? Math.max(...allMerges) : 0;
      let spawn = null;
      const ended = this.evaluateEnd(true);         // 落子前先判胜
      if (!ended) { spawn = this.addRandom(); this.updateMax(); this.evaluateEnd(false); }
      this.lastAnim = { slides, mergedCells, spawn, maxMerge, combo: this.combo };
      return true;
    }

    checkConstraints() {
      const k = (this.level && this.level.constraints) || {};
      if (k.noItems && this.itemsUsed > 0) return false;
      if (k.maxSteps && this.steps > k.maxSteps) return false;
      if (k.minEmptyAtWin && this.emptyCells().length < k.minEmptyAtWin) return false;
      if (k.minCumEnergy && this.cumEnergy < k.minCumEnergy) return false;
      return true;
    }
    hasMoves() {
      if (this.emptyCells().length) return true;
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        const v = this.grid[r][c];
        if (c + 1 < SIZE && this.grid[r][c + 1] === v) return true;
        if (r + 1 < SIZE && this.grid[r + 1][c] === v) return true;
      }
      return false;
    }
    // 返回 true 表示已分出胜负（won/lost），调用方应停止后续落子
    evaluateEnd(beforeSpawn) {
      if (this.level) {
        if (this.maxTile >= this.level.target) {
          if (this.checkConstraints()) { this.status = 'won'; this.message = `通关「${this.level.name}」！`; return true; }
          else if (this.level.constraints.minEmptyAtWin) this.message = '已达数字，但空格不足，继续清场…';
        }
        const ms = this.level.constraints.maxSteps;
        if (ms && this.steps >= ms && this.maxTile < this.level.target) { this.status = 'lost'; this.message = '步数用尽'; return true; }
      }
      if (!beforeSpawn && !this.hasMoves()) {
        // 残局判定：还能靠道具救场就只是“卡住”，否则才真正结束
        const canUndo = this.itemsAllowed() && this.history && this.energy >= this.undoCost();
        const canTornado = this.itemsAllowed() && this.energy >= C.items.tornado.cost; // 满盘时空格=0，满足可用条件
        if (!canUndo && !canTornado) {
          this.status = 'lost'; this.message = '花园长满啦，没有空位了';
          return true;
        }
        this.status = 'stuck'; this.message = '卡住了，用道具救场或重开';
      } else if (this.status === 'stuck' && this.hasMoves()) {
        this.status = 'playing'; this.message = '';
      }
      return false;
    }

    /* ============================ 道具 ============================ */
    undoCost() { return C.items.undo.baseCost * Math.pow(C.items.undo.costGrowth, this.undoUses); }
    itemsAllowed() { return !(this.level && this.level.constraints.noItems); }

    useUndo() {
      if (!this.itemsAllowed()) return '本关禁用道具';
      if (!this.history) return '没有可撤销的步骤';
      const cost = this.undoCost();
      if (this.energy < cost) return `能量不足（需 ${cost}）`;
      const h = this.history;
      this.grid = cloneGrid(h.grid); this.cumEnergy = h.cumEnergy; this.score = h.score; this.combo = h.combo;
      this.bestCombo = h.bestCombo; this.steps = h.steps; this.maxTile = h.maxTile;
      this.reached = new Set(h.reached); this.shield = h.shield ? { ...h.shield } : null; this.magicCd = h.magicCd;
      this.manualMult = h.manualMult != null ? h.manualMult : this.manualMult;
      this.energy = Math.max(0, h.energy - cost);   // 退还该步能量(=回到 h.energy) 再付撤销费
      this.undoUses++; this.itemsUsed++;
      this.history = null; this.status = 'playing'; this.message = '⏳ 时光倒流：已退回上一步';
      return null;
    }
    useShield(r, c) {
      if (!this.itemsAllowed()) return '本关禁用道具';
      const cost = C.items.shield.cost;
      if (this.energy < cost) return `能量不足（需 ${cost}）`;
      if (this.grid[r][c] === 0) return '请选择一个有数字的格子';
      this.energy -= cost; this.itemsUsed++;
      this.shield = { r, c, turns: C.items.shield.turns };
      this.message = '已护盾'; return null;
    }
    useMagic(from, to) {
      if (!this.itemsAllowed()) return '本关禁用道具';
      const cost = C.items.magic.cost;
      if (this.magicCd > 0) return `冷却中（剩 ${this.magicCd} 步）`;
      if (this.energy < cost) return `能量不足（需 ${cost}）`;
      const v = this.grid[from.r][from.c];
      if (v === 0) return '请选择一个有数字的格子';
      if (C.items.magic.cannotMoveMax && v === this.maxTile) return '不能移动当前最大数字';
      if (this.grid[to.r][to.c] !== 0) return '目标必须是空格';
      this.grid[to.r][to.c] = v; this.grid[from.r][from.c] = 0;
      this.energy -= cost; this.itemsUsed++; this.magicCd = C.items.magic.cooldown;
      this.message = '已移动'; this.updateMax(); return null;
    }
    canTornado() { return this.emptyCells().length <= C.items.tornado.maxEmptyToUse; }
    useTornado() {
      if (!this.itemsAllowed()) return '本关禁用道具';
      const cost = C.items.tornado.cost;
      if (!this.canTornado()) return `仅残局可用（空格需 ≤${C.items.tornado.maxEmptyToUse}）`;
      if (this.energy < cost) return `能量不足（需 ${cost}）`;
      const vals = [];
      for (const row of this.grid) for (const v of row) if (v) vals.push(v);
      // Fisher-Yates 洗牌后重排
      for (let i = vals.length - 1; i > 0; i--) { const j = ri(i + 1);[vals[i], vals[j]] = [vals[j], vals[i]]; }
      const cells = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) cells.push([r, c]);
      for (let i = cells.length - 1; i > 0; i--) { const j = ri(i + 1);[cells[i], cells[j]] = [cells[j], cells[i]]; }
      this.grid = emptyGrid();
      vals.forEach((v, i) => { const [r, c] = cells[i]; this.grid[r][c] = v; });
      this.shield = null;
      this.energy -= cost; this.itemsUsed++;
      this.message = '🍃 清风：已把所有花重新洗牌排布'; this.evaluateEnd(false); return null;
    }
    fertEligible(r, c) {
      const v = this.grid[r][c];
      return v > 0 && v <= this.maxTile * C.items.fertilizer.maxTargetRatio;
    }
    useFertilizer(r, c) {
      if (!this.itemsAllowed()) return '本关禁用道具';
      const cost = C.items.fertilizer.cost;
      if (this.fertUsed && C.items.fertilizer.oncePerGame) return '每局仅限 1 次';
      if (this.energy < cost) return `能量不足（需 ${cost}）`;
      if (!this.fertEligible(r, c)) return `只能升级 ≤ 最大数字×${C.items.fertilizer.maxTargetRatio} 的格`;
      this.grid[r][c] *= 2;
      this.energy -= cost; this.itemsUsed++; this.fertUsed = true;
      this.updateMax(); this.message = '已施肥';
      this.reached.add(this.maxTile);   // 施肥造出的数字不再额外发里程碑能量
      this.evaluateEnd(false); return null;
    }
  }

  /* ============================ 渲染 / 交互 ============================ */
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  let game = null;
  let pending = null;   // 道具选目标状态机：{ type, step, from }
  let GAP, CELL, PAD;

  function layout() {
    const size = Math.min(window.innerWidth - 24, 420);
    const dpr = window.devicePixelRatio || 1;
    PAD = Math.round(size * 0.03);
    GAP = Math.round(size * 0.025);
    CELL = (size - PAD * 2 - GAP * (SIZE - 1)) / SIZE;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.width = size * dpr; canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function cellRect(r, c) {
    return { x: PAD + c * (CELL + GAP), y: PAD + r * (CELL + GAP), w: CELL, h: CELL };
  }
  function pointToCell(px, py) {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const b = cellRect(r, c);
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { r, c };
    }
    return null;
  }
  function roundRect(x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  // ---- 颜色 / 缓动小工具 ----
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  const baseR = () => CELL * 0.42;
  const cellCenter = (r, c) => { const b = cellRect(r, c); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };

  // 数字圆盘（花蕊 / 嫩芽标签）
  function drawNumDisc(cx, cy, cr, value, col) {
    const cg = ctx.createRadialGradient(cx - cr * 0.3, cy - cr * 0.3, 1, cx, cy, cr);
    cg.addColorStop(0, '#fffdf6'); cg.addColorStop(1, '#fff2cf');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = shade(col, -10); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#6b5b4a';
    const digits = ('' + value).length;
    const fs = cr * (digits <= 2 ? 0.92 : digits === 3 ? 0.72 : digits === 4 ? 0.56 : 0.46);
    ctx.font = `800 ${fs}px "Baloo 2", "PingFang SC", system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(value, cx, cy + 1);
  }

  // 嫩芽破土造型（2 / 4）
  function drawSprout(cx, cy, R, value) {
    // 土堆
    ctx.fillStyle = '#b07d56';
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.82, R * 0.72, R * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9c6b48';
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.9, R * 0.72, R * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    // 茎
    ctx.strokeStyle = '#7bbf5a'; ctx.lineWidth = Math.max(2, R * 0.12); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy + R * 0.6); ctx.lineTo(cx, cy - R * 0.1); ctx.stroke();
    // 两片嫩叶
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(cx, cy + R * 0.34); ctx.rotate(s * -0.5); ctx.scale(s, 1);
      const g = ctx.createLinearGradient(0, 0, R * 0.55, 0);
      g.addColorStop(0, '#a6db78'); g.addColorStop(1, '#7bbf5a');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(R * 0.3, 0, R * 0.34, R * 0.17, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // value 4：顶部小花苞
    if (value === 4) {
      ctx.fillStyle = '#ffd98c';
      ctx.beginPath(); ctx.ellipse(cx, cy - R * 0.22, R * 0.2, R * 0.27, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe9b0';
      ctx.beginPath(); ctx.ellipse(cx, cy - R * 0.3, R * 0.11, R * 0.15, 0, 0, Math.PI * 2); ctx.fill();
    }
    drawNumDisc(cx, cy + R * 0.18, R * 0.34, value, C.colors[value]);
  }

  // 画一圈花瓣
  function drawPetalRing(cx, cy, count, len, w, spin, col, edge) {
    for (let p = 0; p < count; p++) {
      const a = spin + (p / count) * Math.PI * 2;
      const px = cx + Math.cos(a) * len * 0.46, py = cy + Math.sin(a) * len * 0.46;
      const grad = ctx.createRadialGradient(px, py, 1, px, py, len * 0.6);
      grad.addColorStop(0, shade(col, 28)); grad.addColorStop(1, col);
      ctx.save(); ctx.translate(px, py); ctx.rotate(a);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.ellipse(0, 0, len * 0.5, w, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = edge === '#d4af37' ? 1.6 : 1; ctx.stroke();
      ctx.restore();
    }
  }
  // 一朵花（8 及以上）
  function drawBloom(cx, cy, R, value) {
    const col = C.colors[value] || C.colors.big;
    const tier = Math.log2(value);
    const legendary = value >= (C.legendaryFrom || Infinity);
    const petals = Math.min(11, 5 + Math.floor((tier - 3) / 1.3));
    const petalLen = R * 0.86, petalW = R * 0.4, spin = (tier % 2) * 0.35;
    const edge = legendary ? '#d4af37' : shade(col, -22);
    // 叶子
    ctx.save(); ctx.translate(cx, cy + R * 0.62);
    for (const s of [-1, 1]) {
      ctx.save(); ctx.rotate(s * 0.6); ctx.scale(s, 1);
      ctx.fillStyle = '#8bc777';
      ctx.beginPath(); ctx.ellipse(R * 0.32, 0, R * 0.34, R * 0.16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    // 传说花：先铺一层更大的底瓣，形成双层重瓣
    if (legendary) drawPetalRing(cx, cy, petals, petalLen * 1.18, petalW * 1.05, spin + Math.PI / petals, shade(col, -12), edge);
    drawPetalRing(cx, cy, petals, petalLen, petalW, spin, col, edge);
    drawNumDisc(cx, cy, R * 0.5, value, col);
    if (legendary) {                              // 花蕊金边
      ctx.strokeStyle = '#f0c95b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // 统一入口：按数值与缩放画一棵植物
  function drawPlant(cx, cy, R, value, scale) {
    R = R * (scale == null ? 1 : scale);
    if (R < 1) return;
    if (value <= 4) drawSprout(cx, cy, R, value);
    else drawBloom(cx, cy, R, value);
  }

  // 大花光晕（512+）
  function drawBigGlow(cx, cy, R, value, now) {
    const col = C.colors[value] || C.colors.big;
    const pulse = 0.5 + 0.5 * Math.sin(now / 420 + cx * 0.05 + cy * 0.05);
    const rad = R * (1.45 + 0.14 * pulse);
    const g = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, rad);
    g.addColorStop(0, hexA(col, 0.30 + 0.14 * pulse));
    g.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
  }
  // 环绕星点（传说花 4096+）
  function drawSparkles(cx, cy, R, value, now) {
    for (let k = 0; k < 5; k++) {
      const a = now / 900 + k * (Math.PI * 2 / 5);
      const rad = R * (1.2 + 0.12 * Math.sin(now / 350 + k));
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      const tw = 0.5 + 0.5 * Math.sin(now / 200 + k * 1.3);
      const s = R * 0.1 * (0.6 + 0.7 * tw);
      ctx.save(); ctx.translate(x, y); ctx.globalAlpha = 0.5 + 0.5 * tw;
      ctx.fillStyle = '#fff4c2';
      ctx.beginPath();
      for (let i = 0; i < 4; i++) { const ang = i * Math.PI / 2; ctx.lineTo(Math.cos(ang) * s, Math.sin(ang) * s); ctx.lineTo(Math.cos(ang + Math.PI / 4) * s * 0.4, Math.sin(ang + Math.PI / 4) * s * 0.4); }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
  // 飘落花瓣（512+）
  function drawFallingPetals(cx, cy, R, value, now) {
    const col = C.colors[value] || C.colors.big;
    const top = cy - R * 1.1, span = R * 2.2;
    for (let k = 0; k < 4; k++) {
      const seed = k * 97 + Math.round(cx) * 13 + Math.round(cy) * 7;
      const ph = ((now / 1500) + k * 0.27 + (seed % 100) / 100) % 1;
      const y = top + ph * span;
      const x = cx + Math.sin(now / 600 + k * 1.7 + seed) * R * 0.55;
      ctx.save();
      ctx.globalAlpha = 0.5 * Math.sin(ph * Math.PI);
      ctx.translate(x, y); ctx.rotate(now / 500 + k);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 0.15, R * 0.07, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // ---- 帧绘制 ----
  function drawBoardAndPlots() {
    const W = canvas.width / (window.devicePixelRatio || 1);
    const soil = ctx.createLinearGradient(0, 0, 0, W);
    soil.addColorStop(0, '#cdebb6'); soil.addColorStop(1, '#a9d98e');
    ctx.fillStyle = soil; roundRect(0, 0, W, W, 18); ctx.fill();
    ctx.strokeStyle = '#caa06b'; ctx.lineWidth = 6; roundRect(3, 3, W - 6, W - 6, 16); ctx.stroke();
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const b = cellRect(r, c);
      const plot = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      plot.addColorStop(0, 'rgba(120,90,60,0.18)'); plot.addColorStop(1, 'rgba(120,90,60,0.10)');
      ctx.fillStyle = plot; roundRect(b.x, b.y, b.w, b.h, 12); ctx.fill();
    }
  }
  // 静止 / 弹出阶段：按 grid 画，mergedSet 弹一下、spawnKey 破土生长
  function drawGrid(now, mergedSet, spawnKey, pe) {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const v = game.grid[r][c];
      if (!v) continue;
      const { x, y } = cellCenter(r, c);
      const key = r + ',' + c;
      let scale = 1;
      if (spawnKey === key) scale = Math.max(0, easeOutBack(Math.min(1, pe)));
      else if (mergedSet && mergedSet.has(key)) scale = 1 + 0.18 * Math.sin(Math.min(1, pe) * Math.PI);
      if (v >= 512) drawBigGlow(x, y, baseR() * scale, v, now);
      drawPlant(x, y, baseR(), v, scale);
      if (v >= 512) drawFallingPetals(x, y, baseR(), v, now);
      if (v >= (C.legendaryFrom || Infinity)) drawSparkles(x, y, baseR(), v, now);

      if (game.shield && game.shield.r === r && game.shield.c === c) {
        const b = cellRect(r, c);
        ctx.fillStyle = 'rgba(130,200,255,0.18)';
        roundRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 12); ctx.fill();
        ctx.strokeStyle = '#5bc0eb'; ctx.lineWidth = 3;
        roundRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 12); ctx.stroke();
        ctx.font = `700 ${CELL * 0.2}px sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('🏡' + game.shield.turns, b.x + 5, b.y + 4);
      }
      if (pending && isSelectable(r, c)) {
        const b = cellRect(r, c);
        ctx.save(); ctx.strokeStyle = '#ffb703'; ctx.lineWidth = 4;
        ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 12;
        roundRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 12); ctx.stroke(); ctx.restore();
      }
    }
    // 空格高亮（魔术手选目标空格时）
    if (pending) for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (game.grid[r][c] === 0 && isSelectable(r, c)) {
        const b = cellRect(r, c);
        ctx.save(); ctx.strokeStyle = '#ffb703'; ctx.lineWidth = 4;
        ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 12;
        roundRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 12); ctx.stroke(); ctx.restore();
      }
    }
  }

  const SLIDE = 110, POP = 150;
  let anim = null;   // { slides, mergedSet, spawnKey, t0 } 或 { popOnly:true, popSet, t0 }
  function render(now) {
    if (CELL == null || !game) return;
    drawBoardAndPlots();
    if (anim) {
      const e = now - anim.t0;
      if (anim.popOnly) {
        if (e < POP) { drawGrid(now, anim.popSet, null, e / POP); return; }
        anim = null;
      } else if (e < SLIDE) {                       // 滑动阶段：画移动中的精灵
        const p = easeOut(e / SLIDE);
        for (const s of anim.slides) {
          const f = cellCenter(s.from[0], s.from[1]), t = cellCenter(s.to[0], s.to[1]);
          drawPlant(f.x + (t.x - f.x) * p, f.y + (t.y - f.y) * p, baseR(), s.value, 1);
        }
        return;
      } else if (e < SLIDE + POP) {                 // 弹出/破土阶段
        drawGrid(now, anim.mergedSet, anim.spawnKey, (e - SLIDE) / POP);
        return;
      } else anim = null;
    }
    drawGrid(now, null, null, 0);
  }
  function loop(now) { render(now); requestAnimationFrame(loop); }

  /* ---------------- 声音（Web Audio，纯合成，无音频文件） ---------------- */
  const Sound = {
    ctx: null, master: null, muted: false, started: false, bgmStep: 0, bgmTimer: null,
    PENTA: [392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5],
    BGM: [261.63, 329.63, 392.0, 440.0, 523.25, 392.0, 329.63, 293.66],
    ensure() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
    },
    start() {                                   // 首个用户手势后调用
      this.ensure(); if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (!this.started) { this.started = true; this.scheduleBgm(); }
    },
    note(freq, dur, type, gain, t) {
      if (!this.ctx || this.muted) return;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      const now = t || this.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(gain, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(g); g.connect(this.master); o.start(now); o.stop(now + dur + 0.05);
    },
    merge(value) {
      const tier = Math.max(0, Math.log2(value) - 2);
      const f = this.PENTA[Math.min(this.PENTA.length - 1, Math.floor(tier))];
      this.note(f, 0.22, 'sine', 0.16); this.note(f * 2, 0.18, 'sine', 0.05);
    },
    bloomBig() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.note(f, 0.5, 'triangle', 0.12, t + i * 0.07));
    },
    slide() { this.note(210, 0.08, 'sine', 0.04); },
    item() { this.note(587.33, 0.16, 'triangle', 0.1); },
    scheduleBgm() {
      const tick = () => {
        if (this.started && !this.muted) {
          const f = this.BGM[this.bgmStep % this.BGM.length];
          this.note(f, 2.2, 'sine', 0.045); this.note(f * 1.5, 2.0, 'sine', 0.02);
          this.bgmStep++;
        }
      };
      tick(); this.bgmTimer = setInterval(tick, 1100);
    },
    toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.6; return this.muted; },
  };

  function isSelectable(r, c) {
    if (!pending) return false;
    const v = game.grid[r][c];
    if (pending.type === 'shield') return v > 0;
    if (pending.type === 'fertilizer') return game.fertEligible(r, c);
    if (pending.type === 'magic') {
      if (pending.step === 'from') return v > 0 && !(C.items.magic.cannotMoveMax && v === game.maxTile);
      return v === 0;   // 选目标空格
    }
    return false;
  }

  /* ---------------- HUD ---------------- */
  function renderHUD() {
    $('steps').textContent = `🏆 得分 ${game.score}`;
    $('cum').textContent = `🌼最高 ${game.maxTile} · 步数 ${game.steps}`;
    const pct = Math.round((game.energy / C.energy.cap) * 100);
    const full = game.energy >= C.energy.cap;
    $('energyfill').style.width = pct + '%';
    $('energybar').classList.toggle('full', full);
    $('energytext').textContent = `☀️ 阳光 ${game.energy}/${C.energy.cap}`
      + (full ? ' ✨该花啦' : '') + (game.combo >= 2 ? `  🌸${game.combo}连开` : '');
    $('hint').textContent = pending ? pendingHint() : (game.message || '');
    $('hint').className = pending ? 'hint active' : 'hint';
    renderItems();
    renderSpeed();
    $('items').classList.toggle('urge', full);   // 满阳光时引导消费
    renderOverlay();
  }
  function pendingHint() {
    if (pending.type === 'shield') return `🏡 温室罩：点一朵花，它将 ${C.items.shield.turns} 回合内固定不动、不被挤走`;
    if (pending.type === 'fertilizer') return '🌱 肥料：点一朵高亮的小花，让它直接升一级（限当前最大数字¼以内）';
    if (pending.type === 'magic') {
      return pending.step === 'from'
        ? '🧤 园丁手：先点要搬走的花（最大的那朵不能动）'
        : '🧤 园丁手：再点一个空格，把它移过去';
    }
    return '';
  }
  const ITEM_ORDER = ['undo', 'shield', 'magic', 'tornado', 'fertilizer'];
  function itemState(key) {
    const it = C.items[key];
    if (!game.itemsAllowed()) return { cost: it.cost || 0, disabled: true, note: '禁用' };
    if (key === 'undo') {
      const cost = game.undoCost();
      return { cost, disabled: !game.history || game.energy < cost, note: game.history ? '' : '无步' };
    }
    if (key === 'magic') {
      if (game.magicCd > 0) return { cost: it.cost, disabled: true, note: `冷却${game.magicCd}` };
      return { cost: it.cost, disabled: game.energy < it.cost, note: '' };
    }
    if (key === 'tornado') {
      if (!game.canTornado()) return { cost: it.cost, disabled: true, note: '非残局' };
      return { cost: it.cost, disabled: game.energy < it.cost, note: '' };
    }
    if (key === 'fertilizer') {
      if (game.fertUsed) return { cost: it.cost, disabled: true, note: '已用' };
      return { cost: it.cost, disabled: game.energy < it.cost, note: '' };
    }
    return { cost: it.cost, disabled: game.energy < it.cost, note: '' };
  }
  function renderItems() {
    const box = $('items');
    box.innerHTML = '';
    for (const key of ITEM_ORDER) {
      const it = C.items[key];
      const st = itemState(key);
      const btn = document.createElement('button');
      btn.className = 'item' + (st.disabled ? ' disabled' : '') + (pending && pending.type === key ? ' selecting' : '');
      btn.innerHTML = `<span class="ic">${it.icon}</span><span class="nm">${it.name}</span>`
        + `<span class="cost">☀️${st.cost}${st.note ? ' · ' + st.note : ''}</span>`;
      btn.onclick = () => onItem(key);
      box.appendChild(btn);
    }
  }
  /* ---------------- 排行榜（localStorage 本地持久化） ---------------- */
  const LB_KEY = 'garden1024_leaderboard_v1';
  const LB_SIZE = (C.leaderboard && C.leaderboard.size) || 10;
  const NAME_MAX = (C.leaderboard && C.leaderboard.nameMaxLen) || 8;
  let scoreSubmitted = false, lastSavedT = null, forcedEnd = false;

  function loadLB() { try { return JSON.parse(localStorage.getItem(LB_KEY)) || []; } catch (e) { return []; } }
  function saveLB(list) { try { localStorage.setItem(LB_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式忽略 */ } }
  function qualifies(score) {
    const lb = loadLB();
    return score > 0 && (lb.length < LB_SIZE || score > lb[lb.length - 1].score);
  }
  function rankFor(score) { let n = 0; for (const e of loadLB()) if (e.score > score) n++; return n + 1; }
  function addScore(name, score, max) {
    const lb = loadLB();
    const entry = { name, score, max, t: Date.now() };
    lb.push(entry);
    lb.sort((a, b) => b.score - a.score || b.max - a.max || a.t - b.t);
    const top = lb.slice(0, LB_SIZE);
    saveLB(top);
    return entry;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 名字校验：长度、字符集、违禁词
  function validateName(raw) {
    const name = (raw || '').trim();
    if (!name) return { ok: false, msg: '请输入名字' };
    if ([...name].length > NAME_MAX) return { ok: false, msg: `名字最多 ${NAME_MAX} 个字` };
    if (!/^[一-龥a-zA-Z0-9 _\-·.]+$/.test(name)) return { ok: false, msg: '含有不支持的字符' };
    const norm = name.toLowerCase().replace(/\s+/g, '');
    for (const w of (C.badwords || [])) if (norm.includes(w)) return { ok: false, msg: '名字含违禁词，请换一个' };
    return { ok: true, name };
  }
  function submitScore(raw) {
    const v = validateName(raw);
    if (!v.ok) { const e = $('nameErr'); if (e) e.textContent = v.msg; return; }
    const entry = addScore(v.name, game.score, game.maxTile);
    scoreSubmitted = true; lastSavedT = entry.t;
    Sound.item();
    renderOverlay();
  }
  function boardHTML(board, highlightT) {
    if (!board.length) return '<div class="ov-empty">还没有记录，争取第一个上榜！</div>';
    const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
    let h = '<ol class="ov-board">';
    board.forEach((e, i) => {
      const me = highlightT != null && e.t === highlightT;
      h += `<li class="${me ? 'me' : ''}"><span class="rk">${medal(i)}</span>`
        + `<span class="nm">${escapeHtml(e.name)}</span>`
        + `<span class="sc">${e.score}</span><span class="mx">🌼${e.max}</span></li>`;
    });
    return h + '</ol>';
  }

  function renderSpeed() {
    const box = $('speed');
    if (!box) return;
    const max = (C.speed && C.speed.maxLevel) || 4;
    const eff = game.effMult();
    const auto = game.manualMult == null;
    let h = '<span class="splabel">倍速</span>';
    h += `<button class="spbtn${auto ? ' on' : ''}" data-m="auto">自动</button>`;
    for (let m = 1; m <= max; m++) {
      h += `<button class="spbtn${(!auto && m === eff) ? ' on' : ''}" data-m="${m}">${m}x</button>`;
    }
    h += `<span class="spnote">出花从 ${Math.pow(2, eff)} 起</span>`;
    box.innerHTML = h;
    box.querySelectorAll('.spbtn').forEach((b) => {
      b.onclick = () => {
        game.manualMult = b.dataset.m === 'auto' ? null : +b.dataset.m;
        refresh();
      };
    });
  }

  function renderOverlay() {
    const ov = $('overlay');
    const stuck = game.status === 'stuck';
    const over = game.status === 'won' || game.status === 'lost';
    if (!stuck && !over) { ov.className = 'hidden'; ov.innerHTML = ''; return; }
    ov.className = '';

    // 卡住但还能救场：先给救场 / 结束选择，不直接进榜
    if (stuck && !forcedEnd) {
      const canTor = game.canTornado() && game.energy >= C.items.tornado.cost;
      const canUndo = game.history && game.energy >= game.undoCost();
      let h = '<div class="ov-card">';
      h += '<div class="ov-title">🪴 卡住了！</div>';
      h += `<div class="ov-stats">🏆 得分 ${game.score} · 🌼最高 ${game.maxTile} · 步数 ${game.steps}</div>`;
      h += '<div class="ov-rescue">';
      if (canTor) h += `<button id="rescTornado" class="ovbtn alt">🍃 清风救场（☀️${C.items.tornado.cost}）</button>`;
      if (canUndo) h += `<button id="rescUndo" class="ovbtn alt">⏳ 时光倒流（☀️${game.undoCost()}）</button>`;
      h += '</div>';
      h += '<button id="endRun" class="ovbtn">🏁 结束本局 · 上榜</button></div>';
      ov.innerHTML = h;
      if (canTor) $('rescTornado').onclick = () => { game.useTornado(); Sound.item(); refresh(); };
      if (canUndo) $('rescUndo').onclick = () => { game.useUndo(); Sound.item(); refresh(); };
      $('endRun').onclick = () => { forcedEnd = true; renderOverlay(); };
      return;
    }

    const titleTxt = game.status === 'won' ? '🌷 ' + (game.message || '通关')
      : game.status === 'lost' ? '🥀 ' + (game.message || '游戏结束')
      : '🏁 本局结束';
    const canEnter = !scoreSubmitted && qualifies(game.score);
    let html = '<div class="ov-card">';
    html += `<div class="ov-title">${titleTxt}</div>`;
    html += `<div class="ov-stats">🏆 得分 ${game.score} · 🌼最高 ${game.maxTile} · 步数 ${game.steps}</div>`;
    if (canEnter) {
      html += '<div class="ov-entry">'
        + `<div class="ov-rank">🎉 冲进第 ${rankFor(game.score)} 名！留名上榜：</div>`
        + `<input id="nameInput" maxlength="${NAME_MAX}" placeholder="输入名字（最多 ${NAME_MAX} 字）" autocomplete="off">`
        + '<div id="nameErr" class="ov-err"></div>'
        + '<button id="saveScore" class="ovbtn">保存成绩</button></div>';
    }
    html += '<div class="ov-boardtitle">🏅 花园榜 · 前十</div>';
    html += boardHTML(loadLB(), scoreSubmitted ? lastSavedT : null);
    html += '<button id="overlaybtn" class="ovbtn">🌱 再来一局</button></div>';
    ov.innerHTML = html;

    $('overlaybtn').onclick = () => newGame(null);
    if (canEnter) {
      const inp = $('nameInput');
      inp.focus();
      $('saveScore').onclick = () => submitScore(inp.value);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitScore(inp.value); } });
      inp.addEventListener('input', () => { const er = $('nameErr'); if (er) er.textContent = ''; });
    }
  }

  function refresh() { renderHUD(); }
  const now = () => performance.now();
  // 给一组格子加“弹出/生长”动画（道具用）
  function popCells(cells) {
    anim = { popOnly: true, popSet: new Set(cells.map((c) => c[0] + ',' + c[1])), t0: now() };
  }

  /* ---------------- 交互 ---------------- */
  function onItem(key) {
    if (game.status === 'won' || game.status === 'lost') return;
    Sound.start();
    if (pending && pending.type === key) { pending = null; refresh(); return; } // 再点取消
    let err = null;
    if (key === 'undo') { err = game.useUndo(); if (!err) { anim = null; Sound.item(); } }
    else if (key === 'tornado') {
      err = game.useTornado();
      if (!err) { popCells(game.emptyCells().length < SIZE * SIZE ? allFilledCells() : []); Sound.item(); }
    } else { pending = { type: key, step: 'from' }; refresh(); return; }
    if (err) flash(err); else pending = null;
    refresh();
  }
  function allFilledCells() {
    const a = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (game.grid[r][c]) a.push([r, c]);
    return a;
  }
  function onCanvasTap(px, py) {
    if (!pending) return;
    Sound.start();
    const cell = pointToCell(px, py);
    if (!cell || !isSelectable(cell.r, cell.c)) { flash('选择无效'); return; }
    let err = null;
    if (pending.type === 'shield') { err = game.useShield(cell.r, cell.c); if (!err) Sound.item(); pending = null; }
    else if (pending.type === 'fertilizer') {
      err = game.useFertilizer(cell.r, cell.c);
      if (!err) { popCells([[cell.r, cell.c]]); (game.grid[cell.r][cell.c] >= 512 ? Sound.bloomBig() : Sound.item()); }
      pending = null;
    } else if (pending.type === 'magic') {
      if (pending.step === 'from') { pending = { type: 'magic', step: 'to', from: cell }; }
      else { err = game.useMagic(pending.from, cell); if (!err) { popCells([[cell.r, cell.c]]); Sound.item(); } pending = null; }
    }
    if (err) flash(err);
    refresh();
  }
  let flashTimer = null;
  function flash(msg) {
    game.message = msg; $('hint').textContent = msg; $('hint').className = 'hint warn';
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { game.message = ''; renderHUD(); }, 1400);
  }

  function doMove(dir) {
    Sound.start();
    if (pending) { pending = null; refresh(); return; }
    const ok = game.move(dir);
    if (!ok) return;
    const a = game.lastAnim;
    anim = {
      slides: a.slides,
      mergedSet: new Set(a.mergedCells.map((c) => c[0] + ',' + c[1])),
      spawnKey: a.spawn ? a.spawn[0] + ',' + a.spawn[1] : null,
      t0: now(),
    };
    Sound.slide();
    if (a.maxMerge >= 512) Sound.bloomBig();
    else if (a.maxMerge > 0) Sound.merge(a.maxMerge);
    refresh();
  }

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // 输入名字时不拦截按键
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' };
    if (map[e.key]) { e.preventDefault(); doMove(map[e.key]); }
  });
  // 触摸 / 鼠标：区分“点击选目标”与“滑动移动”
  let touchStart = null;
  function localXY(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    handleSwipeOrTap(touchStart, { x: t.clientX, y: t.clientY });
    touchStart = null;
  });
  canvas.addEventListener('mousedown', (e) => { touchStart = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('mouseup', (e) => {
    if (!touchStart) return;
    handleSwipeOrTap(touchStart, { x: e.clientX, y: e.clientY });
    touchStart = null;
  });
  function handleSwipeOrTap(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {            // 视为点击
      const p = localXY(b.x, b.y); onCanvasTap(p.x, p.y); return;
    }
    if (Math.abs(dx) > Math.abs(dy)) doMove(dx > 0 ? 'right' : 'left');
    else doMove(dy > 0 ? 'down' : 'up');
  }

  /* ---------------- 启动 / 选关 ---------------- */
  function newGame(levelId) {
    pending = null;
    anim = null;
    scoreSubmitted = false; lastSavedT = null; forcedEnd = false;
    game = new Game(levelId);
    refresh();
  }
  function initControls() {
    $('restart').onclick = () => newGame(null);
    const sb = $('sound');
    if (sb) sb.onclick = () => { Sound.start(); const m = Sound.toggleMute(); sb.textContent = m ? '🔇' : '🔊'; };
  }

  window.addEventListener('resize', layout);
  initControls();
  newGame(null);
  layout();
  requestAnimationFrame(loop);
})();
