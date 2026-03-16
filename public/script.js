let isHost = false;

socket.on('room-data', (data) => {
    isHost = (socket.id === data.hostId); // 自分がホストか保持
    // ...（中略：メンバーリスト表示など）
});

// サーバーから「全員揃った」通知が来たら（ホストのみ受信）
socket.on('all-answered-notification', () => {
    if (isHost) {
        // ホストの画面に「判定ボタン」を出すなどの演出
        alert("全員の回答が揃いました！判定してください。");
    }
});

// ホストが判定ボタンを押す関数
function hostJudge(isMatch) {
    socket.emit('host-judge', { rid: currentRoom, isMatch: isMatch });
}

socket.on('show-result', (data) => {
    showView('view-result');
    const status = document.getElementById('result-status');
    const resultList = document.getElementById('result-list');

    status.innerText = data.isMatch ? "🎉 全員一致！" : "🤔 不一致...";
    status.style.color = data.isMatch ? "#28a745" : "#dc3545";

    // 回答リストを表示（ホストはこのリストを見て判定する）
    resultList.innerHTML = data.results.map(r => 
        `<li><strong>${r.name}:</strong> ${r.answer}</li>`
    ).join('');

    // 【追加】ホストだけに判定ボタンを表示する（まだ判定前の場合）
    if (isHost) {
        // 結果表示画面の下に判定用UIを差し込む
        const judgeUI = `
            <div id="host-controls">
                <p>ホスト判定：</p>
                <button onclick="hostJudge(true)" style="background:green">一致（成功）</button>
                <button onclick="hostJudge(false)" style="background:red">不一致（失敗）</button>
            </div>
        `;
        // すでにボタンがあれば追加しない
        if(!document.getElementById('host-controls')) {
            resultList.insertAdjacentHTML('afterend', judgeUI);
        }
    }
});