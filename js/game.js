// ============================================================
// 0. 音乐播放器
// ============================================================
// 在线音乐列表从 assets/music/manifest.json 加载，加新歌只需编辑该JSON
// 缓存版本号：更新音乐文件后修改此值，强制浏览器重新下载
const MUSIC_CACHE_VERSION = '20260823k';
let musicList = [];
let audio = null;
let currentMusicIndex = -1;
let currentPlaySrc = ''; // 当前播放的src（相对路径或blob URL）
let isMusicPlaying = false;
let musicWaitingForInteraction = false; // 自动播放被浏览器阻止时，等用户第一次交互后恢复
let currentPlayingSource = 'online'; // 当前播放的来源 online / local
let musicShuffleOrder = [];
let musicShufflePos = 0;
const musicMetaCache = {}; // 缓存ID3解析结果
let localMusicList = []; // 本地添加的歌曲
let currentMusicTab = 'online'; // 当前播放列表tab: online / local
let db = null; // IndexedDB用于持久化本地音乐
let currentScreen = 'home'; // 当前屏幕（提前声明，避免bootApp中TDZ错误）

// 初始化IndexedDB
function initLocalMusicDB() {
    return new Promise((resolve) => {
        const req = indexedDB.open('localMusicDB', 1);
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('songs')) {
                database.createObjectStore('songs', {keyPath: 'id'});
            }
        };
        req.onsuccess = (e) => {
            db = e.target.result;
            loadLocalMusic();
            resolve();
        };
        req.onerror = () => { resolve(); };
    });
}

function loadLocalMusic() {
    if (!db) return;
    const tx = db.transaction('songs', 'readonly');
    const store = tx.objectStore('songs');
    const req = store.getAll();
    req.onsuccess = () => {
        localMusicList = req.result.map(song => ({
            id: song.id,
            name: song.name,
            url: URL.createObjectURL(song.blob)
        }));
    };
}

function saveLocalMusic(file) {
    return new Promise((resolve) => {
        if (!db) { resolve(null); return; }
        const id = Date.now() + '_' + file.name;
        const tx = db.transaction('songs', 'readwrite');
        const store = tx.objectStore('songs');
        store.put({id: id, name: file.name, blob: file});
        tx.oncomplete = () => {
            const song = {id: id, name: file.name, url: URL.createObjectURL(file)};
            resolve(song);
        };
        tx.onerror = () => resolve(null);
    });
}

function addLocalSongs(files) {
    const audioFiles = Array.from(files).filter(f => 
        /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name)
    );
    if (audioFiles.length === 0) return;
    Promise.all(audioFiles.map(f => saveLocalMusic(f))).then(results => {
        results.forEach(song => { if (song) localMusicList.push(song); });
        renderMusicList();
    });
}

function deleteLocalSong(id) {
    if (!db) return;
    const tx = db.transaction('songs', 'readwrite');
    tx.objectStore('songs').delete(id);
    localMusicList = localMusicList.filter(s => s.id !== id);
    if (currentPlayingSource === 'local') {
        currentMusicIndex = -1;
        audio.pause();
    }
    renderMusicList();
}

function deleteOnlineSong(index) {
    musicList.splice(index, 1);
    rebuildShuffleOrder(); // 删除后重建shuffle顺序，避免越界
    if (currentPlayingSource === 'online') {
        currentMusicIndex = -1;
        audio.pause();
    }
    renderMusicList();
}

function rebuildShuffleOrder() {
    musicShuffleOrder = [...Array(musicList.length).keys()];
    for (let i = musicShuffleOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [musicShuffleOrder[i], musicShuffleOrder[j]] = [musicShuffleOrder[j], musicShuffleOrder[i]];
    }
    musicShufflePos = 0;
}

// 从 manifest.json 加载在线音乐列表
async function loadMusicManifest() {
    try {
        const resp = await fetch('assets/music/manifest.json?v=' + MUSIC_CACHE_VERSION);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const list = await resp.json();
        if (Array.isArray(list) && list.length > 0) {
            musicList = list;
            rebuildShuffleOrder();
            console.log('已加载', musicList.length, '首在线音乐');
        }
    } catch (e) {
        console.warn('加载音乐列表失败，使用默认列表:', e);
        // 兜底默认列表
        musicList = [
            {src: 'assets/music/Copines.mp3', name: 'Copines'},
            {src: 'assets/music/The Other Side Of Paradise.mp3', name: 'The Other Side Of Paradise'},
        ];
        rebuildShuffleOrder();
    }
}

