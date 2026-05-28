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
let isConnected = false;
let connectionRetries = 0;

const MAX_RETRIES = 10;

const userId =
    localStorage.getItem('game_user_id') ||
    `user_${Date.now()}_${Math.random().toString(36).slice(2)}`;

localStorage.setItem('game_user_id', userId);

function text(value) {
    return typeof value === 'string' ? value : '';
}

function getEl(id) {
    return document.getElementById(id);
}

function show(id) {
    document.querySelectorAll('.view').forEach((view) => {
        view.classList.add('hidden');
    });

    const target = getEl(id);
    if (target) {
        target.classList.remove('hidden');
    }
}

function setBanner(id, message) {
    const banner = getEl(id);

    if (!banner) return;

    banner.textContent = message || '';
    banner.classList.toggle('hidden', !message);
}

function normalizeGameMode(mode) {
    return mode === 'denpo' ? 'denpo' : 'ichimitsu';
}

function normalizeRoomId(value, maxLength = 20) {
    if (typeof value !== 'string') return '';

    const halfWidth = value
        .trim()
        .replace(/[０-９]/g, (char) =>
            String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
        );

    if (!/^\d+$/.test(halfWidth)) {
        return '';
    }

    const normalized = halfWidth.replace(/^0+(?=\d)/, '');

    return normalized.slice(0, maxLength);
}

function isKatakanaOnly(value) {
    return /^[\u30A0-\u30FF]+$/.test(value);
}

function getSubmissionKey(question = currentQuestion) {
    if (!rid || !question) return '';
    return `game_submitted_${rid}_${question}`;
}

function saveSubmittedState(question = currentQuestion) {
    const key = getSubmissionKey(question);
    if (!key) return;

    localStorage.setItem(key, '1');
}

function loadSubmittedState(question = currentQuestion) {
    const key = getSubmissionKey(question);
    if (!key) return false;

    return localStorage.getItem(key) === '1';
}

function clearSubmittedState(question = currentQuestion) {
    const key = getSubmissionKey(question);
    if (!key) return;

    localStorage.removeItem(key);
}

function updateConnectionStatus(connected) {
    const statusEl = getEl('connection-status');
    const statusText = getEl('status-text');

    if (!statusEl || !statusText) return;

    if (connected) {
        statusEl.classList.remove('disconnected');
        statusEl.classList.add('connected');
        statusText.textContent = '✓ サーバーに接続中';
    } else {
        statusEl.classList.remove('connected');
        statusEl.classList.add('disconnected');
        statusText.textContent = '✗ サーバーに接続中...';
    }
}

function renderWaitMembers(members, targetId) {
    const target = getEl(targetId);
    if (!target) return;

    const fragment = document.createDocumentFragment();

    (members || []).forEach((member) => {
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

        fragment.appendChild(item);
    });

    target.replaceChildren(fragment);

    const memberCountText = getEl('member-count-text');
    if (memberCountText) {
        memberCountText.textContent = `${(members || []).length}人参加中`;
    }
}

function renderReadyMembers(members) {
    const target = getEl('game-ready-list');
    if (!target) return;

    const fragment = document.createDocumentFragment();

    (members || []).forEach((member) => {
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
        fragment.appendChild(card);
    });

    target.replaceChildren(fragment);
}

function renderResults(results, question, answeredCount, totalCount, resultMode) {
    const questionEl = getEl('result-question-text');
    if (questionEl) {
        questionEl.textContent = question || '（お題なし）';
    }

    const target = getEl('result-list');
    if (!target) return;

    const fragment = document.createDocumentFragment();

    (results || []).forEach((result) => {
        const card = document.createElement('div');
        card.className = 'result-card';

        if (resultMode === 'denpo' && result.order) {
            const orderEl = document.createElement('span');
            orderEl.style.cssText =
                'background:#f9d71c;color:#333;border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;flex-shrink:0;';
            orderEl.textContent = String(result.order);
            card.appendChild(orderEl);
        }

        const name = document.createElement('b');
        name.textContent = result.name || '名無し';

        card.appendChild(name);
        card.append(` ${result.answer || '(未回答)'}`);

        fragment.appendChild(card);
    });

    target.replaceChildren(fragment);

    setBanner('result-message-count', `回答：${answeredCount}/${totalCount}人`);
}

