const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

let rid = localStorage.getItem('game_room_id') || '';
let isHost = false;
let currentQuestion = '';
let hasSubmitted = false;
let gameMode = 'ichimitsu';
const userId = localStorage.getItem('game_user_id') || (`user_${Math.random().toString(36).slice(2)}`);
localStorage.setItem('game_user_id', userId);

let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 10;

function text(value) {
    return typeof value === 'string' ? value : '';
}

function show(id) {
    document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function setBanner(id, message) {
    const banner = document.getElementById(id);
    if (banner) {
        banner.textContent = message || '';
        banner.classList.toggle('hidden', !message);
    }
}

function renderWaitMembers(members, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = '';
    members.forEach((member) => {
        const item = document.createElement('div');
        item.className = `wait-card ${member.isOnline ? '' : 'offline'}`.trim();
        item.append(document.createTextNode(member.name || '名無し'));
        if (!member.isOnline) {
            const offline = document.createElement('small');
            offline.textContent = ' (離脱中)';
            item.appendChild(offline);
        }
        if (member.isHost) {
            const badge = document.createElement('span');
            badge.className = 'host-badge';
            badge.textContent = '担当';
            item.appendChild(badge);
        }
        target.appendChild(item);
    });
}

function renderReadyMembers(members) {
    const target = document.getElementById('game-ready-list');
    if (!target) return;
    target.innerHTML = '';
    members.forEach((member) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        const order = document.createElement('div');
        order.className = 'order-badge';
        order.textContent = String(member.order || '');
        const name = document.createElement('div');
        name.className = 'player-name';
        name.textContent = member.name || '名無し';
        const ready = document.createElement('div');
        ready.className = 'ready-tag';
        ready.textContent = '✓ 回答済';
        card.append(order, name, ready);
        target.appendChild(card);
    });
}

function renderResults(results, question, answeredCount, totalCount, gameMode) {
    const questionEl = document.getElementById('result-question-text');
    if (questionEl) questionEl.textContent = question || '（お題なし）';
    
    const target = document.getElementById('result-list');
    if (!target) return;
    target.innerHTML = '';
    
    results.forEach((result) => {
        const card = document.createElement('div');
        card.className = 'result-card';
        
        // デンポーの場合は番号を表示
        if (gameMode === 'denpo' && result.order) {
            const orderEl = document.createElement('span');
            orderEl.style.cssText = 'background:#f9d71c;color:#333;border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;flex-shrink:0;';
            orderEl.textContent = result.order || '';
            card.appendChild(orderEl);
        }
        
        const name = document.createElement('b');
        name.textContent = result.name || '名無し';
        card.appendChild(name);
        card.append(` ${result.answer || '(未回答)'}`);
        target.appendChild(card);
    });
    
    // 回答状況を表示
    const statusText = `回答：${answeredCount}/${totalCount}人`;
    setBanner('result-message-count', statusText);
}

function updateAnswerUi(readyCount, totalCount) {
    const submitBtn = document.getElementById('submit-btn');
    const ansArea = document.getElementById('ans-area');
    const openBtn = document.getElementById('open-btn');
    const forceOpenBtn = document.getElementById('force-open-btn');
    
    if (submitBtn) submitBtn.disabled = hasSubmitted || !currentQuestion || !isConnected;
    if (ansArea) ansArea.classList.toggle('hidden', hasSubmitted || !currentQuestion || !isConnected);
    if (openBtn) openBtn.classList.toggle('hidden', !isHost || readyCount === 0 || !currentQuestion);
    if (forceOpenBtn) forceOpenBtn.classList.toggle('hidden', !isHost || readyCount === 0 || !currentQuestion);
    
    if (!currentQuestion) {
        setBanner('game-status', 'ホストがお題を入力するまでお待ちください。');
    } else {
        setBanner('game-status', `回答済み: ${readyCount} / ${totalCount}`);
    }
}

