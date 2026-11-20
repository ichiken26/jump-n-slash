const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
const spriteLayer = document.querySelector('#sprite-layer');
const playerSprite = document.querySelector('#player-sprite');
const scoreLabel = document.querySelector('#score');
const bestLabel = document.querySelector('#best');

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const GROUND = 210;
const SPRITE_SIZE = 96; // 32 × 32 のドット絵を整数倍の3倍で表示
const JUMP_DURATION = 0.65; // 着地まで0.65秒。ジャンプGIFの500ms/コマはそのまま
const JUMP_HEIGHT = 100;
const ATTACK_DURATION = 0.6; // 攻撃時の専用PNGを0.6秒だけ表示

// GIF はオリジナルの500ms/コマを維持。攻撃中のみ静止PNGに切り替える。
// Canvas の上に重ねた img でアニメーションを再生する。
const PLAYER_GIFS = {
  idle: 'img/slime_sourd.gif',
  jump: 'img/slime_sourd_jump.gif',
  attack: 'img/slime_sourd_attack.png',
};

let enemyGifReady = false;
const enemyPreload = new Image();
enemyPreload.onload = () => { enemyGifReady = true; };
enemyPreload.onerror = () => { enemyGifReady = false; };
enemyPreload.src = 'img/enemy.gif';

// ゲーム開始時の画像切替をスムーズにするため先読みする。
Object.values(PLAYER_GIFS).forEach(src => { const img = new Image(); img.src = src; });

let best = 0;
try { best = Number(localStorage.getItem('jump-slash-best-cleared-v1')) || 0; } catch {}
bestLabel.textContent = best;

let state = 'ready'; // ready / playing / over
let player, objects, particles, trees, score, elapsed, spawnTimer, speed;
let lastTime = performance.now();

// 背景は大小2種類のドット絵の木だけ。ランダム間隔で無限に再配置する。
const TREE_SCROLL_RATIO = 0.24; // ゆっくり流れる背景（障害物とは別レイヤー）
function makeTree(x) {
  return { x, kind: Math.random() < 0.55 ? 'small' : 'large' };
}

function resetTrees() {
  trees = [];
  let x = 30;
  while (x < WIDTH + 180) {
    x += 112 + Math.random() * 90;
    trees.push(makeTree(x));
  }
}

function updateTrees(dt) {
  for (const tree of trees) tree.x -= speed * TREE_SCROLL_RATIO * dt;
  while (trees[0] && trees[0].x < -85) {
    trees.shift();
    const rightmost = trees.length ? trees[trees.length - 1].x : WIDTH;
    trees.push(makeTree(Math.max(WIDTH, rightmost) + 112 + Math.random() * 90));
  }
}

function reset() {
  player = {
    x: 115, y: GROUND - 58, w: 81, h: 58,
    jumpTime: JUMP_DURATION, attackTime: 0,
  };
  for (const img of spriteLayer.querySelectorAll('.enemy-sprite')) img.remove();
  objects = [];
  particles = [];
  resetTrees();
  score = 0;
  elapsed = 0;
  spawnTimer = 0.6 + Math.random() * 0.45; // 初回: 0.60〜1.05秒
  speed = 285;
  scoreLabel.textContent = '0';
}
reset();

function pressAction(code) {
  if (state !== 'playing') {
    reset();
    state = 'playing';
  }

  if (code === 'Space' && player.jumpTime >= JUMP_DURATION) {
    player.jumpTime = 0;
  }
  if (code === 'Enter' && player.attackTime <= 0) {
    player.attackTime = ATTACK_DURATION;
  }
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' && event.code !== 'Enter') return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  if (event.repeat) return;
  pressAction(event.code);
});

document.querySelectorAll('.key-btn').forEach((button) => {
  const code = button.dataset.key;
  const release = () => button.classList.remove('is-pressed');

  button.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    button.classList.add('is-pressed');
    pressAction(code);
    try { button.setPointerCapture(event.pointerId); } catch {}
  }, { passive: false });

  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
});

