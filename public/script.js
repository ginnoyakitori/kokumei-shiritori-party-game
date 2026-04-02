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
let isJudging = false;
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
        ready.textContent = gameMode === 'denpo' ? '✓ ヒント入力済' : '✓ 回答済';
        card.append(order, name, ready);
        target.appendChild(card);
    });
}

function renderResults(results, question) {
    const questionEl = document.getElementById('result-question-text');
    if (questionEl) questionEl.textContent = question || '（お題なし）';
    const target = document.getElementById('result-list');
    if (!target) return;
    target.innerHTML = '';
    results.forEach((result) => {
        const card = document.createElement('div');
        card.className = 'result-card';
        const name = document.createElement('b');
        name.textContent = result.name || '名無し';
        card.appendChild(name);
        card.append(`: ${result.answer || '(未回答)'}`);
        target.appendChild(card);
    });
}

function updateAnswerUi(readyCount, totalCount) {
    const submitBtn = document.getElementById('submit-btn');
    const ansArea = document.getElementById('ans-area');
    const openBtn = document.getElementById('open-btn');
    const everyoneReady = totalCount > 0 && readyCount === totalCount;
    if (submitBtn) submitBtn.disabled = hasSubmitted || !currentQuestion || !isConnected;
    if (ansArea) ansArea.classList.toggle('hidden', hasSubmitted || !currentQuestion || !isConnected);
    if (openBtn) openBtn.classList.toggle('hidden', !isHost || !everyoneReady || !currentQuestion);
    if (!currentQuestion) {
        setBanner('game-status', 'ホストがお題を入力するまでお待ちください。');
    } else if (everyoneReady) {
        setBanner('game-status', isHost ? '全員が回答しました。結果を見る準備はいい？' : '全員が回答しました。結果を待っています。');
    } else {
        setBanner('game-status', `回答済み: ${readyCount} / ${totalCount}`);
    }
}

function updateHintInputUi(readyCount, totalCount) {
    const submitHintBtn = document.getElementById('submit-hint-btn');
    const hintArea = document.getElementById('hint-area');
    if (isHost) {
        if (hintArea) hintArea.classList.add('hidden');
        if (submitHintBtn) submitHintBtn.disabled = true;
    } else {
        if (submitHintBtn) submitHintBtn.disabled = hasSubmitted || !currentQuestion || !isConnected;
        if (hintArea) hintArea.classList.toggle('hidden', hasSubmitted || !currentQuestion || !isConnected);
    }
}

function join() {
    const name = text(document.getElementById('input-name').value).trim();
    const roomInput = text(document.getElementById('input-room').value).trim();
    if (!name || !roomInput) {
        alert('名前と部屋番号を入力してくだ���い');
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
    if (gameMode === 'denpo') {
        updateHintInputUi((data.readyMembers || []).length, data.totalMemberCount || 0);
    } else {
        updateAnswerUi((data.readyMembers || []).length, data.totalMemberCount || 0);
    }
    const hostBtn = document.getElementById('host-start-btn');
    if (hostBtn) hostBtn.classList.toggle('hidden', !(isHost && data.status === 'waiting'));
    const resultView = document.getElementById('view-result');
    if (currentQuestion && resultView && !resultView.classList.contains('hidden')) {
        const nextBtn = document.getElementById('next-btn');
        if (nextBtn) nextBtn.classList.add('hidden');
    }
    if (data.status === 'playing' && data.hasQuestion) {
        const currentView = document.querySelector('.view:not(.hidden)');
        if (currentView && currentView.id !== 'view-game' && currentView.id !== 'view-result' && 
            currentView.id !== 'view-hints-input' && currentView.id !== 'view-denpo-game') {
            console.log('Auto-transitioning to game view due to game in progress');
            hasSubmitted = false;
            if (gameMode === 'denpo') {
                show('view-hints-input');
            } else {
                show('view-game');
            }
        }
    }
});

socket.on('move-to-setup', () => {
    hasSubmitted = false;
    currentQuestion = '';
    const ansInput = document.getElementById('input-ans');
    const hintInput = document.getElementById('input-hint');
    if (ansInput) ansInput.value = '';
    if (hintInput) hintInput.value = '';
    if (isHost) show('view-setup');
    else show('view-setup');
});

socket.on('move-to-waiting', () => {
    hasSubmitted = false;
    currentQuestion = '';
    const qInput = document.getElementById('input-manual-q');
    const ansInput = document.getElementById('input-ans');
    const hintInput = document.getElementById('input-hint');
    if (qInput) qInput.value = '';
    if (ansInput) ansInput.value = '';
    if (hintInput) hintInput.value = '';
    show('view-wait-room');
});