function join() {
    const name = text(document.getElementById('input-name').value).trim();
    const roomInput = text(document.getElementById('input-room').value).trim();
    if (!name || !roomInput) {
        alert('名前と部屋番号を入力してください');
        return;
    }
    if (!isConnected) {
        alert('サーバーに接続していません。しばらく待ってからお試しください。');
        return;
    }
    rid = roomInput;
    localStorage.setItem('game_user_name', name);
    localStorage.setItem('game_room_id', rid);
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.disabled = true;
    socket.emit('join-room', { name, rid, userId, gameMode });
}

socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
    isConnected = true;
    connectionRetries = 0;
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.disabled = false;
    const statusEl = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    if (statusEl && statusText) {
        statusEl.classList.remove('disconnected');
        statusEl.classList.add('connected');
        statusText.textContent = '✓ サーバーに接続中';
    }
    const savedName = localStorage.getItem('game_user_name');
    if (savedName && rid) {
        console.log('Auto-rejoin room:', rid);
        socket.emit('join-room', { name: savedName, rid, userId, gameMode });
    }
});

socket.on('disconnect', () => {
    console.log('Socket disconnected');
    isConnected = false;
    setBanner('game-status', '通信が切断されました。再接続を試みています…');
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.disabled = true;
    const statusEl = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    if (statusEl && statusText) {
        statusEl.classList.remove('connected');
        statusEl.classList.add('disconnected');
        statusText.textContent = '✗ サーバーに接続中...';
    }
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    connectionRetries++;
    if (connectionRetries > MAX_RETRIES) {
        setBanner('game-status', '通信に問題があります。ページを再読み込みしてください。');
    }
});

socket.on('room-data', (data) => {
    if (!data || !data.rid) {
        console.warn('Invalid room-data received');
        return;
    }
    isHost = (userId === data.hostId);
    currentQuestion = data.hasQuestion ? text(data.currentQuestion) : '';
    gameMode = data.gameMode || 'ichimitsu';
    const headerText = document.getElementById('header-text');
    if (headerText) headerText.innerText = `部屋: ${data.rid}`;
    const lobbyView = document.getElementById('view-lobby');
    if (lobbyView && !lobbyView.classList.contains('hidden') && data.rid) {
        show('view-wait-room');
    }
    renderWaitMembers(data.allMembers || [], 'all-member-list');
    renderReadyMembers(data.readyMembers || []);
    updateAnswerUi((data.readyMembers || []).length, data.totalMemberCount || 0);
    const hostBtn = document.getElementById('host-start-btn');
    if (hostBtn) hostBtn.classList.toggle('hidden', !(isHost && data.status === 'waiting'));
    const resultView = document.getElementById('view-result');
    if (currentQuestion && resultView && !resultView.classList.contains('hidden')) {
        const nextBtn = document.getElementById('next-btn');
        if (nextBtn) nextBtn.classList.add('hidden');
    }
    if (data.status === 'playing' && data.hasQuestion) {
        const currentView = document.querySelector('.view:not(.hidden)');
        if (currentView && currentView.id !== 'view-game' && currentView.id !== 'view-result') {
            console.log('Auto-transitioning to game view due to game in progress');
            hasSubmitted = false;
            show('view-game');
        }
    }
});

socket.on('move-to-setup', () => {
    hasSubmitted = false;
    currentQuestion = '';
    const ansInput = document.getElementById('input-ans');
    if (ansInput) ansInput.value = '';
    show('view-setup');
});

socket.on('move-to-waiting', () => {
    hasSubmitted = false;
    currentQuestion = '';
    const qInput = document.getElementById('input-manual-q');
    const ansInput = document.getElementById('input-ans');
    if (qInput) qInput.value = '';
    if (ansInput) ansInput.value = '';
    show('view-wait-room');
});

