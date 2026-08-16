// ============================================================
// 1. 预加载 + 进度条（包含 'ji'）
// ============================================================
const photoCache = {};

function getPhotoPath(charLevel, level) {
    return 'assets/images/' + charLevel + level + '.jpg';
}

function preloadPhotos() {
    return new Promise((resolve) => {
        const chars = ['ma', 'pang', 'ji'];
        const total = chars.length * 7;
        let loaded = 0;

        const bar = document.getElementById('loadingBar');
        const percent = document.getElementById('loadingPercent');

        function updateProgress() {
            loaded++;
            const pct = Math.min(Math.round((loaded / total) * 100), 100);
            bar.style.width = pct + '%';
            percent.textContent = pct + '%';
            if (loaded >= total) {
                resolve();
            }
        }

        chars.forEach(c => {
            for (let i = 1; i <= 7; i++) {
                const img = new Image();
                img.onload = updateProgress;
                img.onerror = function() {
                    console.warn('图片加载失败:', getPhotoPath(c, i));
                    updateProgress();
                };
                img.src = getPhotoPath(c, i);
                photoCache[c + i] = img;
            }
        });

        const timer = setTimeout(() => {
            if (loaded < total) {
                console.warn('预加载超时，强制完成');
                bar.style.width = '100%';
                percent.textContent = '100%';
                resolve();
            }
        }, 30000);

        const origResolve = resolve;
        resolve = function() {
            clearTimeout(timer);
            origResolve();
        };
    });
}

// ============================================================
// 2. 页面启动
// ============================================================
async function bootApp() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('loading').classList.add('active');
    await preloadPhotos();
    document.getElementById('loading').classList.remove('active');
    document.getElementById('home').classList.add('active');
    currentScreen = 'home';
    updateLevelStatus();
}
bootApp();

// ============================================================
// 3. 全局变量 & 工具
// ============================================================
let currentScreen = 'home';
let currentCharacter = 'ma';
let soundEnabled = true;
let audioCtx = null;
let isHiddenMode = false;

const BALL_RADII = [20, 28, 38, 52, 70, 94, 124];
const SCORE_TABLE = [1, 3, 6, 10, 15, 21, 28];

function initAudio() {
    if (!audioCtx) {
        try { audioCtx = new(window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
    }
}

function playPop(freq) {
    freq = freq || 440;
    if (!soundEnabled || !audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.5, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {}
}

function playMerge(level) {
    if (!soundEnabled || !audioCtx) return;
    try {
        const base = 300 + level * 60;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(base, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(base * 2, audioCtx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
    } catch (e) {}
}

function playWin() {
    if (!soundEnabled || !audioCtx) return;
    try {
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0, audioCtx.currentTime + i * 0.1);
            gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + i * 0.1 + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + i * 0.1 + 0.3);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(audioCtx.currentTime + i * 0.1);
            osc.stop(audioCtx.currentTime + i * 0.1 + 0.3);
        });
    } catch (e) {}
}

function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(name).classList.add('active');
    currentScreen = name;
    if (name === 'game') { resizeCanvas(); } else { stopGame(); }
    if (name === 'levelSelect') {
        updateLevelStatus();
    }
    if (name === 'collection') {
        setTimeout(updateTabIndicator, 50);
    }
}