function updateAnswerUi(readyCount, totalCount) {
    const submitBtn = getEl('submit-btn');
    const ansArea = getEl('ans-area');
    const openBtn = getEl('open-btn');
    const forceOpenBtn = getEl('force-open-btn');

    const canAnswer = Boolean(currentQuestion) && !hasSubmitted && isConnected;

    if (submitBtn) {
        submitBtn.disabled = !canAnswer;
    }

    if (ansArea) {
        ansArea.classList.toggle('hidden', !canAnswer);
    }

    const canHostOpen =
        isHost &&
        readyCount > 0 &&
        Boolean(currentQuestion) &&
        isConnected;

    if (openBtn) {
        openBtn.classList.toggle('hidden', !canHostOpen);
    }

    if (forceOpenBtn) {
        forceOpenBtn.classList.toggle('hidden', !canHostOpen);
    }

    if (!currentQuestion) {
        setBanner('game-status', 'ホストがお題を入力するまでお待ちください。');
    } else if (hasSubmitted) {
        setBanner('game-status', `回答済み: ${readyCount} / ${totalCount}`);
    } else {
        setBanner('game-status', `回答済み: ${readyCount} / ${totalCount}`);
    }
}

function join() {
    const nameInput = getEl('input-name');
    const roomInputEl = getEl('input-room');

    const name = text(nameInput ? nameInput.value : '').trim();
    const rawRoomInput = text(roomInputEl ? roomInputEl.value : '').trim();
    const roomInput = normalizeRoomId(rawRoomInput);

    if (!name || !roomInput) {
         alert('名前と数字の部屋番号を入力してください');
         return;
    }

    if (!isConnected) {
        alert('サーバーに接続していません。しばらく待ってからお試しください。');
        return;
    }

    rid = roomInput;

    localStorage.setItem('game_user_name', name);
    localStorage.setItem('game_room_id', rid);

    const joinBtn = getEl('join-btn');
    if (joinBtn) {
        joinBtn.disabled = true;
    }

    socket.emit('join-room', {
        name,
        rid,
        userId,
        gameMode
    });
}

socket.on('connect', () => {
    console.log('Socket connected:', socket.id);

    isConnected = true;
    connectionRetries = 0;

    const joinBtn = getEl('join-btn');
    if (joinBtn) {
        joinBtn.disabled = false;
    }

    updateConnectionStatus(true);

    const savedName = localStorage.getItem('game_user_name');
    const savedRoomId = localStorage.getItem('game_room_id');

    if (savedName && savedRoomId) {
        rid = savedRoomId;

        console.log('Auto-rejoin room:', rid);

        socket.emit('join-room', {
            name: savedName,
            rid,
            userId,
            gameMode
        });
    }
});