function initMusic() {
    const player = document.getElementById('music-player');
    initLocalMusicDB();
    if (musicList.length === 0 && localMusicList.length === 0) {
        // 仍然显示播放器，用户可以添加本地歌曲
    }
    audio = new Audio();
    audio.loop = false;
    // 用事件同步播放状态，避免手动设置不同步
    audio.addEventListener('play', () => {
        isMusicPlaying = true;
        document.getElementById('playIcon').innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
        document.getElementById('music-player').classList.add('playing');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        renderMusicList(); // 同步播放列表"正在播放"状态
    });
    audio.addEventListener('pause', () => {
        isMusicPlaying = false;
        document.getElementById('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
        document.getElementById('music-player').classList.remove('playing');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        renderMusicList(); // 同步播放列表"点击播放"状态
    });
    audio.addEventListener('ended', () => {
        nextMusic();
    });
    audio.addEventListener('error', (e) => {
        console.log('音乐加载失败:', e);
        isMusicPlaying = false;
        musicWaitingForInteraction = false;
        document.getElementById('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
        document.getElementById('music-player').classList.remove('playing');
    });
    // 自动播放被浏览器阻止时，用户第一次交互（点击/触摸/按键）后恢复播放
    const resumeOnInteract = () => {
        if (musicWaitingForInteraction && audio && currentMusicIndex >= 0) {
            musicWaitingForInteraction = false;
            audio.play().catch(() => { musicWaitingForInteraction = true; });
        }
    };
    document.addEventListener('click', resumeOnInteract);
    document.addEventListener('touchstart', resumeOnInteract);
    document.addEventListener('keydown', resumeOnInteract);
    rebuildShuffleOrder();
    // 初始化tab指示器位置
    setTimeout(updateMusicTabIndicator, 100);
}

// 图片预加载完成后调用：预解析ID3封面 + 自动播放
function startAutoPlay() {
    if (musicList.length === 0 || currentMusicIndex !== -1) return;
    const firstIdx = musicShuffleOrder[musicShufflePos];
    const firstItem = musicList[firstIdx];
    const firstSrc = getMusicSrc(firstItem);
    // 先解析第一首的ID3（封面/歌手/歌词），解析完再播放，确保封面和音乐同时出现
    parseMusicMeta(firstSrc, function() {
        if (currentMusicIndex !== -1) return; // 期间用户已手动播放
        playMusicAt(firstIdx);
        // 播放开始后，后台逐个预解析其余歌曲的ID3（不抢带宽）
        let i = 0;
        function preloadNext() {
            if (i >= musicList.length) return;
            const item = musicList[i];
            const src = getMusicSrc(item);
            i++;
            if (musicMetaCache[src.split('?')[0]]) { preloadNext(); return; }
            parseMusicMeta(src, function() { setTimeout(preloadNext, 200); });
        }
        preloadNext();
    });
}

function updateMusicPlayerVisibility() {
    const player = document.getElementById('music-player');
    if (!player) return;
    // 只在主页显示播放器，但音乐在所有页面都继续播放
    if (currentScreen === 'home') {
        player.style.display = 'flex';
    } else {
        player.style.display = 'none';
    }
}

function getMusicName(item) {
    if (typeof item === 'object' && item.name) return item.name;
    const path = typeof item === 'string' ? item : item.src;
    return getMusicNameBySrc(path);
}
function getMusicNameBySrc(src) {
    const filename = src.split('/').pop();
    return decodeURIComponent(filename.replace(/\.[^/.]+$/, ''));
}
function getMusicSrc(item) {
    const raw = typeof item === 'string' ? item : item.src;
    return encodeURI(raw) + '?v=' + MUSIC_CACHE_VERSION; // 缓存版本号，更新音乐后改版本号强制刷新
}
function getMusicCover(item) {
    if (typeof item === 'object' && item.cover) return item.cover;
    const path = typeof item === 'string' ? item : item.src;
    const base = path.replace(/\.[^/.]+$/, '');
    return base + '.jpg'; // 自动找同名jpg封面
}
// 检测同名封面图是否存在（jpg/png），存在则返回路径，否则返回null
function resolveMusicCover(item, callback) {
    if (typeof item === 'object' && item.cover) {
        callback(item.cover);
        return;
    }
    const path = typeof item === 'string' ? item : item.src;
    const base = path.replace(/\.[^/.]+$/, '');
    const candidates = [base + '.jpg', base + '.png', base + '.jpeg'];
    let idx = 0;
    function tryNext() {
        if (idx >= candidates.length) { callback(null); return; }
        const img = new Image();
        img.onload = () => callback(candidates[idx]);
        img.onerror = () => { idx++; tryNext(); };
        img.src = candidates[idx];
    }
    tryNext();
}
function playMusicAt(index) {
    if (!audio || musicList.length === 0) return;
    if (index < 0 || index >= musicList.length) return; // 越界保护
    currentMusicIndex = index;
    currentPlayingSource = 'online';
    const item = musicList[index];
    const src = getMusicSrc(item);
    currentPlaySrc = src; // 更新当前播放src，用于竞态保护
    const displayName = getMusicName(item);
    // 立即设置歌名（同步，不闪烁）
    document.getElementById('musicTitle').textContent = displayName;
    const artistEl = document.getElementById('musicArtist');
    if (artistEl) artistEl.textContent = '';
    setMusicCover(null); // 先清空旧封面
    // 0. 缓存命中：同步设置封面/歌手，确保和音乐同时出现
    const cached = musicMetaCache[src.split('?')[0]];
    if (cached) {
        if (cached.cover) setMusicCover(cached.cover);
        if (cached.artist && artistEl) artistEl.textContent = cached.artist;
    }
    // 1. 尝试同名封面图（最快，本地文件直接加载）
    resolveMusicCover(item, function(coverPath) {
        if (currentPlaySrc !== src) return; // 竞态保护：已切歌则丢弃
        if (coverPath) setMusicCover(coverPath);
    });
    // 2. 解析ID3（封面/歌手），缓存命中时同步回调
    let songMeta = cached || null;
    parseMusicMeta(src, function(meta) {
        if (currentPlaySrc !== src) return; // 竞态保护：已切歌则丢弃
        songMeta = meta;
        if (meta) {
            if (meta.cover) setMusicCover(meta.cover);
            if (meta.artist && artistEl) artistEl.textContent = meta.artist;
        }
        updateMediaSession(displayName, meta && meta.artist ? meta.artist : '', meta && meta.cover ? meta.cover : '');
    });
    // 3. 设置音频源并播放
    audio.src = src;
    musicWaitingForInteraction = false;
    audio.play().then(() => {
        if (currentPlaySrc !== src) return; // 竞态保护
        // 播放开始后再次设置媒体会话，确保系统控制面板显示信息
        updateMediaSession(displayName, songMeta && songMeta.artist ? songMeta.artist : '', songMeta && songMeta.cover ? songMeta.cover : '');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        renderMusicList(); // 更新播放列表高亮
    }).catch((err) => {
        if (currentPlaySrc !== src) return;
        // 自动播放被浏览器策略阻止，等用户第一次交互后恢复
        // （进入游戏后点击/触摸也会触发恢复，不中断加载）
        musicWaitingForInteraction = true;
        console.log('自动播放被阻止，等待用户交互后播放:', displayName);
    });
}
function parseMusicMetaManual(src, callback) {
    const cleanSrc = src.split('?')[0];
    const fetchUrl = cleanSrc.startsWith('http') || cleanSrc.startsWith('data:') ? cleanSrc : new URL(cleanSrc, window.location.href).href;
    const processBuffer = function(buffer) {
        try {
            const bytes = new Uint8Array(buffer);
            if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) { callback(null); return; }
            const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
            let pos = 10;
            let coverDataUrl = null;
            let title = '';
            let artist = '';
            while (pos < Math.min(tagSize + 10, bytes.length - 10)) {
                const frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
                if (frameId === '\x00\x00\x00\x00') break;
                const frameSize = (bytes[pos+4] << 24) | (bytes[pos+5] << 16) | (bytes[pos+6] << 8) | bytes[pos+7];
                if (frameSize <= 0 || pos + 10 + frameSize > bytes.length) break;
                const fd = bytes.slice(pos + 10, pos + 10 + frameSize);
                if (frameId === 'APIC') {
                    let p = 1;
                    let mimeEnd = p;
                    while (fd[mimeEnd] !== 0 && mimeEnd < fd.length) mimeEnd++;
                    const mime = new TextDecoder('ascii').decode(fd.slice(p, mimeEnd));
                    p = mimeEnd + 2;
                    let descEnd = p;
                    while (fd[descEnd] !== 0 && descEnd < fd.length) descEnd++;
                    const picData = fd.slice(descEnd + 1);
                    if (picData.length > 0) {
                        let binary = '';
                        for (let i = 0; i < picData.length; i += 8192) {
                            binary += String.fromCharCode.apply(null, picData.subarray(i, i + 8192));
                        }
                        coverDataUrl = 'data:' + (mime || 'image/jpeg') + ';base64,' + btoa(binary);
                    }
                } else if (frameId === 'TIT2' || frameId === 'TPE1') {
                    try {
                        const enc = fd[0];
                        let text = '';
                        if (enc === 1 || enc === 2) text = new TextDecoder('utf-16').decode(fd.slice(1)).replace(/\x00/g, '');
                        else text = new TextDecoder('utf-8').decode(fd.slice(1)).replace(/\x00/g, '');
                        if (frameId === 'TIT2') title = text;
                        else artist = text;
                    } catch(e) {}
                }
                pos += 10 + frameSize;
            }
            callback({title: title, artist: artist, cover: coverDataUrl});
        } catch(e) { callback(null); }
    };
    if (fetchUrl.startsWith('data:')) { callback(null); return; }
    if (fetchUrl.startsWith('blob:')) {
        fetch(fetchUrl).then(r => r.arrayBuffer()).then(processBuffer).catch(() => callback(null));
    } else {
        fetch(fetchUrl, {headers: {'Range': 'bytes=0-1048575'}}).then(r => r.arrayBuffer()).then(processBuffer).catch(() => {
            fetch(fetchUrl).then(r => r.arrayBuffer()).then(processBuffer).catch(() => callback(null));
        });
    }
}

function parseMusicMeta(src, callback, force) {
    if (musicMetaCache[src.split('?')[0]] && !force) {
        callback(musicMetaCache[src.split('?')[0]]);
        return;
    }
    // Use manual ID3v2 parser first (faster, no timeout, only downloads first 1MB)
    try {
        parseMusicMetaManual(src, function(meta) {
            if (meta && (meta.cover || meta.title || meta.artist)) {
                musicMetaCache[src.split('?')[0]] = meta;
                callback(meta);
            } else {
                // Fallback to jsmediatags
                parseMusicMetaFallback(src, callback);
            }
        });
    } catch(e) {
        parseMusicMetaFallback(src, callback);
    }
}

function parseMusicMetaFallback(src, callback) {
    if (typeof jsmediatags === 'undefined') {
        musicMetaCache[src.split('?')[0]] = {title: '', artist: '', cover: null};
        callback(null);
        return;
    }
    try {
        const doRead = (input) => {
            jsmediatags.read(input, {
                onSuccess: function(tag) {
                const meta = {
                    title: tag.tags.title || '',
                    artist: tag.tags.artist || '',
                    cover: null
                };
                let picture = tag.tags.picture;
                if (!picture && tag.tags.image) picture = tag.tags.image;
                if (!picture && tag.tags.metadataBlock) {
                    for (let i = 0; i < tag.tags.metadataBlock.length; i++) {
                        if (tag.tags.metadataBlock[i].picture) {
                            picture = tag.tags.metadataBlock[i].picture;
                            break;
                        }
                    }
                }
                if (picture && picture.data) {
                    try {
                        const uint8 = picture.data instanceof Uint8Array ? picture.data : picture.data instanceof ArrayBuffer ? new Uint8Array(picture.data) : new Uint8Array(Array.isArray(picture.data) ? picture.data : Array.from(picture.data));
                        let binary = '';
                        for (let i = 0; i < uint8.length; i += 8192) {
                            binary += String.fromCharCode.apply(null, uint8.subarray(i, i + 8192));
                        }
                        const mime = picture.format || picture.mime || 'image/jpeg';
                        meta.cover = 'data:' + mime + ';base64,' + btoa(binary);
                    } catch(e) {}
                }
                musicMetaCache[src.split('?')[0]] = meta;
                callback(meta);
            },
            onError: function() {
                musicMetaCache[src.split('?')[0]] = {title: '', artist: '', cover: null};
                callback(null);
            }
            });
        };
        if (src.startsWith('blob:')) {
            fetch(src).then(r => r.blob()).then(blob => doRead(blob)).catch(() => {
                musicMetaCache[src.split('?')[0]] = {title: '', artist: '', cover: null};
                callback(null);
            });
        } else {
            src = src.split('?')[0]; const absSrc = src.startsWith('http') || src.startsWith('data:') ? src : new URL(src, window.location.href).href;
            doRead(absSrc);
        }
    } catch(e) {
        musicMetaCache[src.split('?')[0]] = {title: '', artist: '', cover: null};
        callback(null);
    }
}

let _coverToken = 0;
function setMusicCover(coverPath) {
    const coverEl = document.querySelector('#music-player .music-cover');
    if (!coverEl) return;
    const myToken = ++_coverToken; // 竞态保护：旧封面的回调会被丢弃
    const doUpdate = () => {
        if (myToken !== _coverToken) return;
        if (!coverPath) {
            coverEl.innerHTML = '<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:rgba(255,255,255,0.4);fill:none;stroke-width:1.5;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
            coverEl.classList.remove('switching');
            return;
        }
        const img = document.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;';
        img.onerror = function() {
            if (myToken !== _coverToken) return;
            coverEl.innerHTML = '<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:rgba(255,255,255,0.4);fill:none;stroke-width:1.5;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
            coverEl.classList.remove('switching');
        };
        img.onload = function() {
            if (myToken !== _coverToken) return;
            coverEl.classList.remove('switching');
        };
        img.src = coverPath;
        coverEl.innerHTML = '';
        coverEl.appendChild(img);
    };
    // 切换动画：先淡出，更新后淡入
    coverEl.classList.add('switching');
    setTimeout(doUpdate, 120);
}

function toggleMusic() {
    playTap();
    if (!audio) return;
    const hasOnline = musicList.length > 0;
    const hasLocal = localMusicList.length > 0;
    if (!hasOnline && !hasLocal) return;
    if (currentMusicIndex === -1) {
        // 根据当前tab或可用列表选择首次播放源
        if (currentMusicTab === 'local' && hasLocal) {
            playLocalMusicAt(0);
        } else if (hasOnline) {
            playMusicAt(musicShuffleOrder[musicShufflePos]);
        } else {
            playLocalMusicAt(0);
        }
        return;
    }
    if (isMusicPlaying) {
        audio.pause();
    } else {
        audio.play();
    }
}

function nextMusic() {
    playNext();
    if (!audio) return;
    if (currentPlayingSource === 'local') {
        if (localMusicList.length > 0) {
            const nextIdx = (currentMusicIndex + 1) % localMusicList.length;
            playLocalMusicAt(nextIdx);
        } else if (musicList.length > 0) {
            currentPlayingSource = 'online';
            musicShufflePos = (musicShufflePos + 1) % musicShuffleOrder.length;
            playMusicAt(musicShuffleOrder[musicShufflePos]);
        }
    } else {
        if (musicList.length > 0) {
            musicShufflePos = (musicShufflePos + 1) % musicShuffleOrder.length;
            playMusicAt(musicShuffleOrder[musicShufflePos]);
        } else if (localMusicList.length > 0) {
            currentPlayingSource = 'local';
            playLocalMusicAt(0);
        }
    }
}

function prevMusic() {
    playPrev();
    if (!audio) return;
    if (currentPlayingSource === 'local') {
        if (localMusicList.length > 0) {
            const prevIdx = (currentMusicIndex - 1 + localMusicList.length) % localMusicList.length;
            playLocalMusicAt(prevIdx);
        } else if (musicList.length > 0) {
            currentPlayingSource = 'online';
            musicShufflePos = (musicShufflePos - 1 + musicShuffleOrder.length) % musicShuffleOrder.length;
            playMusicAt(musicShuffleOrder[musicShufflePos]);
        }
    } else {
        if (musicList.length > 0) {
            musicShufflePos = (musicShufflePos - 1 + musicShuffleOrder.length) % musicShuffleOrder.length;
            playMusicAt(musicShuffleOrder[musicShufflePos]);
        } else if (localMusicList.length > 0) {
            currentPlayingSource = 'local';
            playLocalMusicAt(localMusicList.length - 1);
        }
    }
}
function toggleMusicList() {
    playTap();
    const panel = document.getElementById('music-list-panel');
    if (!panel) return;
    if (panel.classList.contains('show')) {
        panel.classList.add('closing');
        setTimeout(() => {
            panel.classList.remove('show');
            panel.classList.remove('closing');
        }, 300);
    } else {
        panel.classList.add('show');
        renderMusicList();
        // 延迟更新指示器，等滑入动画完成位置稳定
        setTimeout(updateMusicTabIndicator, 350);
    }
}

let _isRenderingMusicList = false;
let _musicListNeedsRerender = false;
function renderMusicList() {
    const grid = document.getElementById('musicListGrid');
    if (!grid) return;
    if (_isRenderingMusicList) {
        _musicListNeedsRerender = true; // 标记需要重渲染，避免丢弃更新
        return;
    }
    _isRenderingMusicList = true;
    
    let html = '';
    const list = currentMusicTab === 'online' ? musicList : localMusicList;
    
    if (list.length === 0) {
        if (currentMusicTab === 'local') {
            html = '<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.4);font-size:13px;">还没有本地歌曲<br>点击下方按钮添加</div>';
        } else {
            html = '<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.4);font-size:13px;">暂无在线歌曲</div>';
        }
    }
    
    list.forEach((item, i) => {
        const isPlaying = (i === currentMusicIndex && isMusicPlaying && currentPlayingSource === currentMusicTab);
        let src, name, coverUrl, artist = '';
        if (currentMusicTab === 'online') {
            src = getMusicSrc(item);
            const meta = musicMetaCache[src.split('?')[0]];
            coverUrl = (meta && meta.cover) ? meta.cover : '';
            artist = (meta && meta.artist) ? meta.artist : '';
            name = getMusicName(item);
        } else {
            src = item.url;
            const meta = musicMetaCache[src.split('?')[0]];
            coverUrl = (meta && meta.cover) ? meta.cover : '';
            artist = (meta && meta.artist) ? meta.artist : '';
            name = item.name.replace(/\.[^/.]+$/, '');
        }
        const coverHtml = coverUrl 
            ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' 
            : '<span style="font-size:18px;">♫</span>';
        const delBtn = currentMusicTab === 'local' 
            ? '<div class="mli-delete" onclick="event.stopPropagation();deleteLocalSong(\'' + item.id + '\')">✕</div>' 
            : '';
        const statusText = isPlaying ? '正在播放' : (artist || '点击播放');
        html += '<div class="music-list-item' + (isPlaying ? ' active' : '') + '" onclick="playMusicFromList(\'' + currentMusicTab + '\',' + i + ')">' +
            '<div class="mli-cover">' + coverHtml + '</div>' +
            '<div class="mli-info"><div class="mli-name">' + name + '</div>' +
            '<div class="mli-status">' + statusText + '</div></div>' + delBtn + '</div>';
    });
    // 高度过渡动画
    const prevHeight = grid.offsetHeight;
    grid.innerHTML = html;
    const newHeight = grid.scrollHeight;
    if (prevHeight !== newHeight && prevHeight > 0) {
        grid.style.height = prevHeight + 'px';
        // 强制重排
        void grid.offsetHeight;
        grid.style.height = newHeight + 'px';
        const onEnd = () => {
            grid.style.height = '';
            grid.removeEventListener('transitionend', onEnd);
        };
        grid.addEventListener('transitionend', onEnd);
    }
    
    _isRenderingMusicList = false;
    updateMusicTabIndicator();
    // 如果期间有重渲染请求，立即再渲染一次
    if (_musicListNeedsRerender) {
        _musicListNeedsRerender = false;
        setTimeout(renderMusicList, 0);
    }
    // 异步解析未缓存的封面（用setTimeout避免同步递归）
    setTimeout(() => {
        list.forEach((item) => {
            const src = currentMusicTab === 'online' ? getMusicSrc(item) : item.url;
            if (!musicMetaCache[src.split('?')[0]]) {
                parseMusicMeta(src, function() { renderMusicList(); });
            }
        });
    }, 0);
}

function playMusicFromList(source, index) {
    playTap();
    currentPlayingSource = source;
    if (source === 'online') {
        playMusicAt(index);
    } else {
        playLocalMusicAt(index);
    }
    toggleMusicList();
}

function playLocalMusicAt(index) {
    if (!audio || localMusicList.length === 0) return;
    if (index < 0 || index >= localMusicList.length) return; // 越界保护
    currentMusicIndex = index;
    currentPlayingSource = 'local';
    const song = localMusicList[index];
    const src = song.url;
    currentPlaySrc = src; // 竞态保护用
    const displayName = song.name.replace(/\.[^/.]+$/, '');
    setMusicCover(null);
    document.getElementById('musicTitle').textContent = displayName;
    const artistEl = document.getElementById('musicArtist');
    if (artistEl) artistEl.textContent = '';
    // 缓存命中：同步设置封面/歌手
    const cached = musicMetaCache[src.split('?')[0]];
    if (cached) {
        if (cached.cover) setMusicCover(cached.cover);
        if (cached.artist && artistEl) artistEl.textContent = cached.artist;
    }
    // 解析ID3（封面/歌手），缓存命中时同步回调
    let songMeta = cached || null;
    parseMusicMeta(src, function(meta) {
        if (currentPlaySrc !== src) return; // 竞态保护
        songMeta = meta;
        if (meta) {
            if (meta.cover) setMusicCover(meta.cover);
            if (meta.artist && artistEl) artistEl.textContent = meta.artist;
        }
        updateMediaSession(displayName, meta && meta.artist ? meta.artist : '', meta && meta.cover ? meta.cover : '');
    });
    audio.src = src;
    musicWaitingForInteraction = false;
    audio.play().then(() => {
        if (currentPlaySrc !== src) return;
        // 播放开始后再次设置媒体会话，确保系统控制面板显示信息
        updateMediaSession(displayName, songMeta && songMeta.artist ? songMeta.artist : '', songMeta && songMeta.cover ? songMeta.cover : '');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        renderMusicList();
    }).catch((err) => {
        if (currentPlaySrc !== src) return;
        // 自动播放被阻止，等用户交互后恢复
        musicWaitingForInteraction = true;
        console.log('本地音乐自动播放被阻止，等待用户交互:', displayName);
    });
}

function updateMediaSession(title, artist, cover) {
    if (!('mediaSession' in navigator)) return;
    const artwork = [];
    if (cover) {
        artwork.push({ src: cover, sizes: '512x512', type: 'image/jpeg' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
        title: title || '未知歌曲',
        artist: artist || '未知歌手',
        album: '音乐播放器',
        artwork: artwork
    });
    // 媒体键事件
    navigator.mediaSession.setActionHandler('play', () => { audio.play(); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => { prevMusic(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => { nextMusic(); });
}

function updateMusicTabIndicator() {
    const indicator = document.getElementById('musicTabIndicator');
    const activeTab = document.querySelector('.music-tab.active');
    if (!indicator || !activeTab) return;
    const tabsRect = activeTab.parentElement.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    indicator.style.left = (tabRect.left - tabsRect.left) + 'px';
    indicator.style.width = tabRect.width + 'px';
}

function switchMusicTab(tab) {
    playClick();
    currentMusicTab = tab;
    document.querySelectorAll('.music-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    updateMusicTabIndicator();
    const addBtn = document.querySelector('.music-add-btn');
    if (addBtn) addBtn.style.display = (tab === 'local') ? 'flex' : 'none';
    renderMusicList();
}

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
        const paths = [];
        chars.forEach(c => {
            for (let i = 1; i <= 7; i++) {
                paths.push({key: c + i, path: getPhotoPath(c, i)});
            }
        });
        const total = paths.length;
        let loaded = 0;
        const startTime = Date.now();
        const MIN_TIME = 800; // 最短展示时间，避免进度条闪烁

        const bar = document.getElementById('loadingBar');
        const percent = document.getElementById('loadingPercent');

        function updateProgress() {
            loaded++;
            const pct = Math.min(Math.round((loaded / total) * 100), 100);
            bar.style.width = pct + '%';
            percent.textContent = pct + '%';
            if (loaded >= total) {
                // 确保加载界面至少展示MIN_TIME，避免一闪而过
                const elapsed = Date.now() - startTime;
                const wait = Math.max(0, MIN_TIME - elapsed);
                setTimeout(resolve, wait);
            }
        }

        function loadOne(item, retry) {
            const img = new Image();
            img.onload = function() {
                // 等待解码完成，确保canvas能立即绘制不出现"?"
                if (img.decode) {
                    img.decode().then(updateProgress).catch(updateProgress);
                } else {
                    updateProgress();
                }
            };
            img.onerror = function() {
                if (retry > 0) {
                    setTimeout(() => loadOne(item, retry - 1), 300);
                } else {
                    console.warn('图片加载失败:', item.path);
                    updateProgress();
                }
            };
            img.src = item.path;
            photoCache[item.key] = img;
        }

        paths.forEach(item => loadOne(item, 1));

        const timer = setTimeout(() => {
            if (loaded < total) {
                console.warn('预加载超时，强制完成，已加载:', loaded, '/', total);
                bar.style.width = '100%';
                percent.textContent = '100%';
                resolve();
            }
        }, 60000);

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
window.onerror = function(msg, url, line, col, error) {
    console.error('全局错误:', msg, url, line, col);
    const loading = document.getElementById('loading');
    if (loading) {
        loading.innerHTML = '<div style="text-align:center;padding:40px;color:#fff;"><div style="font-size:48px;margin-bottom:20px;">⚠️</div><div style="font-size:18px;margin-bottom:10px;">页面加载出错</div><div style="font-size:14px;color:#888;margin-bottom:20px;">' + msg + '</div><button onclick="location.reload()" style="padding:10px 30px;background:#fff;color:#000;border:none;border-radius:8px;font-size:16px;cursor:pointer;">刷新重试</button></div>';
    }
    return false;
};
async function bootApp() {
    try {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('loading').classList.add('active');
        // 提前初始化音乐，和图片预加载并行，不阻塞
        initMusic();
        updateMusicPlayerVisibility();
        // 并行：加载在线音乐列表 + 预加载图片
        const manifestPromise = loadMusicManifest();
        await preloadPhotos();
        await manifestPromise; // 确保音乐列表已加载
        document.getElementById('loading').classList.remove('active');
        document.getElementById('home').classList.add('active');
        currentScreen = 'home';
        updateLevelStatus();
        updateMusicPlayerVisibility();
        startAutoPlay(); // 图片加载完后再开始音乐自动播放，避免占用带宽
    } catch (e) {
        console.error('启动失败:', e);
        window.onerror(e.message);
    }
}
bootApp();

// ============================================================
// 3. 全局变量 & 工具
// ============================================================
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
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }
}

// 页面加载即创建 audioCtx，首次用户交互时恢复
document.addEventListener('DOMContentLoaded', () => {
    initAudio();
});
document.addEventListener('click', () => { initAudio(); }, { once: true });
document.addEventListener('touchstart', () => { initAudio(); }, { once: true });
document.addEventListener('keydown', () => { initAudio(); }, { once: true });

// 音效节流：快速连按时同一个音效 80ms 内不重复播放，避免叠加成噪音
const _lastSfxTime = {};
function sfxThrottle(name) {
    const now = (audioCtx ? audioCtx.currentTime * 1000 : Date.now());
    if (_lastSfxTime[name] && now - _lastSfxTime[name] < 80) return false;
    _lastSfxTime[name] = now;
    return true;
}

function playPop(freq) {
    freq = freq || 440;
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('pop')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.1);
        gain.gain.setValueAtTime(0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
    } catch (e) {}
}

function playMerge(level) {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('merge')) return;
    try {
        const t = audioCtx.currentTime;
        const base = 300 + level * 60;
        // 主音
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(base, t);
        osc1.frequency.exponentialRampToValueAtTime(base * 2, t + 0.2);
        gain1.gain.setValueAtTime(0.2, t);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(t);
        osc1.stop(t + 0.25);
        // 泛音
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(base * 2, t);
        osc2.frequency.exponentialRampToValueAtTime(base * 3, t + 0.15);
        gain2.gain.setValueAtTime(0.08, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(t);
        osc2.stop(t + 0.18);
    } catch (e) {}
}

function playWin() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('win')) return;
    try {
        const t = audioCtx.currentTime;
        const notes = [523, 659, 784, 1047, 1319];
        notes.forEach((f, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0, t + i * 0.08);
            gain.gain.linearRampToValueAtTime(0.18, t + i * 0.08 + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.35);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(t + i * 0.08);
            osc.stop(t + i * 0.08 + 0.35);
        });
    } catch (e) {}
}