function gameOver() {
  state = 'over';
  if (score > best) {
    best = score;
    bestLabel.textContent = best;
    try { localStorage.setItem('jump-slash-best-cleared-v1', String(best)); } catch {}
  }
}

function spawn() {
  const enemy = Math.random() < 0.48;
  objects.push({
    type: enemy ? 'enemy' : 'obstacle',
    x: WIDTH + 10,
    y: GROUND - (enemy ? 72 : 75),
    w: enemy ? 69 : 30, // ▲の横幅だけ42→30px。ジャンプ判定を少し緩くする
    h: enemy ? 72 : 75,
    img: null,
    scored: false, // 回避・撃破による加点は各オブジェクトで一度だけ
  });
  // 40%の確率で短い連続出現にして、Enterを2回続けて押せるテンポを作る。
  // 最短0.66秒にすることで、攻撃0.6秒・ジャンプ0.65秒の再操作も間に合う。
  spawnTimer = Math.random() < 0.4
    ? 0.66 + Math.random() * 0.22 // 連続出現: 0.66〜0.88秒
    : 0.90 + Math.random() * 0.58; // 通常: 0.90〜1.48秒
}

function overlaps(a, b) {
  if (b.type === 'obstacle') {
    // 細長い▲は四角い当たり判定にすると跳び越せなくなる。
    // 三角形の高さに応じた横幅で判定し、先端には少し余裕を持たせる。
    const feetY = a.y + a.h - 6;
    const effectiveTop = b.y + 15;
    if (feetY <= effectiveTop) return false;
    const progress = Math.min(1, (feetY - effectiveTop) / (b.h - 15));
    const halfWidth = b.w * 0.5 * progress;
    const center = b.x + b.w * 0.5;
    const playerLeft = a.x + 20;
    const playerRight = a.x + a.w - 16;
    return center + halfWidth > playerLeft && center - halfWidth < playerRight;
  }
  return a.x + 6 < b.x + b.w - 6 &&
         a.x + a.w - 6 > b.x + 6 &&
         a.y + 5 < b.y + b.h - 4 &&
         a.y + a.h - 4 > b.y + 5;
}

function burstAt(x, y) {
  // 当たった瞬間のドット状ヒットスパーク。描画は四角形のみ。
  const offsets = [
    [-90, -75], [-65, 5], [-35, -110], [0, 95],
    [50, -80], [75, 5], [105, -45], [30, 75],
  ];
  offsets.forEach(([vx, vy], i) => {
    particles.push({
      x, y, vx, vy, life: 0.34, size: i % 3 === 0 ? 8 : 5,
      color: i % 2 === 0 ? '#f9e6a4' : '#8af7ff',
    });
  });
}

function update(dt) {
  if (state !== 'playing') return;

  elapsed += dt;
  speed = Math.min(380, 285 + elapsed * 1.7);
  updateTrees(dt);
  spawnTimer -= dt;
  if (spawnTimer <= 0) spawn();

  // ジャンプは約0.65秒で着地。GIF側の500ms/フレームは変更しない。
  player.jumpTime = Math.min(JUMP_DURATION, player.jumpTime + dt);
  const jumpProgress = player.jumpTime / JUMP_DURATION;
  player.y = GROUND - player.h - Math.sin(Math.PI * jumpProgress) * JUMP_HEIGHT;
  player.attackTime = Math.max(0, player.attackTime - dt);

  for (const obj of objects) {
    obj.x -= speed * dt;

    // 剣の届く範囲を攻撃判定に使用する。
    if (obj.type === 'enemy' && player.attackTime > 0 &&
        obj.x < player.x + player.w + 46 &&
        obj.x + obj.w > player.x + player.w - 9 &&
        player.y + player.h > obj.y - 45) {
      obj.dead = true;
      burstAt(obj.x + obj.w * 0.5, obj.y + obj.h * 0.5);
      if (!obj.scored) {
        score += 1;
        obj.scored = true;
      }
      continue;
    }

    // 敵は飛び越すだけでは倒せない。倒さず通過するとゲームオーバー。
    if (overlaps(player, obj) ||
        (obj.type === 'enemy' && obj.x + obj.w < player.x)) {
      gameOver();
      break;
    }

    // 障害物がプレイヤーを完全に通過した時点で、回避成功として+1。
    // ジャンプ中でもOK。失敗・同一障害物の二重加算はしない。
    if (obj.type === 'obstacle' && !obj.scored &&
        obj.x + obj.w < player.x) {
      score += 1;
      obj.scored = true;
    }
  }

  objects = objects.filter(obj => {
    const keep = !obj.dead && obj.x + obj.w > -20;
    if (!keep) obj.img?.remove();
    return keep;
  });
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  particles = particles.filter(p => p.life > 0);
  scoreLabel.textContent = score;
}

