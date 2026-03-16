const socket = io();
let currentRoom = "";
let isHost = false;

function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function join() {
    const name = document.getElementById('input-name').value;
    currentRoom = document.getElementById('input-room').value;
    if (!name || !currentRoom) return alert("入力してください");
    socket.emit('join-room', { name, rid: currentRoom });
}

socket.on('room-data', (data) => {
    isHost = (socket.id === data.hostId);
    document.getElementById('display-room')?.innerText; // 予備
    
    // グリッドUIの更新
    const memberList = document.getElementById('member-list');
    memberList.innerHTML = data.members.map(m => `
        <div class="player-card ${m.isReady ? 'ready' : ''}">
            <div class="status-text">${m.isReady ? 'Ready' : 'READY'}</div>
            <div class="player-name">${m.name}</div>
        </div>
    `).join('');

    // ホスト権限のUI制御
    const qArea = document.getElementById('question-area');
    const hostQInput = document.getElementById('host-q-input');
    const playerAnsInput = document.getElementById('player-ans-input');
    const openBtn = document.getElementById('host-open-btn');

    if (isHost) {
        const allReady = data.members.every(m => m.isReady);
        // 全員揃ったらオープンボタン、そうでなければお題入力
        if (allReady && data.members.length > 0) {
            openBtn.classList.remove('hidden');
            hostQInput.classList.add('hidden');
            playerAnsInput.classList.add('hidden');
        } else {
            openBtn.classList.add('hidden');
            hostQInput.classList.remove('hidden');
            playerAnsInput.classList.add('hidden');
        }
    } else {
        // 子はお題を待つか回答するか
        hostQInput.classList.add('hidden');
        openBtn.classList.add('hidden');
    }

    if(!document.getElementById('view-lobby').classList.contains('hidden')) showView('view-game');
});

function sendQuestion() {
    const q = document.getElementById('input-question').value;
    if (!q) return alert("お題を入力してください");
    socket.emit('send-question', { rid: currentRoom, question: q });
}

socket.on('receive-question', (data) => {
    document.getElementById('question-area').innerText = `「${data.question}」といえば？`;
    // お題が出たら回答入力欄を表示（親以外）
    if (!isHost) {
        document.getElementById('player-ans-input').classList.remove('hidden');
    }
    showView('view-game');
});

function submitAnswer() {
    const ans = document.getElementById('input-answer').value;
    socket.emit('submit-answer', { rid: currentRoom, answer: ans });
    document.getElementById('player-ans-input').classList.add('hidden');
}

function hostJudge(isMatch) {
    socket.emit('host-judge', { rid: currentRoom, isMatch });
}

socket.on('show-result', (data) => {
    showView('view-result');
    const status = document.getElementById('result-status');
    status.innerText = data.isMatch ? "✨ 全員一致 ✨" : "❌ 不一致 ❌";
    document.getElementById('result-list').innerHTML = data.results.map(r => 
        `<div class="result-item"><strong>${r.name}:</strong> ${r.answer}</div>`
    ).join('');
    if (isHost) document.getElementById('next-btn').classList.remove('hidden');
});

function nextRound() {
    socket.emit('next-round', { rid: currentRoom });
}

socket.on('prepare-next-round', () => {
    document.getElementById('input-answer').value = "";
    document.getElementById('input-question').value = "";
    document.getElementById('question-area').innerText = "お題を入力してください";
    showView('view-game');
});