// 主按钮音：开玩、确认 — 双音叠加，明亮有力量
function playPrimary() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('primary')) return;
    try {
        const t = audioCtx.currentTime;
        // 低音主体
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(523, t);
        osc1.frequency.exponentialRampToValueAtTime(784, t + 0.08);
        gain1.gain.setValueAtTime(0.18, t);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(t);
        osc1.stop(t + 0.18);
        // 高音泛音
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1047, t);
        osc2.frequency.exponentialRampToValueAtTime(1568, t + 0.06);
        gain2.gain.setValueAtTime(0.08, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(t);
        osc2.stop(t + 0.12);
    } catch (e) {}
}

// 普通点击音：导航、标签切换 — 轻快单音
function playClick() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('click')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(1175, t + 0.05);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.07);
    } catch (e) {}
}

// 卡片点击音：关卡、图鉴 — 有弹性的中低音
function playCard() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('card')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.exponentialRampToValueAtTime(660, t + 0.08);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.14);
    } catch (e) {}
}

// 轻触音：音乐控制、小按钮 — 极短轻音
function playTap() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('tap')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, t);
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.04);
    } catch (e) {}
}

// 返回/关闭音：低沉下降
function playBack() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('back')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, t);
        osc.frequency.exponentialRampToValueAtTime(392, t + 0.1);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.13);
    } catch (e) {}
}