function positionSprite(img, x, y) {
  img.style.left = `${x / WIDTH * 100}%`;
  img.style.top = `${y / HEIGHT * 100}%`;
  img.style.width = `${SPRITE_SIZE / WIDTH * 100}%`;
  img.style.height = `${SPRITE_SIZE / HEIGHT * 100}%`;
}

function syncSprites() {
  const pose = player.attackTime > 0 ? 'attack' :
    player.jumpTime < JUMP_DURATION ? 'jump' : 'idle';
  const src = PLAYER_GIFS[pose];
  if (playerSprite.getAttribute('src') !== src) playerSprite.src = src;

  // 32px画像の透明領域を踏まえ、スライムの足元を地面に合わせる。
  positionSprite(playerSprite, player.x - 6, player.y - 17);
  spriteLayer.style.opacity = state === 'playing' ? '1' : '0.6';

  for (const obj of objects) {
    if (obj.type !== 'enemy') continue;
    if (!enemyGifReady) {
      obj.img?.remove();
      obj.img = null;
      continue;
    }
    if (!obj.img) {
      obj.img = document.createElement('img');
      obj.img.className = 'sprite enemy-sprite';
      obj.img.src = 'img/enemy.gif';
      obj.img.alt = '';
      spriteLayer.appendChild(obj.img);
    }
    // 敵GIFの可視範囲は原寸の x=6..29, y=4..28。
    positionSprite(obj.img, obj.x - 18, GROUND - 84);
  }
}

function drawPixelTriangle(x, baseY, width, height) {
  // 横幅と高さを別々に指定できる、階段状のドット絵▲。
  const step = 4;
  const center = Math.round(x + width / 2);
  for (let rowY = 0; rowY < height; rowY += step) {
    const rowHeight = Math.min(step, height - rowY);
    const rowWidth = Math.max(step, Math.min(width, Math.ceil((rowY + rowHeight) / height * width / step) * step));
    ctx.fillStyle = '#e4a36e';
    ctx.fillRect(Math.round(center - rowWidth / 2), Math.round(baseY - height + rowY), rowWidth, rowHeight);
  }
  ctx.fillStyle = '#ffe0a2';
  ctx.fillRect(center - 2, baseY - height + 8, 4, 10);
}

function drawAttackEffect() {
  if (state !== 'playing' || player.attackTime <= 0) return;
  const attackElapsed = ATTACK_DURATION - player.attackTime;
  if (attackElapsed > 0.30) return;

  const x = Math.round((player.x + player.w - 4) / 4) * 4;
  const y = Math.round((player.y + 10) / 4) * 4;
  const advance = Math.floor(attackElapsed / 0.075) * 8;

  // 右向きに振る斬撃。前の左右逆を修正。
  const slash = [
    [14, 54], [24, 46], [34, 38], [44, 30],
    [54, 22], [64, 14], [74, 8], [84, 4],
  ];
  for (const [dx, dy] of slash) {
    ctx.fillStyle = '#2fbfe4';
    ctx.fillRect(x + dx + advance - 4, y + dy - 4, 16, 12);
    ctx.fillStyle = '#e8ffff';
    ctx.fillRect(x + dx + advance, y + dy, 8, 4);
  }

  const sparks = [
    [98, 6, 8], [106, 18, 6], [114, 30, 6], [92, 40, 8], [84, 50, 6]
  ];
  for (const [dx, dy, size] of sparks) {
    ctx.fillStyle = '#8ff7ff';
    ctx.fillRect(x + dx + advance, y + dy, size, size);
    ctx.fillStyle = '#fff4b0';
    ctx.fillRect(
      x + dx + advance + 2,
      y + dy + 2,
      Math.max(2, size - 4),
      Math.max(2, size - 4)
    );
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.fillStyle = p.color;
    const x = Math.round(p.x / 2) * 2;
    const y = Math.round(p.y / 2) * 2;
    ctx.fillRect(x, y, p.size, p.size);
  }
}