socket.on('receive-question', (data) => {
    hasSubmitted = false;
    currentQuestion = text(data.question);
    const currentQEl = document.getElementById('current-q');
    if (currentQEl) currentQEl.innerText = currentQuestion;
    const ansInput = document.getElementById('input-ans');
    if (ansInput) ansInput.value = '';
    const readyList = document.getElementById('game-ready-list');
    const totalCount = readyList ? readyList.children.length : 0;
    updateAnswerUi(0, totalCount);
    show('view-game');
});

socket.on('show-result', (data) => {
    show('view-result');
    
    if (gameMode === 'ichimitsu') {
        // 全員一致: 全員一致したか判定を表示
        setBanner('result-message', data.isMatch ? '✨ 全員一致 ✨' : '❌ 不一致 ❌');
    } else {
        // デンポー: 回答人数のみ表示
        setBanner('result-message', '');
    }
    
    renderResults(data.results || [], currentQuestion, data.answeredCount || 0, data.totalCount || 0, gameMode);
    const nextBtn = document.getElementById('next-btn');
    if (nextBtn) nextBtn.classList.toggle('hidden', !isHost);
});

socket.on('prepare-next-round', () => {
    hasSubmitted = false;
    currentQuestion = '';
    const ansInput = document.getElementById('input-ans');
    const qInput = document.getElementById('input-manual-q');
    const currentQEl = document.getElementById('current-q');
    const nextBtn = document.getElementById('next-btn');
    if (ansInput) ansInput.value = '';
    if (qInput) qInput.value = '';
    if (currentQEl) currentQEl.innerText = 'お題を待っています…';
    if (nextBtn) nextBtn.classList.add('hidden');
    if (isHost) show('view-setup');
    else show('view-setup');
});

function goToGameModeSelect() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    show('view-game-mode');
}

function selectGameMode(mode) {
    gameMode = mode;
    socket.emit('go-to-setup', { rid, userId });
}

function backToWaiting() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    socket.emit('back-to-waiting', { rid, userId });
}

function startGame() {
    const q = text(document.getElementById('input-manual-q').value).trim();
    if (!q) {
        alert('お題を入力してください');
        return;
    }
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    socket.emit('send-question', { rid, userId, question: q });
}

function submitAns() {
    const ans = text(document.getElementById('input-ans').value).trim();
    if (!ans) {
        alert('答えを入力してください');
        return;
    }
    
    // デンポーの場合はカタカナチェック
    if (gameMode === 'denpo') {
        const katakanaRegex = /^[\u30A0-\u30FF]+$/;
        if (!katakanaRegex.test(ans)) {
            alert('デンポーではカタカナのみ入力できます');
            document.getElementById('input-ans').value = '';
            return;
        }
    }
    
    if (!currentQuestion || hasSubmitted) {
        return;
    }
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    hasSubmitted = true;
    socket.emit('submit-answer', { rid, userId, answer: ans });
    document.getElementById('input-ans').value = '';
}

function openAll() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    if (gameMode === 'ichimitsu') {
        socket.emit('host-judge', { rid, userId });
    } else {
        socket.emit('denpo-judge', { rid, userId });
    }
}

function nextRound() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    socket.emit('next-round', { rid, userId });
}

function leaveRoom() {
    if (!rid) {
        localStorage.removeItem('game_room_id');
        localStorage.removeItem('game_user_name');
        location.reload();
        return;
    }
    if (!isConnected) {
        localStorage.removeItem('game_room_id');
        location.reload();
        return;
    }
    socket.emit('leave-room', { rid, userId });
    localStorage.removeItem('game_room_id');
}

socket.on('left-success', () => {
    localStorage.removeItem('game_room_id');
    localStorage.removeItem('game_user_name');
    location.reload();
});

socket.on('error-msg', (msg) => {
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.disabled = false;
    alert(msg);
    hasSubmitted = false;
});

window.onload = () => {
    const savedName = localStorage.getItem('game_user_name');
    const nameInput = document.getElementById('input-name');
    const roomInput = document.getElementById('input-room');
    if (savedName && nameInput) nameInput.value = savedName;
    if (rid && roomInput) roomInput.value = rid;
    updateAnswerUi(0, 0);
};