// 失败音：低沉下降，带一点失落感
function playLose() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('lose')) return;
    try {
        const t = audioCtx.currentTime;
        // 主音：快速下降
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(440, t);
        osc1.frequency.exponentialRampToValueAtTime(110, t + 0.4);
        gain1.gain.setValueAtTime(0.15, t);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(t);
        osc1.stop(t + 0.45);
        // 低音铺垫
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(220, t);
        osc2.frequency.exponentialRampToValueAtTime(80, t + 0.5);
        gain2.gain.setValueAtTime(0.1, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(t);
        osc2.stop(t + 0.5);
    } catch (e) {}
}

// 下一首：轻快上升
function playNext() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('next')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, t);
        osc.frequency.exponentialRampToValueAtTime(990, t + 0.06);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.08);
    } catch (e) {}
}

// 上一首：轻快下降
function playPrev() {
    if (!soundEnabled || !audioCtx) return;
    if (!sfxThrottle('prev')) return;
    try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(990, t);
        osc.frequency.exponentialRampToValueAtTime(660, t + 0.06);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.08);
    } catch (e) {}
}

function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(name).classList.add('active');
    currentScreen = name;
    if (name === 'game') { resizeCanvas(); } else { stopGame(); }
    if (name === 'levelSelect') { updateLevelStatus(); }
    if (name === 'collection') { setTimeout(updateTabIndicator, 50); }
    updateMusicPlayerVisibility();
}

