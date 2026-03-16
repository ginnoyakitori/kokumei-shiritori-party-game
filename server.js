const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

const rooms = {};

/**
 * 部屋のデータを全クライアントに同期する
 */
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room || !room.members) return;

    // メンバーがいない場合は削除
    if (room.members.length === 0) {
        delete rooms[rid];
        return;
    }

    // turnIndexが配列の範囲内に収まるように調整
    room.turnIndex = room.turnIndex % room.members.length;
    const host = room.members[room.turnIndex];

    const allMembers = room.members.map(m => ({
        id: m.id,
        name: m.name,
        isHost: m.id === (host ? host.id : null),
        isOnline: !!m.socketId
    }));

    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((m, i) => ({
            name: m.name,
            order: i + 1
        }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers,
        readyMembers: readyPlayers,
        totalMemberCount: room.members.length,
        status: room.status,
        hostId: host ? host.id : null
    });
}

io.on('connection', (socket) => {
    // --- 入室・復帰 ---
    socket.on('join-room', ({ name, rid, userId }) => {
        if (!rooms[rid]) {
            rooms[rid] = {
                turnIndex: 0,
                members: [],
                status: 'waiting'
            };
        }

        const room = rooms[rid];
        let player = room.members.find(m => m.id === userId);

        if (player) {
            // 再接続（スマホの切り替えやリロード）
            player.socketId = socket.id;
            if (name) player.name = name;
        } else {
            // 新規入室制限（ゲーム中かつ知らない人のみ拒否）
            if (room.status === 'playing') {
                return socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
            }
            player = {
                id: userId,
                socketId: socket.id,
                name,
                answer: null,
                readyAt: null
            };
            room.members.push(player);
        }

        socket.join(rid);
        updateRoomData(rid);
    });

    // --- ゲーム開始（画面遷移） ---
    socket.on('go-to-setup', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        room.status = 'playing';
        // 全員に画面遷移を命じる
        io.to(rid).emit('move-to-setup');
        // その後、最新の部屋状態（ホスト情報など）を同期
        updateRoomData(rid);
    });

    // --- 待機画面に戻る ---
    socket.on('back-to-waiting', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        room.status = 'waiting';
        io.to(rid).emit('move-to-waiting');
        updateRoomData(rid);
    });

    // --- お題送信 ---
    socket.on('send-question', ({ rid, question }) => {
        const room = rooms[rid];
        if (room) {
            // 新しいお題の時に回答をリセット
            room.members.forEach(m => { m.answer = null; m.readyAt = null; });
            io.to(rid).emit('receive-question', { question });
            updateRoomData(rid);
        }
    });

    // --- 回答提出 ---
    socket.on('submit-answer', ({ rid, userId, answer }) => {
        const room = rooms[rid];
        if (!room) return;

        const player = room.members.find(p => p.id === userId);
        if (player && player.answer === null) {
            player.answer = answer;
            player.readyAt = Date.now();
        }
        updateRoomData(rid);
    });

    // --- 結果オープン ---
    socket.on('host-judge', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;
        const results = room.members.map(p => ({ name: p.name, answer: p.answer }));
        io.to(rid).emit('show-result', { results });
    });

    // --- 次のラウンドへ ---
    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        room.members.forEach(p => { p.answer = null; p.readyAt = null; });
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    // --- 明示的な退出 ---
    socket.on('leave-room', ({ rid, userId }) => {
        const room = rooms[rid];
        if (!room) return;

        room.members = room.members.filter(p => p.id !== userId);
        socket.leave(rid);

        if (room.members.length === 0) {
            delete rooms[rid];
        } else {
            room.turnIndex = room.turnIndex % room.members.length;
            updateRoomData(rid);
        }
        socket.emit('left-success');
    });

    // --- 切断（バックグラウンド移行など） ---
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const room = rooms[rid];
            const player = room.members.find(m => m.socketId === socket.id);

            if (player) {
                player.socketId = null; // 切断中としてマーク
                
                // 待機中なら即削除、プレイ中なら10分待機（復帰のため）
                const waitTime = room.status === 'waiting' ? 1000 : 600000;

                setTimeout(() => {
                    if (rooms[rid] && !player.socketId) {
                        rooms[rid].members = rooms[rid].members.filter(m => m.id !== player.id);
                        if (rooms[rid].members.length === 0) {
                            delete rooms[rid];
                        } else {
                            updateRoomData(rid);
                        }
                    }
                }, waitTime);

                updateRoomData(rid);
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log("server start " + PORT);
});