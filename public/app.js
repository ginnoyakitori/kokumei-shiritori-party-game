const playerNameInput = document.getElementById("playerName");
const addPlayerBtn = document.getElementById("addPlayerBtn");
const playerList = document.getElementById("playerList");
const topicInput = document.getElementById("topicInput");
const startRoundBtn = document.getElementById("startRoundBtn");
const currentTopic = document.getElementById("currentTopic");
const answerArea = document.getElementById("answerArea");
const revealBtn = document.getElementById("revealBtn");
const nextBtn = document.getElementById("nextBtn");
const resultPanel = document.getElementById("resultPanel");

const state = {
  players: [],
  answers: new Map(),
};

function renderPlayers() {
  playerList.innerHTML = "";
  state.players.forEach((name) => {
    const item = document.createElement("li");
    item.textContent = name;
    playerList.append(item);
  });
}

function addPlayer() {
  const name = playerNameInput.value.trim();
  if (!name) return;

  if (state.players.includes(name)) {
    alert("同じ名前のプレイヤーがいます。");
    return;
  }

  state.players.push(name);
  playerNameInput.value = "";
  renderPlayers();
}

function renderAnswerInputs() {
  answerArea.innerHTML = "";

  state.players.forEach((name) => {
    const card = document.createElement("div");
    card.className = "answer-card";

    const label = document.createElement("label");
    label.setAttribute("for", `answer-${name}`);
    label.textContent = `${name} の回答`;

    const input = document.createElement("input");
    input.id = `answer-${name}`;
    input.placeholder = "回答を入力";
    input.maxLength = 40;

    input.addEventListener("input", () => {
      state.answers.set(name, input.value.trim());
      const ready = state.players.every((player) => {
        const answer = state.answers.get(player) || "";
        return answer.length > 0;
      });
      revealBtn.disabled = !ready;
    });

    card.append(label, input);
    answerArea.append(card);
  });
}

function startRound() {
  const topic = topicInput.value.trim();

  if (state.players.length < 2) {
    alert("2人以上参加してください。");
    return;
  }

  if (!topic) {
    alert("お題を入力してください。");
    return;
  }

  state.answers = new Map();
  currentTopic.textContent = `お題: ${topic}`;
  resultPanel.className = "result";
  resultPanel.textContent = "全員の回答入力を待っています...";
  revealBtn.disabled = true;
  nextBtn.disabled = true;
  renderAnswerInputs();
}

function revealAnswers() {
  const normalized = state.players.map((name) => (state.answers.get(name) || "").toLowerCase());
  const unanimous = normalized.every((answer) => answer === normalized[0]);

  const details = state.players
    .map((name) => `・${name}: ${state.answers.get(name)}`)
    .join("\n");

  resultPanel.className = `result ${unanimous ? "ok" : "ng"}`;
  resultPanel.textContent = `${unanimous ? "🎉 全員一致！" : "💥 不一致！"}\n${details}`;
  nextBtn.disabled = false;
}

function resetRound() {
  answerArea.innerHTML = "";
  resultPanel.className = "result";
  resultPanel.textContent = "次のお題を入力してラウンド開始！";
  topicInput.value = "";
  currentTopic.textContent = "お題を設定してください。";
  revealBtn.disabled = true;
  nextBtn.disabled = true;
}

addPlayerBtn.addEventListener("click", addPlayer);
playerNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addPlayer();
  }
});
startRoundBtn.addEventListener("click", startRound);
revealBtn.addEventListener("click", revealAnswers);
nextBtn.addEventListener("click", resetRound);

renderPlayers();
resetRound();