// ============================================================
// 4. 关卡解锁状态（老马老胖通关7级后解锁混合和鸡）
// ============================================================
function updateLevelStatus() {
    const unlocked = isUnlocked('ma', 7) || isUnlocked('pang', 7);

    // 隐藏关卡（混合挑战）
    const hiddenCard = document.getElementById('hiddenLevelCard');
    const hiddenDesc = document.getElementById('hiddenLevelDesc');
    const hiddenArrow = document.getElementById('hiddenArrow');
    const hiddenAvatar = document.getElementById('hiddenAvatar');
    if (unlocked) {
        hiddenCard.classList.remove('disabled');
        hiddenDesc.textContent = '老马老胖一起上，更难';
        hiddenArrow.textContent = '→';
        hiddenAvatar.textContent = '⚡';
        hiddenAvatar.style.fontSize = '32px';
    } else {
        hiddenCard.classList.add('disabled');
        hiddenDesc.textContent = '任意通关一人解锁';
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
        jiDesc.textContent = '鸡你太美';
        jiArrow.textContent = '→';
        // 显示图片，隐藏锁
        if (jiImg) {
            jiImg.src = 'assets/images/ji4.jpg';  // 确保路径正确
            jiImg.style.display = 'block';
        }
        if (jiLock) jiLock.style.display = 'none';
    } else {
        jiCard.classList.add('disabled');
        jiDesc.textContent = '任意通关一人解锁';
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
    playClick();
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    updateTabIndicator();
    renderCollection();
}
function updateTabIndicator() {
    const indicator = document.getElementById('tabIndicator');
    const activeTab = document.querySelector('#collection .tab.active');
    const tabsContainer = document.querySelector('#collection .tabs');
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
            '<div class="collection-name">' + (unlocked ? '帅照 ' + i : '还没解锁') + '</div>' +
            '</div>' +
            '<button class="download-btn" ' + (unlocked ? '' : 'disabled') + ' onclick="downloadPhoto(\'' + cl +
            '\', ' + i + ')">' +
            (unlocked ? '保存图片' : '还没解锁') + '</button>' +
            '</div>';
    }
    grid.innerHTML = html;
}

