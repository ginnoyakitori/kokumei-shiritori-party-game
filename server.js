const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

// 部屋の状態を全員に同期する関数
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;
    
    const host = room.members[room.turnIndex];
    
    // 全員のリスト (接続が切れている人も含めて保持)
    const allMembers = room.members.map(m => ({
        id: m.id,
        name: m.name,
        isHost: m.id === (host ? host.id : null),
        isOnline: !!m.socketId // 接続中かどうかのフラグ
    }));

    // 回答済みのプレイヤーを提出順にソート
    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((m, index) => ({
            name: m.name,
            order: index + 1
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
    // 入室・再入室処理
    socket.on('join-room', ({ name, rid, userId }) => {
        if (!rooms[rid]) {
            rooms[rid] = { turnIndex: 0, members: [], status: 'waiting' };
        }

        let player = rooms[rid].members.find(m => m.id === userId);

        if (player) {
            // 再接続の場合：新しいSocketIDを紐付け直す
            player.socketId = socket.id;
            // 名前が変更されている場合は更新
            if (name) player.name = name;
        } else {
            // 新規入室：進行中の場合は拒否
            if (rooms[rid].status === 'playing') {
                return socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
            }
            player = { id: userId, socketId: socket.id, name, answer: null, readyAt: null };
            rooms[rid].members.push(player);
        }

        socket.join(rid);
        updateRoomData(rid);
    });

    // 画面遷移
    socket.on('go-to-setup', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'playing';
            io.to(rid).emit('move-to-setup');
            updateRoomData(rid);
        }
    });

    socket.on('back-to-waiting', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'waiting';
            io.to(rid).emit('move-to-waiting');
            updateRoomData(rid);
        }
    });

    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    // 回答送信
    socket.on('submit-answer', ({ rid, userId, answer }) => {
        const room = rooms[rid];
        if (room) {
            const player = room.members.find(p => p.id === userId);
            if (player && player.answer === null) {
                player.answer = answer;
                player.readyAt = Date.now();
            }
            updateRoomData(rid);
        }
    });

    // 結果表示
    socket.on('host-judge', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;
        const results = room.members.map(p => ({ name: p.name, answer: p.answer }));
        io.to(rid).emit('show-result', { results });
    });

    // 次のラウンドへ
    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;
        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        room.members.forEach(p => { p.answer = null; p.readyAt = null; });
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    // 退出処理
    socket.on('leave-room', ({ rid, userId }) => {
        if (rooms[rid]) {
            rooms[rid].members = rooms[rid].members.filter(p => p.id !== userId);
            if (rooms[rid].members.length === 0) delete rooms[rid];
            else {
                rooms[rid].turnIndex = rooms[rid].turnIndex % rooms[rid].members.length;
                updateRoomData(rid);
            }
        }
        socket.emit('left-success');
    });

    // 切断時（ページを閉じた・アプリを切り替えた）
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const player = rooms[rid].members.find(m => m.socketId === socket.id);
            if (player) {
                player.socketId = null; // SocketIDだけ消して、データは保持
                // 10分間戻ってこなければ完全に削除する（メモリ解放のため）
                setTimeout(() => {
                    if (rooms[rid] && !player.socketId) {
                        rooms[rid].members = rooms[rid].members.filter(m => m.id !== player.id);
                        if (rooms[rid].members.length === 0) delete rooms[rid];
                        else updateRoomData(rid);
                    }
                }, 600000); 
                updateRoomData(rid);
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0');