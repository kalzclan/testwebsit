import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { 
  getFirestore, 
  doc, 
  getDoc,
  onSnapshot, 
  updateDoc,
  arrayUnion,
  increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCK1cWayLcccmgOmygFmW1otwlAPcrUSNw",
  authDomain: "habeshagames-1f999.firebaseapp.com",
  projectId: "habeshagames-1f999",
  storageBucket: "habeshagames-1f999.appspot.com",
  messagingSenderId: "919693990773",
  appId: "1:919693990773:web:f32664a1b944b38101113c",
  measurementId: "G-G5C67RMJDY"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Game constants
const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// Game state
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const userId = localStorage.getItem('userId') || Math.random().toString(36).substring(2, 9);
localStorage.setItem('userId', userId);

let secret = [];
let gameOver = false;
let isPlayer1 = false;
let lastLocalActivity = Date.now();

// DOM elements
const elements = {
  inputs: ["g1", "g2", "g3", "g4"].map(id => document.getElementById(id)),
  submitBtn: document.getElementById("submit-btn"),
  resultEl: document.getElementById("result"),
  player1NameEl: document.getElementById("player1-name"),
  player2NameEl: document.getElementById("player2-name"),
  winnerDisplay: document.getElementById("winner-display"),
  winnerMessage: document.getElementById("winner-message"),
  loserDisplay: document.getElementById("loser-display"),
  loserMessage: document.getElementById("loser-message"),
  historyTable: document.getElementById("history-table")
};

// Optimized Firestore operations
const gameRef = doc(db, "games", roomId);
let unsubscribeGameListener;

async function initializeGame() {
  // Single Firestore update for initial setup
  const gameSnap = await getDoc(gameRef);
  
  if (!gameSnap.exists()) {
    alert("Game not found");
    return;
  }

  const gameData = gameSnap.data();
  
  // Determine player position
  if (!gameData.player1Id) {
    isPlayer1 = true;
    await updateDoc(gameRef, {
      player1Id: userId,
      createdAt: serverTimestamp(),
      lastUpdate: serverTimestamp()
    });
  } else if (!gameData.player2Id && gameData.player1Id !== userId) {
    await updateDoc(gameRef, {
      player2Id: userId,
      joined: true,
      joinedAt: serverTimestamp(),
      lastUpdate: serverTimestamp()
    });
  }

  // Set up real-time listener
  unsubscribeGameListener = onSnapshot(gameRef, handleGameUpdate);
}

async function handleGameUpdate(snap) {
  if (!snap.exists()) return;

  const data = snap.data();
  lastLocalActivity = Date.now();

  // Update UI immediately
  updatePlayerNames(data);
  updateGameStatus(data);
  updateHistory(data);

  // Handle game end
  if (data.winner && !gameOver) {
    gameOver = true;
    elements.submitBtn.disabled = true;
    handleGameConclusion(data.winner);
  }
}

// Optimized UI updates
function updatePlayerNames(data) {
  if (data.player1Id) {
    getDoc(doc(db, "users", data.player1Id)).then(snap => {
      if (snap.exists()) elements.player1NameEl.textContent = `Player 1: ${snap.data().username}`;
    });
  }
  if (data.player2Id) {
    getDoc(doc(db, "users", data.player2Id)).then(snap => {
      if (snap.exists()) elements.player2NameEl.textContent = `Player 2: ${snap.data().username}`;
    });
  }
}

function updateGameStatus(data) {
  if (!data.joined) {
    elements.resultEl.textContent = "Waiting for another player...";
    elements.submitBtn.disabled = true;
  } else if (data.secret?.length === 4) {
    secret = data.secret;
    elements.resultEl.textContent = "Game started! Make your guess!";
    elements.submitBtn.disabled = false;
  }
}

function updateHistory(data) {
  if (data.rounds) {
    const userRounds = data.rounds.filter(round => round.playerId === userId);
    elements.historyTable.innerHTML = `
      <tr>
        <th>Guess</th>
        <th>Number</th>
        <th>Order</th>
      </tr>
      ${userRounds.map(round => `
        <tr>
          <td>${round.guess}</td>
          <td>${round.result.split(', ')[1].split(': ')[1]}</td>
          <td>${round.result.split(', ')[0].split(': ')[1]}</td>
        </tr>
      `).join('')}
    `;
  }
}

// Optimized guess submission
async function submitGuess() {
  if (gameOver) return;

  const guess = elements.inputs.map(input => parseInt(input.value));
  
  // Client-side validation
  if (new Set(guess).size !== 4 || guess.some(n => n < 1 || n > 9 || isNaN(n))) {
    elements.resultEl.textContent = "Invalid guess. Use 1-9 without repeats.";
    return;
  }

  // Calculate results client-side
  let correctPosition = 0;
  let correctNumber = 0;
  secret.forEach((num, i) => {
    if (guess[i] === num) correctPosition++;
    else if (secret.includes(guess[i])) correctNumber++;
  });

  // Single Firestore update
  await updateDoc(gameRef, {
    rounds: arrayUnion({
      playerId: userId,
      guess: guess.join(""),
      result: `Right place: ${correctPosition}, Right number: ${correctNumber}`,
      timestamp: serverTimestamp()
    }),
    lastUpdate: serverTimestamp()
  });

  // Clear inputs and focus
  elements.inputs.forEach(input => input.value = "");
  elements.inputs[0].focus();

  // Immediate UI feedback
  if (correctPosition === 4) {
    await updateDoc(gameRef, {
      winner: userId,
      lastUpdate: serverTimestamp()
    });
  } else {
    elements.resultEl.textContent = `Guess: ${guess.join("")}\nCorrect: ${correctNumber}\nPosition: ${correctPosition}`;
  }
}

// Game conclusion handling
async function handleGameConclusion(winnerId) {
  if (winnerId === userId) {
    showWinnerDisplay("You won! +50 coins!");
    createConfetti();
  } else {
    showLoserDisplay("You lost! -50 coins!");
  }

  // Only host processes transactions
  if (isPlayer1) {
    const gameData = (await getDoc(gameRef)).data();
    if (gameData.processed) return;

    const loserId = winnerId === gameData.player1Id ? gameData.player2Id : gameData.player1Id;
    
    // Batch updates
    await Promise.all([
      updateDoc(doc(db, "users", winnerId), { balance: increment(50) }),
      updateDoc(doc(db, "users", loserId), { balance: increment(-50) }),
      updateDoc(gameRef, { processed: true })
    ]);
  }
}

// Inactivity monitoring
function startInactivityMonitor() {
  const checkInterval = setInterval(async () => {
    if (gameOver) {
      clearInterval(checkInterval);
      return;
    }

    const gameData = (await getDoc(gameRef)).data();
    if (!gameData || isPlayer1) return;

    const inactiveTime = Date.now() - new Date(gameData.lastUpdate?.toDate()).getTime();
    if (inactiveTime > INACTIVITY_TIMEOUT && !gameData.winner) {
      await updateDoc(gameRef, {
        winner: userId,
        rounds: arrayUnion({
          playerId: userId,
          guess: "AUTO-WIN",
          result: "Host inactive",
          timestamp: serverTimestamp()
        }),
        lastUpdate: serverTimestamp()
      });
    }
  }, 30000); // Check every 30 seconds
}

// UI Helpers
function showWinnerDisplay(message) {
  elements.winnerMessage.textContent = message;
  elements.winnerDisplay.style.display = "flex";
}

function showLoserDisplay(message) {
  elements.loserMessage.textContent = message;
  elements.loserDisplay.style.display = "flex";
}

function createConfetti() {
  const colors = ['#f00', '#0f0', '#00f', '#ff0', '#f0f', '#0ff'];
  for (let i = 0; i < 50; i++) { // Reduced number of particles
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.left = `${Math.random() * 100}vw`;
    confetti.style.animation = `confetti-fall ${Math.random() * 2 + 2}s linear forwards`;
    document.body.appendChild(confetti);
    setTimeout(() => confetti.remove(), 3000);
  }
}

// Event listeners
elements.inputs.forEach((input, idx) => {
  input.addEventListener("input", () => {
    if (input.value.length === 1 && idx < 3) {
      elements.inputs[idx + 1].focus();
    }
  });
});

window.submitGuess = submitGuess;
window.hideWinnerDisplay = () => elements.winnerDisplay.style.display = "none";
window.hideLoserDisplay = () => elements.loserDisplay.style.display = "none";
window.restartGame = () => window.location.reload();

// Initialize
initializeGame().then(startInactivityMonitor);

// Cleanup
window.addEventListener('beforeunload', () => {
  if (unsubscribeGameListener) unsubscribeGameListener();
});