function showCollection() {
    playClick();
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
    const ext = src.split('.').pop(); // 使用实际文件扩展名
    const filename = 'dl_' + cl + level + '.' + ext;
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
    playCard();
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
    playBack();
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
let Engine, World, Bodies, Body, Events, Composite, Runner;
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
let winCharacter = ''; // 记录通关角色，用于保存高清海报
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
    if (!window.Matter) {
        alert('物理引擎加载失败，请刷新页面重试');
        return;
    }
    ({ Engine, World, Bodies, Body, Events, Composite, Runner } = Matter);
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
        activateNextBall(); // 提升为当前可操控球
    // 生成真正的下一个球（用于预览）
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
}

function spawnNextBallHidden() {
    const chars = ['ma', 'pang'];
    const character = chars[Math.floor(Math.random() * 2)];
    const level = Math.floor(Math.random() * 3) + 1;
    nextBall = { character, level };
}

function spawnNextBallJi() {
    const level = getRandomStartLevel();
    nextBall = { character: 'ji', level };
}
// 把预览的下一个球提升为当前可操控的球
function activateNextBall() {
    dropX = gameWidth / 2;
    currentBall = { ...nextBall, x: dropX, y: dropLineY };
    if (!(charPrefix === '' && currentCharacter === 'hidden')) {
        unlockPhoto(nextBall.character, nextBall.level);
    }
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
        // 把预览的下一个球提升为当前可操控球
                activateNextBall();
        // 生成新的下一个球（用于预览）
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
    winCharacter = character; // 记录通关角色，用于保存高清海报
    playWin();
    document.getElementById('winScore').textContent = score;
    document.getElementById('winPhoto').src = getPhotoPath(character, 7);
    document.getElementById('winOverlay').classList.add('show');
}

