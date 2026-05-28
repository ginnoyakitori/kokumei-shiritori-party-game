function selectGameMode(mode) {
    gameMode = mode === 'denpo' ? 'denpo' : 'ichimitsu';
    socket.emit('go-to-setup', { rid, userId, gameMode });
}

socket.on('show-result', (data) => {
    show('view-result');

    const resultMode = data.gameMode || gameMode;
    gameMode = resultMode;

    if (resultMode === 'ichimitsu') {
        setBanner('result-message',
            data.isMatch ? '✨ 全員一致 ✨' : '❌ 不一致 ❌'
        );
    } else {
        setBanner('result-message', '');
    }

    renderResults(
        data.results || [],
        currentQuestion,
        data.answeredCount || 0,
        data.totalCount || 0,
        resultMode
    );
});