socket.on('disconnect', () => {
    console.log('Socket disconnected');

    isConnected = false;

    setBanner('game-status', '通信が切断されました。再接続を試みています…');

    const joinBtn = getEl('join-btn');
    if (joinBtn) {
        joinBtn.disabled = true;
    }

    updateConnectionStatus(false);

    updateAnswerUi(0, 0);
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

    rid = data.rid;
    localStorage.setItem('game_room_id', rid);

    isHost = userId === data.hostId;
    gameMode = normalizeGameMode(data.gameMode);

    const nextQuestion = data.hasQuestion ? text(data.currentQuestion) : '';

    if (currentQuestion !== nextQuestion) {
        currentQuestion = nextQuestion;
        hasSubmitted = loadSubmittedState(currentQuestion);

        const currentQEl = getEl('current-q');
        if (currentQEl) {
            currentQEl.innerText = currentQuestion || 'お題を待っています…';
        }
    } else {
        hasSubmitted = hasSubmitted || loadSubmittedState(currentQuestion);
    }

    const headerText = getEl('header-text');
    if (headerText) {
        headerText.innerText = `部屋: ${data.rid}`;
    }

    const lobbyView = getEl('view-lobby');
    if (lobbyView && !lobbyView.classList.contains('hidden') && data.rid) {
        show('view-wait-room');
    }

    renderWaitMembers(data.allMembers || [], 'all-member-list');
    renderReadyMembers(data.readyMembers || []);

    updateAnswerUi(
        (data.readyMembers || []).length,
        data.totalMemberCount || 0
    );

    const hostBtn = getEl('host-start-btn');
    if (hostBtn) {
        hostBtn.classList.toggle(
            'hidden',
            !(isHost && data.status === 'waiting')
        );
    }

    const resultView = getEl('view-result');
    if (currentQuestion && resultView && !resultView.classList.contains('hidden')) {
        const nextBtn = getEl('next-btn');
        if (nextBtn) {
            nextBtn.classList.add('hidden');
        }
    }

    if (data.status === 'playing' && data.hasQuestion) {
        const currentView = document.querySelector('.view:not(.hidden)');

        if (
            currentView &&
            currentView.id !== 'view-game' &&
            currentView.id !== 'view-result'
        ) {
            console.log('Auto-transitioning to game view due to game in progress');
            show('view-game');
        }
    }
});

socket.on('move-to-setup', () => {
    hasSubmitted = false;
    currentQuestion = '';

    const ansInput = getEl('input-ans');
    const currentQEl = getEl('current-q');

    if (ansInput) {
        ansInput.value = '';
    }

    if (currentQEl) {
        currentQEl.innerText = 'お題を待っています…';
    }

    show('view-setup');
});

socket.on('move-to-waiting', () => {
    hasSubmitted = false;
    currentQuestion = '';

    const qInput = getEl('input-manual-q');
    const ansInput = getEl('input-ans');
    const currentQEl = getEl('current-q');

    if (qInput) {
        qInput.value = '';
    }

    if (ansInput) {
        ansInput.value = '';
    }

    if (currentQEl) {
        currentQEl.innerText = 'お題を待っています…';
    }

    show('view-wait-room');
});

socket.on('receive-question', (data) => {
    const nextQuestion = text(data && data.question).trim();

    hasSubmitted = false;
    currentQuestion = nextQuestion;

    clearSubmittedState(currentQuestion);

    const currentQEl = getEl('current-q');
    if (currentQEl) {
        currentQEl.innerText = currentQuestion || 'お題を待っています…';
    }

    const ansInput = getEl('input-ans');
    if (ansInput) {
        ansInput.value = '';
    }

    updateAnswerUi(0, 0);

    show('view-game');
});

socket.on('show-result', (data) => {
    const resultMode = normalizeGameMode(
        data && data.gameMode ? data.gameMode : gameMode
    );

    gameMode = resultMode;

    show('view-result');

    if (resultMode === 'ichimitsu') {
        setBanner(
            'result-message',
            data && data.isMatch ? '✨ 全員一致 ✨' : '❌ 不一致 ❌'
        );
    } else {
        setBanner('result-message', '');
    }

    renderResults(
        data && data.results ? data.results : [],
        currentQuestion,
        data && typeof data.answeredCount === 'number' ? data.answeredCount : 0,
        data && typeof data.totalCount === 'number' ? data.totalCount : 0,
        resultMode
    );

    const nextBtn = getEl('next-btn');
    if (nextBtn) {
        nextBtn.classList.toggle('hidden', !isHost);
    }
});