socket.on('move-to-hints-input', (data) => {
    hasSubmitted = false;
    currentQuestion = text(data.question);
    const denpoQuestion = document.getElementById('denpo-question');
    if (denpoQuestion) denpoQuestion.innerText = currentQuestion;
    const hintInput = document.getElementById('input-hint');
    if (hintInput) hintInput.value = '';
    show('view-hints-input');
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

socket.on('ready-for-denpo-game', (data) => {
    const denpoGameQuestion = document.getElementById('denpo-game-question');
    if (denpoGameQuestion) denpoGameQuestion.innerText = currentQuestion;
    if (isHost) {
        const hintDisplay = document.getElementById('hint-display');
        if (hintDisplay && data.hints && data.hints.length > 0) {
            hintDisplay.innerText = `第1問のヒント: ${data.hints[0].hint}`;
            hintDisplay.classList.remove('hidden');
        }
        show('view-denpo-game');
    } else {
        show('view-denpo-game');
    }
});

socket.on('denpo-judge-prompt', (data) => {
    if (data.judgeId === userId) {
        isJudging = true;
        const judgePrompt = document.getElementById('judge-prompt');
        if (judgePrompt) {
            judgePrompt.innerHTML = `
                <div>親の答え: <strong>${data.parentAnswer}</strong></div>
                <div style="margin-top:10px; font-size:0.9rem;">ヒント ${data.hintIndex + 1}/${data.totalHints}</div>
                <div style="margin-top:15px; display:flex; gap:10px; justify-content:center;">
                    <button class="btn-pink" style="width:auto; margin:0; padding:10px 20px;" onclick="denpoJudge(true)">✓ 正解</button>
                    <button class="btn-white" style="width:auto; margin:0; padding:10px 20px;" onclick="denpoJudge(false)">✗ 不正解</button>
                </div>
            `;
            judgePrompt.classList.remove('hidden');
        }
    }
});

socket.on('denpo-next-hint', (data) => {
    const hintDisplay = document.getElementById('hint-display');
    if (hintDisplay) {
        hintDisplay.innerText = `第${data.hintOrder}問のヒント: ${data.hint}`;
        hintDisplay.classList.remove('hidden');
    }
    isJudging = false;
    const judgePrompt = document.getElementById('judge-prompt');
    if (judgePrompt) judgePrompt.classList.add('hidden');
});

socket.on('denpo-correct', (data) => {
    alert(`正解！\n親: +${data.hostPoints}点\nヒント提供者: +${data.hintProviderPoints}点`);
    socket.emit('host-judge', { rid, userId });
});

socket.on('denpo-hints-exhausted', () => {
    alert('ヒントがなくなりました。不正解です。');
    show('view-wait-room');
});

socket.on('show-result', (data) => {
    show('view-result');
    setBanner('result-message', data.isMatch ? '✨ 全員一致 ✨' : '❌ 不一致 ❌');
    renderResults(data.results || [], currentQuestion);
    const nextBtn = document.getElementById('next-btn');
    if (nextBtn) nextBtn.classList.toggle('hidden', !isHost);
});

socket.on('prepare-next-round', () => {
    hasSubmitted = false;
    currentQuestion = '';
    isJudging = false;
    const ansInput = document.getElementById('input-ans');
    const qInput = document.getElementById('input-manual-q');
    const hintInput = document.getElementById('input-hint');
    const denpoAnsInput = document.getElementById('input-denpo-ans');
    const currentQEl = document.getElementById('current-q');
    const denpoQEl = document.getElementById('denpo-game-question');
    const nextBtn = document.getElementById('next-btn');
    const hintDisplay = document.getElementById('hint-display');
    const judgePrompt = document.getElementById('judge-prompt');
    if (ansInput) ansInput.value = '';
    if (qInput) qInput.value = '';
    if (hintInput) hintInput.value = '';
    if (denpoAnsInput) denpoAnsInput.value = '';
    if (currentQEl) currentQEl.innerText = 'お題を待っています…';
    if (denpoQEl) denpoQEl.innerText = 'お題を待っています…';
    if (nextBtn) nextBtn.classList.add('hidden');
    if (hintDisplay) hintDisplay.classList.add('hidden');
    if (judgePrompt) judgePrompt.classList.add('hidden');
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

function submitHint() {
    const hint = text(document.getElementById('input-hint').value).trim();
    if (!hint) {
        alert('ヒントを入力してください');
        return;
    }
    if (!currentQuestion || hasSubmitted) {
        return;
    }
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    hasSubmitted = true;
    socket.emit('submit-hint', { rid, userId, hint });
    document.getElementById('input-hint').value = '';
}

function submitDenpoAnswer() {
    const ans = text(document.getElementById('input-denpo-ans').value).trim();
    if (!ans) {
        alert('答えを入力してください');
        return;
    }
    if (!currentQuestion || hasSubmitted) {
        return;
    }
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    hasSubmitted = true;
    socket.emit('denpo-submit-answer', { rid, userId, answer: ans });
    document.getElementById('input-denpo-ans').value = '';
}

function submitAns() {
    const ans = text(document.getElementById('input-ans').value).trim();
    if (!ans) {
        alert('答えを入力してください');
        return;
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
    socket.emit('host-judge', { rid, userId });
}

function denpoJudge(isCorrect) {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }
    socket.emit('denpo-judge', { rid, userId, isCorrect });
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