// ============================================================
// 4. 关卡解锁状态（老马老胖通关7级后解锁混合和鸡）
// ============================================================
function updateLevelStatus() {
    const unlocked = isUnlocked('ma', 7) && isUnlocked('pang', 7);

    // 隐藏关卡（混合挑战）
    const hiddenCard = document.getElementById('hiddenLevelCard');
    const hiddenDesc = document.getElementById('hiddenLevelDesc');
    const hiddenArrow = document.getElementById('hiddenArrow');
    const hiddenAvatar = document.getElementById('hiddenAvatar');
    if (unlocked) {
        hiddenCard.classList.remove('disabled');
        hiddenDesc.textContent = '双角色混合，挑战极限！';
        hiddenArrow.textContent = '→';
        hiddenAvatar.textContent = '⚡';
        hiddenAvatar.style.fontSize = '32px';
    } else {
        hiddenCard.classList.add('disabled');
        hiddenDesc.textContent = '同时通关老马和老胖解锁';
        hiddenArrow.textContent = '🔒';
        hiddenAvatar.textContent = '🔒';
        hiddenAvatar.style.fontSize = '28px';
    }

    // 鸡关卡：使用预置的图片和锁遮罩，只控制显隐
    const jiCard = document.getElementById('jiLevelCard');
    const jiDesc = document.getElementById('jiLevelDesc');
    const jiArrow = document.getElementById('jiArrow');
    const jiImg = document.getElementById('jiImg');          // 图片元素
    const jiLock = document.getElementById('jiLockOverlay'); // 锁遮罩

    if (unlocked) {
        jiCard.classList.remove('disabled');
        jiDesc.textContent = '独立鸡关卡，合成最帅鸡照';
        jiArrow.textContent = '→';
        // 显示图片，隐藏锁
        if (jiImg) {
            jiImg.src = 'assets/images/ji4.jpg';  // 确保路径正确
            jiImg.style.display = 'block';
        }
        if (jiLock) jiLock.style.display = 'none';
    } else {
        jiCard.classList.add('disabled');
        jiDesc.textContent = '同时通关老马和老胖解锁';
        jiArrow.textContent = '🔒';
        // 隐藏图片，显示锁
        if (jiImg) jiImg.style.display = 'none';
        if (jiLock) jiLock.style.display = 'flex';
    }
}

// ============================================================
// 5. localStorage 工具
// ============================================================
function isUnlocked(charLevel, level) {
    try { return localStorage.getItem('unlocked_' + charLevel + '_' + level) === '1'; } catch (e) { return false; }
}

function unlockPhoto(charLevel, level) {
    try { localStorage.setItem('unlocked_' + charLevel + '_' + level, '1'); } catch (e) {}
}

// ============================================================
// 6. 图鉴（包含 'ji'）
// ============================================================
let currentTab = 'ma';

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    updateTabIndicator();
    renderCollection();
}
function updateTabIndicator() {
    const indicator = document.getElementById('tabIndicator');
    const activeTab = document.querySelector('.tab.active');
    const tabsContainer = document.querySelector('.tabs');
    if (!indicator || !activeTab || !tabsContainer) return;
    const containerRect = tabsContainer.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    indicator.style.left = (tabRect.left - containerRect.left) + 'px';
    indicator.style.width = tabRect.width + 'px';
}

function renderCollection() {
    const grid = document.getElementById('collectionGrid');
    const cl = currentTab;
    let name = '';
    if (cl === 'ma') name = '老马';
    else if (cl === 'pang') name = '老胖';
    else if (cl === 'ji') name = '鸡';
    else name = '未知';
    let html = '';
    for (let i = 1; i <= 7; i++) {
        const unlocked = isUnlocked(cl, i);
        const src = getPhotoPath(cl, i);
        html += '<div class="collection-item">' +
            '<div class="collection-photo ' + (unlocked ? '' : 'locked') + '" ' +
            (unlocked ? 'onclick="openPhotoPreview(\'' + cl + '\',' + i + ')"' : '') + '>' +
            (unlocked ? '<img src="' + src + '" alt="' + name + '等级' + i + '">' : '?') +
            '</div>' +
            '<div class="collection-info">' +
            '<div class="collection-level">等级 ' + i + '</div>' +
            '<div class="collection-name">' + (unlocked ? '帅照 ' + i : '未解锁') + '</div>' +
            '</div>' +
            '<button class="download-btn" ' + (unlocked ? '' : 'disabled') + ' onclick="downloadPhoto(\'' + cl +
            '\', ' + i + ')">' +
            (unlocked ? '下载' : '未解锁') + '</button>' +
            '</div>';
    }
    grid.innerHTML = html;
}