function triggerLose() {
    if (gameOver) return;
    gameOver = true;
    playLose();
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
let isEnteringGame = false;
function startGame(cl) {
    if (isEnteringGame) return; // 防止快速连点重复进入
    playPrimary();
    if (cl === 'hidden' || cl === 'ji') {
        if (!(isUnlocked('ma', 7) || isUnlocked('pang', 7))) {
            return;
        }
    }
    isEnteringGame = true;
    enterGame(cl);
}

function enterGame(cl) {
    currentCharacter = cl;
    const overlay = document.getElementById('transition-overlay');
    overlay.classList.remove('wipe-out');
    overlay.classList.add('wipe-in');
    setTimeout(() => {
        showScreen('game');
        if (cl === 'hidden') {
            // 混合关卡：过渡动画结束后弹提示框
            setTimeout(() => {
                overlay.classList.remove('wipe-in');
                overlay.classList.add('wipe-out');
                setTimeout(() => {
                    overlay.classList.remove('wipe-out');
                    showLevelHintModal('任意合成一人通关', function() {
                        isEnteringGame = false;
                        initGame(cl);
                    });
                }, 400);
            }, 200);
        } else {
            setTimeout(() => { isEnteringGame = false; initGame(cl); }, 50);
            setTimeout(() => {
                overlay.classList.remove('wipe-in');
                overlay.classList.add('wipe-out');
                setTimeout(() => overlay.classList.remove('wipe-out'), 400);
            }, 200);
        }
    }, 350);
}

function restartGame() { playPrimary(); initGame(currentCharacter); }

function backToLevelSelect() { isEnteringGame = false; playBack(); showScreen('levelSelect'); }

function toggleSound() {
    soundEnabled = !soundEnabled;
    if (soundEnabled) playTap();
    document.getElementById('soundOnIcon').style.display = soundEnabled ? '' : 'none';
    document.getElementById('soundOffIcon').style.display = soundEnabled ? 'none' : '';
}

function savePoster() {
    // 使用高清下载图，而非游戏展示用的低清图
    const dlPath = winCharacter ? getDownloadPath(winCharacter, 7) : '';
    const src = dlPath || document.getElementById('winPhoto').src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = '终极帅照.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// 关卡提示框
var _levelHintCallback = null;
function showLevelHintModal(text, callback) {
    var modal = document.getElementById('levelHintModal');
    var textEl = document.getElementById('levelHintText');
    if (modal && textEl) {
        textEl.textContent = text;
        _levelHintCallback = callback;
        modal.classList.add('show');
    }
}
function confirmLevelHint() {
    playPrimary();
    var modal = document.getElementById('levelHintModal');
    if (modal) modal.classList.remove('show');
    if (_levelHintCallback) {
        var cb = _levelHintCallback;
        _levelHintCallback = null;
        cb();
    }
}
function closeLevelHint() {
    playBack();
    isEnteringGame = false;
    var modal = document.getElementById('levelHintModal');
    if (modal) modal.classList.remove('show');
    _levelHintCallback = null;
}

// Toast 提示
function showToast(msg) {
    var old = document.querySelector('.toast-msg');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast-msg';
    t.textContent = msg;
    document.body.appendChild(t);
    void t.offsetWidth;
    setTimeout(function() { t.classList.add('show'); }, 20);
    setTimeout(function() {
        t.classList.remove('show');
        setTimeout(function() { if (t.parentNode) t.remove(); }, 300);
    }, 2200);
}

// 动态设置app高度，解决大屏/平板浏览器工具栏导致100vh偏大、界面偏下的问题
function setAppHeight() {
    const app = document.getElementById('app');
    if (!app) return;
    // 优先使用 visualViewport（更准确，排除浏览器工具栏），回退到 innerHeight
    var h = (window.visualViewport && window.visualViewport.height) ? window.visualViewport.height : window.innerHeight;
    app.style.height = h + 'px';
}
// 多次延迟重算，应对浏览器工具栏动态显示/隐藏
setAppHeight();
setTimeout(setAppHeight, 100);
setTimeout(setAppHeight, 500);
setTimeout(setAppHeight, 1000);
setTimeout(setAppHeight, 2000);
document.addEventListener('DOMContentLoaded', setAppHeight);
window.addEventListener('load', setAppHeight);
window.addEventListener('resize', () => {
    setAppHeight();
    if (currentScreen === 'game') { resizeCanvas(); }
    updateMusicTabIndicator();
    updateTabIndicator();
});
window.addEventListener('orientationchange', () => { setTimeout(setAppHeight, 300); setTimeout(setAppHeight, 600); });
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (runner) Runner.stop(runner);
    } else {
        if (currentScreen === 'game' && runner && !gameOver) {
            Runner.run(runner, engine);
        }
    }
});