// 木の形状は障害物の▲と混同しないよう、四角い葉の塊に統一する。
function drawTree(tree) {
  const x = Math.round(tree.x / 3) * 3;
  const groundY = GROUND - 7;
  if (tree.kind === 'small') {
    // 小さい木：高さ約55px・明るめの樹冠
    ctx.fillStyle = '#76553a';
    ctx.fillRect(x + 15, groundY - 31, 9, 31);
    ctx.fillStyle = '#4d8759';
    ctx.fillRect(x + 9, groundY - 48, 24, 31);
    ctx.fillRect(x + 3, groundY - 39, 36, 18);
    ctx.fillStyle = '#6eab6b';
    ctx.fillRect(x + 12, groundY - 54, 18, 12);
    ctx.fillRect(x + 6, groundY - 45, 12, 12);
    ctx.fillRect(x + 21, groundY - 42, 12, 9);
  } else {
    // 大きい木：高さ約90px・横に広い樹冠
    ctx.fillStyle = '#6b4a32';
    ctx.fillRect(x + 25, groundY - 52, 15, 52);
    ctx.fillStyle = '#397650';
    ctx.fillRect(x + 10, groundY - 72, 48, 42);
    ctx.fillRect(x + 1, groundY - 60, 66, 27);
    ctx.fillStyle = '#579763';
    ctx.fillRect(x + 16, groundY - 84, 36, 27);
    ctx.fillRect(x + 7, groundY - 69, 18, 15);
    ctx.fillRect(x + 43, groundY - 66, 18, 15);
    ctx.fillStyle = '#80b57b';
    ctx.fillRect(x + 25, groundY - 90, 18, 12);
    ctx.fillRect(x + 13, groundY - 78, 15, 9);
  }
}

function draw() {
  ctx.imageSmoothingEnabled = false;

  // 背景は空＋草原＋大小2種類の木のみ。山・城・石畳は置かない。
  ctx.fillStyle = '#93c6dc';
  ctx.fillRect(0, 0, WIDTH, GROUND - 7);

  // 障害物より奥に流れる、ランダムな木
  for (const tree of trees) drawTree(tree);

  ctx.fillStyle = '#4b9153';
  ctx.fillRect(0, GROUND - 7, WIDTH, 7);
  ctx.fillStyle = '#6dad5f';
  ctx.fillRect(0, GROUND, WIDTH, 13);
  ctx.fillStyle = '#766044';
  ctx.fillRect(0, GROUND + 13, WIDTH, HEIGHT - GROUND - 13);
  ctx.fillStyle = '#886c4d';
  ctx.fillRect(0, GROUND + 19, WIDTH, 4);

  // プレイヤーと敵の画像はCanvas上のimgレイヤーで描画。
  for (const obj of objects) {
    if (obj.type === 'obstacle') {
      drawPixelTriangle(obj.x, GROUND, obj.w, obj.h);
    } else if (!enemyGifReady) {
      // ファイルを消した場合のみ一時的な仮表示。
      ctx.fillStyle = '#47672b';
      ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
    }
  }

  drawAttackEffect();
  drawParticles();

  if (state !== 'playing') {
    ctx.fillStyle = 'rgba(9, 20, 35, 0.72)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f5f5f2';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 36px monospace';
    ctx.fillText(state === 'ready' ? 'JUMP & SLASH' : 'GAME OVER', WIDTH / 2, 99);
    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = '#b9d4e8';
    ctx.fillText(state === 'ready' ? 'ボタンかキーでスタート' :
      `SCORE ${score} - ボタンかキーで再挑戦`, WIDTH / 2, 145);
  }
  syncSprites();
}

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.04);
  lastTime = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