socket.on('prepare-next-round', () => {
    hasSubmitted = false;
    currentQuestion = '';

    const ansInput = getEl('input-ans');
    const qInput = getEl('input-manual-q');
    const currentQEl = getEl('current-q');
    const nextBtn = getEl('next-btn');

    if (ansInput) {
        ansInput.value = '';
    }

    if (qInput) {
        qInput.value = '';
    }

    if (currentQEl) {
        currentQEl.innerText = 'お題を待っています…';
    }

    if (nextBtn) {
        nextBtn.classList.add('hidden');
    }

    show('view-setup');
});

function goToGameModeSelect() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    show('view-game-mode');
}

function selectGameMode(mode) {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    gameMode = normalizeGameMode(mode);

    socket.emit('go-to-setup', {
        rid,
        userId,
        gameMode
    });
}

function backToWaiting() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    socket.emit('back-to-waiting', {
        rid,
        userId
    });
}

function startGame() {
    const qInput = getEl('input-manual-q');
    const q = text(qInput ? qInput.value : '').trim();

    if (!q) {
        alert('お題を入力してください');
        return;
    }

    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    socket.emit('send-question', {
        rid,
        userId,
        question: q
    });
}

function submitAns() {
    const ansInput = getEl('input-ans');
    const submitBtn = getEl('submit-btn');

    const ans = text(ansInput ? ansInput.value : '').trim();

    if (!ans) {
        alert('答えを入力してください');
        return;
    }

    if (gameMode === 'denpo' && !isKatakanaOnly(ans)) {
        alert('デンポーではカタカナのみ入力できます');
        if (ansInput) {
            ansInput.value = '';
        }
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
    saveSubmittedState(currentQuestion);

    if (submitBtn) {
        submitBtn.disabled = true;
    }

    if (ansInput) {
        ansInput.value = '';
    }

    updateAnswerUi(0, 0);

    socket.emit('submit-answer', {
        rid,
        userId,
        answer: ans
    });
}

function openAll() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    if (gameMode === 'ichimitsu') {
        socket.emit('host-judge', {
            rid,
            userId
        });
    } else {
        socket.emit('denpo-judge', {
            rid,
            userId
        });
    }
}

function nextRound() {
    if (!isConnected) {
        alert('サーバーに接続していません');
        return;
    }

    socket.emit('next-round', {
        rid,
        userId
    });
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

    socket.emit('leave-room', {
        rid,
        userId
    });

    localStorage.removeItem('game_room_id');
}

socket.on('left-success', () => {
    localStorage.removeItem('game_room_id');
    localStorage.removeItem('game_user_name');
    location.reload();
});

socket.on('error-msg', (msg) => {
    const joinBtn = getEl('join-btn');
    const submitBtn = getEl('submit-btn');

    if (joinBtn) {
        joinBtn.disabled = false;
    }

    if (submitBtn) {
        submitBtn.disabled = false;
    }

    alert(msg);

    if (currentQuestion) {
        hasSubmitted = loadSubmittedState(currentQuestion);
    } else {
        hasSubmitted = false;
    }

    updateAnswerUi(0, 0);
});

window.onload = () => {
    const savedName = localStorage.getItem('game_user_name');
    const savedRoomId = localStorage.getItem('game_room_id');

    const nameInput = getEl('input-name');
    const roomInput = getEl('input-room');
    const roomInputForNumber = getEl('input-room');

    if (roomInputForNumber) {
        roomInputForNumber.inputMode = 'numeric';
        roomInputForNumber.pattern = '[0-9]*';

        roomInputForNumber.addEventListener('input', () => {
            const converted = roomInputForNumber.value.replace(/[０-９]/g, (char) =>
                String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
           );

            roomInputForNumber.value = converted.replace(/[^\d]/g, '');
        });
    }
    if (savedName && nameInput) {
        nameInput.value = savedName;
    }

    if (savedRoomId && roomInput) {
        rid = savedRoomId;
        roomInput.value = savedRoomId;
    }

    updateConnectionStatus(false);
    updateAnswerUi(0, 0);
};