function showCollection() {
    renderCollection();
    showScreen('collection');
}

// ---------- 下载功能（展示图与下载图可不同） ----------
function getDownloadPath(cl, level) {
    if (cl === 'ji') return 'assets/images/dl_' + cl + level + '.jpeg';
    if (cl === 'hidden') return getPhotoPath(cl, level);
    return 'assets/images/dl_' + cl + level + '.jpg';
}

function downloadPhoto(cl, level) {
    if (!isUnlocked(cl, level)) return;
    const src = getDownloadPath(cl, level);
    const filename = 'dl_' + cl + level + '.jpg';
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
// 图鉴图片旋转放大预览
function openPhotoPreview(cl, level) {
    if (!isUnlocked(cl, level)) return;
    const preview = document.getElementById('photo-preview');
    const img = document.getElementById('previewImg');
    const nameEl = document.getElementById('previewName');
    const levelEl = document.getElementById('previewLevel');
    let name = '';
    if (cl === 'ma') name = '老马';
    else if (cl === 'pang') name = '老胖';
    else if (cl === 'ji') name = '鸡';
    else name = '未知';
    img.src = getPhotoPath(cl, level);
    nameEl.textContent = name + ' 帅照';
    levelEl.textContent = '等级 ' + level;
    preview.classList.remove('closing');
    preview.classList.add('show');
}
function closePhotoPreview() {
    const preview = document.getElementById('photo-preview');
    preview.classList.add('closing');
    setTimeout(() => {
        preview.classList.remove('show');
        preview.classList.remove('closing');
    }, 380);
}

// ============================================================
// 7. Matter.js 游戏引擎
// ============================================================
const { Engine, World, Bodies, Body, Events, Composite, Runner } = Matter;
let engine, runner, world;
let canvas, ctx;
let gameWidth, gameHeight;
let walls = [];
let balls = [];
let currentBall = null;
let nextBall = { character: 'ma', level: 1 };
let score = 0;
let isDropping = false;
let gameOver = false;
let gameWon = false;
let dropX = 0;
let dropLineY = 100;
let charPrefix = 'ma';
let mergeFlashes = [];

function resizeCanvas() {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    gameWidth = window.innerWidth;
    gameHeight = window.innerHeight;
    canvas.width = gameWidth * dpr;
    canvas.height = gameHeight * dpr;
    canvas.style.width = gameWidth + 'px';
    canvas.style.height = gameHeight + 'px';
    ctx.scale(dpr, dpr);
    dropLineY = 120;
}

function initGame(cl) {
    charPrefix = (cl === 'hidden' || cl === 'ji') ? '' : cl;
    const isHiddenMode = (cl === 'hidden');
    const isJiMode = (cl === 'ji');
    score = 0;
    balls = [];
    mergeFlashes = [];
    isDropping = false;
    gameOver = false;
    gameWon = false;
    document.getElementById('scoreValue').textContent = '0';
    document.getElementById('winOverlay').classList.remove('show');
    document.getElementById('loseOverlay').classList.remove('show');

    if (engine) {
        World.clear(engine.world);
        Engine.clear(engine);
        if (runner) Runner.stop(runner);
    }

    resizeCanvas();
    engine = Engine.create();
    world = engine.world;
    engine.gravity.y = 1.2;

    const wallThickness = 60;
    const groundY = gameHeight - 20;
    const leftWall = Bodies.rectangle(-wallThickness / 2, gameHeight / 2, wallThickness, gameHeight * 2, { isStatic: true });
    const rightWall = Bodies.rectangle(gameWidth + wallThickness / 2, gameHeight / 2, wallThickness, gameHeight * 2, { isStatic: true });
    const ground = Bodies.rectangle(gameWidth / 2, groundY + wallThickness / 2, gameWidth * 2, wallThickness, { isStatic: true });
    const topWall = Bodies.rectangle(gameWidth / 2, -wallThickness / 2, gameWidth * 2, wallThickness, { isStatic: true });
    walls = [leftWall, rightWall, ground, topWall];
    World.add(world, walls);

    // 初始化第一个球
    if (isHiddenMode) {
        spawnNextBallHidden();
    } else if (isJiMode) {
        spawnNextBallJi();
    } else {
        spawnNextBallNormal();
    }
    updateNextBallPreview();

    Events.on(engine, 'collisionStart', handleCollision);

    runner = Runner.create();
    Runner.run(runner, engine);
    requestAnimationFrame(render);
    bindInput();
}

function getRandomStartLevel() {
    return Math.floor(Math.random() * 3) + 1;
}

function spawnNextBallNormal() {
    const level = getRandomStartLevel();
    nextBall = { character: charPrefix, level };
    dropX = gameWidth / 2;
    currentBall = { ...nextBall, x: dropX, y: dropLineY };
    unlockPhoto(charPrefix, nextBall.level);
}

function spawnNextBallHidden() {
    const chars = ['ma', 'pang'];
    const character = chars[Math.floor(Math.random() * 2)];
    const level = Math.floor(Math.random() * 3) + 1;
    nextBall = { character, level };
    dropX = gameWidth / 2;
    currentBall = { ...nextBall, x: dropX, y: dropLineY };
    // 不自动解锁，由碰撞解锁
}

function spawnNextBallJi() {
    const level = getRandomStartLevel();
    nextBall = { character: 'ji', level };
    dropX = gameWidth / 2;
    currentBall = { ...nextBall, x: dropX, y: dropLineY };
    unlockPhoto('ji', nextBall.level);
}

function updateNextBallPreview() {
    const img = document.getElementById('nextBallImg');
    if (nextBall && nextBall.character) {
        img.src = getPhotoPath(nextBall.character, nextBall.level);
    } else {
        img.src = '';
    }
}

function dropBall() {
    if (isDropping || gameOver || !currentBall) return;
    isDropping = true;
    initAudio();
    playPop(300 + currentBall.level * 40);

    const { character, level } = currentBall;
    const r = BALL_RADII[level - 1];
    const ball = Bodies.circle(dropX, dropLineY, r, {
        restitution: 0.2,
        friction: 0.1,
        frictionAir: 0.005,
        density: 0.001,
        label: 'ball_' + level
    });
    ball.character = character;
    ball.gameLevel = level;
    ball.merged = false;
    World.add(world, ball);
    balls.push(ball);
    currentBall = null;

    setTimeout(() => {
        if (gameOver) return;
        isDropping = false;
        // 根据模式生成下一个
        if (charPrefix === '' && currentCharacter === 'hidden') {
            spawnNextBallHidden();
        } else if (charPrefix === '' && currentCharacter === 'ji') {
            spawnNextBallJi();
        } else {
            spawnNextBallNormal();
        }
        updateNextBallPreview();
        checkGameOver();
    }, 500);
}

function handleCollision(event) {
    const pairs = event.pairs;
    for (let pair of pairs) {
        const a = pair.bodyA;
        const b = pair.bodyB;
        if (a.gameLevel && b.gameLevel &&
            a.character && b.character &&
            a.character === b.character &&
            a.gameLevel === b.gameLevel &&
            !a.merged && !b.merged) {
            if (a.gameLevel >= 7) continue;
            a.merged = true;
            b.merged = true;
            const midX = (a.position.x + b.position.x) / 2;
            const midY = (a.position.y + b.position.y) / 2;
            const newLevel = a.gameLevel + 1;
            const character = a.character;
            const flashR = BALL_RADII[newLevel - 1];
            const particles = [];
            const pCount = 8 + Math.floor(newLevel * 1.5);
            for (let pi = 0; pi < pCount; pi++) {
                const angle = (Math.PI * 2 / pCount) * pi + Math.random() * 0.3;
                const speed = 1.5 + Math.random() * 2.5 + newLevel * 0.3;
                particles.push({
                    x: midX, y: midY,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed - 1,
                    r: 2 + Math.random() * 3 + newLevel * 0.3,
                    life: 1
                });
            }
            mergeFlashes.push({ x: midX, y: midY, r: flashR, life: 1, level: newLevel, particles: particles });
            setTimeout(() => {
                World.remove(world, a);
                World.remove(world, b);
                balls = balls.filter(bb => bb !== a && bb !== b);
                const r = BALL_RADII[newLevel - 1];
                const newBall = Bodies.circle(midX, midY, r, {
                    restitution: 0.2,
                    friction: 0.1,
                    frictionAir: 0.005,
                    density: 0.001,
                    label: 'ball_' + newLevel
                });
                newBall.character = character;
                newBall.gameLevel = newLevel;
                newBall.merged = false;
                Body.setVelocity(newBall, { x: (b.position.x - a.position.x) * 0.5, y: -2 });
                World.add(world, newBall);
                balls.push(newBall);
                score += SCORE_TABLE[newLevel - 1];
                const scoreEl = document.getElementById('scoreValue');
                scoreEl.textContent = score;
                scoreEl.classList.remove('pop');
                void scoreEl.offsetWidth;
                scoreEl.classList.add('pop');
                unlockPhoto(character, newLevel);
                playMerge(newLevel);
                if (newLevel === 7) {
                    setTimeout(() => triggerWin(character), 800);
                }
            }, 50);
            break;
        }
    }
}

function checkGameOver() {
    const dangerY = dropLineY + 20;
    let over = false;
    for (let ball of balls) {
        if (ball.position.y - BALL_RADII[ball.gameLevel - 1] < dangerY && Math.abs(ball.velocity.y) < 0.5) {
            over = true;
            break;
        }
    }
    if (over) { triggerLose(); }
}

function triggerWin(character) {
    if (gameWon) return;
    gameWon = true;
    gameOver = true;
    playWin();
    document.getElementById('winScore').textContent = score;
    document.getElementById('winPhoto').src = getPhotoPath(character, 7);
    document.getElementById('winOverlay').classList.add('show');
}

function triggerLose() {
    if (gameOver) return;
    gameOver = true;
    document.getElementById('loseScore').textContent = score;
    document.getElementById('loseOverlay').classList.add('show');
}

function stopGame() {
    if (runner) Runner.stop(runner);
}

function render() {
    if (currentScreen !== 'game') return;
    ctx.clearRect(0, 0, gameWidth, gameHeight);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.moveTo(0, dropLineY);
    ctx.lineTo(gameWidth, dropLineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 合成特效：粒子爆发 + 光环 + 中心闪光
    for (let i = mergeFlashes.length - 1; i >= 0; i--) {
        const f = mergeFlashes[i];
        const t = 1 - f.life; // 0→1
        ctx.save();
        // 中心闪光
        const coreR = f.r * (0.5 + t * 0.8);
        ctx.globalAlpha = f.life * 0.7;
        const coreGrad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, coreR);
        coreGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
        coreGrad.addColorStop(0.3, 'rgba(255,255,255,0.4)');
        coreGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.arc(f.x, f.y, coreR, 0, Math.PI * 2);
        ctx.fill();
        // 扩散光环（两层）
        for (let ring = 0; ring < 2; ring++) {
            const ringT = Math.min(1, t * 1.5 - ring * 0.2);
            if (ringT <= 0) continue;
            const ringR = f.r * (0.6 + ringT * 1.8);
            ctx.globalAlpha = (1 - ringT) * f.life * 0.6;
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 1.5 * (1 - ringT) + 0.5;
            ctx.beginPath();
            ctx.arc(f.x, f.y, ringR, 0, Math.PI * 2);
            ctx.stroke();
        }
        // 粒子
        if (f.particles) {
            for (const p of f.particles) {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.08; // 轻微重力
                p.vx *= 0.98;
                p.life -= 0.035;
                if (p.life <= 0) continue;
                ctx.globalAlpha = p.life * f.life;
                const pGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                pGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
                pGrad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = pGrad;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
        f.life -= 0.028;
        if (f.life <= 0) mergeFlashes.splice(i, 1);
    }

    for (let ball of balls) {
        drawBall(ball.position.x, ball.position.y, BALL_RADII[ball.gameLevel - 1], ball.character, ball.gameLevel);
    }

    if (currentBall && !gameOver) {
        drawBall(dropX, dropLineY, BALL_RADII[currentBall.level - 1], currentBall.character, currentBall.level);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(dropX, dropLineY + BALL_RADII[currentBall.level - 1]);
        ctx.lineTo(dropX, gameHeight - 20);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    requestAnimationFrame(render);
}

function drawBall(x, y, r, character, level) {
    const imgKey = character + level;
    const img = photoCache[imgKey];
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (img && img.complete && img.naturalWidth > 0) {
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const scale = Math.max((r * 2) / iw, (r * 2) / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
    } else {
        ctx.fillStyle = '#222';
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.fillStyle = '#555';
        ctx.font = (r * 0.6) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', x, y);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function bindInput() {
    const c = document.getElementById('gameCanvas');
    let dragging = false;

    function getX(e) {
        if (e.touches && e.touches[0]) return e.touches[0].clientX;
        if (e.clientX !== undefined) return e.clientX;
        return gameWidth / 2;
    }

    function onMove(e) {
        if (gameOver || !currentBall) return;
        const x = getX(e);
        const r = BALL_RADII[currentBall.level - 1];
        dropX = Math.max(r + 10, Math.min(gameWidth - r - 10, x));
    }

    function onDown(e) {
        initAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        dragging = true;
        onMove(e);
    }

    function onUp(e) {
        if (!dragging) return;
        dragging = false;
        if (!gameOver && currentBall) { dropBall(); }
    }

    c.ontouchstart = function(e) { e.preventDefault();
        onDown(e); };
    c.ontouchmove = function(e) { e.preventDefault();
        onMove(e); };
    c.ontouchend = function(e) { e.preventDefault();
        onUp(e); };
    c.onmousedown = function(e) { onDown(e); };
    c.onmousemove = function(e) { if (dragging) onMove(e); };
    c.onmouseup = function(e) { onUp(e); };
    c.onmouseleave = function(e) { if (dragging) onUp(e); };
}

// ============================================================
// 8. 游戏控制函数
// ============================================================
function startGame(cl) {
    if (cl === 'hidden' || cl === 'ji') {
        if (!(isUnlocked('ma', 7) && isUnlocked('pang', 7))) {
            return;
        }
    }
    currentCharacter = cl;
    // 关卡过渡动画
    const overlay = document.getElementById('transition-overlay');
    overlay.classList.remove('wipe-out');
    overlay.classList.add('wipe-in');
    setTimeout(() => {
        showScreen('game');
        setTimeout(() => initGame(cl), 50);
        setTimeout(() => {
            overlay.classList.remove('wipe-in');
            overlay.classList.add('wipe-out');
            setTimeout(() => overlay.classList.remove('wipe-out'), 400);
        }, 200);
    }, 350);
}

function restartGame() { initGame(currentCharacter); }

function backToLevelSelect() { showScreen('levelSelect'); }

function toggleSound() {
    soundEnabled = !soundEnabled;
    document.getElementById('soundOnIcon').style.display = soundEnabled ? '' : 'none';
    document.getElementById('soundOffIcon').style.display = soundEnabled ? 'none' : '';
}

function savePoster() {
    const winPhoto = document.getElementById('winPhoto');
    const src = winPhoto.src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = '终极帅照.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

window.addEventListener('resize', () => {
    if (currentScreen === 'game') { resizeCanvas(); }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (runner) Runner.stop(runner);
    } else {
        if (currentScreen === 'game' && runner && !gameOver) {
            Runner.run(runner, engine);
        }
    }
});