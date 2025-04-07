import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { 
  getFirestore, 
  doc, 
  getDoc,
  onSnapshot, 
  updateDoc, 
  arrayUnion,
  increment
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
const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes in milliseconds
let inactivityTimer;
let lastActivityTime = Date.now();

// Game state variables
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const userId = localStorage.getItem('userId') || Math.random().toString(36).substring(2, 9);
localStorage.setItem('userId', userId);

let secret = [];
let gameOver = false;
let isPlayer1 = false;

// DOM elements
const inputs = ["g1", "g2", "g3", "g4"].map(id => document.getElementById(id));
const submitBtn = document.getElementById("submit-btn");
const resultEl = document.getElementById("result");
const player1NameEl = document.getElementById("player1-name");
const player2NameEl = document.getElementById("player2-name");
const winnerDisplay = document.getElementById("winner-display");
const winnerMessage = document.getElementById("winner-message");
const loserDisplay = document.getElementById("loser-display");
const loserMessage = document.getElementById("loser-message");
const historyTable = document.getElementById("history-table");

// Helper Functions
async function fetchPlayerName(playerId, element) {
  const userRef = doc(db, "users", playerId);
  const docSnap = await getDoc(userRef);
  if (docSnap.exists()) {
    element.innerText = element.id === "player1-name" 
      ? `Player 1: ${docSnap.data().username}`
      : `Player 2: ${docSnap.data().username}`;
  }
}

async function updateUserBalance(userId, amount) {
  const userRef = doc(db, "users", userId);
  try {
    await updateDoc(userRef, {
      balance: increment(amount)
    });
    const updatedUser = await getDoc(userRef);
    return updatedUser.data().balance;
  } catch (error) {
    console.error("Error updating balance:", error);
    return null;
  }
}

async function handleGameEnd(winnerId) {
  try {
    const gameData = (await getDoc(gameRef)).data();
    if (!gameData || gameData.processed) return;
    
    const loserId = winnerId === gameData.player1Id ? gameData.player2Id : gameData.player1Id;
    
    // Only Player 1 (host) handles money transactions
    if (isPlayer1) {
      const winnerBalance = await updateUserBalance(winnerId, 50);
      const loserBalance = await updateUserBalance(loserId, -50);
      
      await updateDoc(gameRef, {
        processed: true,
        transactions: arrayUnion({
          winner: winnerId,
          loser: loserId,
          amount: 50,
          timestamp: new Date().toISOString()
        })
      });
    }

    // Show appropriate messages
    if (winnerId === userId) {
      showWinnerDisplay("You won! +50 coins!");
      createConfetti();
    } else {
      showLoserDisplay("You lost! -50 coins!");
    }
  } catch (error) {
    console.error("Error handling game end:", error);
  }
}

async function checkHostInactivity() {
  const gameData = (await getDoc(gameRef)).data();
  if (!gameData || gameOver) return;

  const lastUpdate = new Date(gameData.lastUpdate).getTime();
  const currentTime = Date.now();

  // If host is inactive for more than 10 minutes and game isn't over
  if (!isPlayer1 && 
      currentTime - lastUpdate > INACTIVITY_TIMEOUT && 
      !gameData.winner) {
    
    // Guest automatically wins
    await updateDoc(gameRef, {
      winner: userId,
      rounds: arrayUnion({
        playerId: userId,
        guess: "AUTO-WIN",
        result: "Host inactive",
        timestamp: new Date().toISOString()
      }),
      lastUpdate: new Date().toISOString()
    });

    await handleGameEnd(userId);
  }
}

// UI Functions
function updateHistoryTable(rounds) {
  while (historyTable.rows.length > 1) {
    historyTable.deleteRow(1);
  }

  rounds.forEach(round => {
    const row = historyTable.insertRow();
    const guessCell = row.insertCell(0);
    const numberCell = row.insertCell(1);
    const orderCell = row.insertCell(2);
    
    guessCell.textContent = round.guess;
    numberCell.textContent = round.result.split(', ')[1].split(': ')[1];
    orderCell.textContent = round.result.split(', ')[0].split(': ')[1];
  });
}

function disableInputs() {
  inputs.forEach(input => input.disabled = true);
  submitBtn.disabled = true;
}

function showWinnerDisplay(message) {
  winnerMessage.innerText = message;
  winnerDisplay.style.display = "flex";
}

function showLoserDisplay(message) {
  loserMessage.innerText = message;
  loserDisplay.style.display = "flex";
}

function createConfetti() {
  const colors = ['#f00', '#0f0', '#00f', '#ff0', '#f0f', '#0ff'];
  for (let i = 0; i < 100; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.left = Math.random() * window.innerWidth + 'px';
    confetti.style.animationDuration = Math.random() * 2 + 2 + 's';
    document.body.appendChild(confetti);
    
    setTimeout(() => {
      confetti.remove();
    }, 3000);
  }
}

// Event Handlers
window.hideWinnerDisplay = function() {
  winnerDisplay.style.display = "none";
}

window.hideLoserDisplay = function() {
  loserDisplay.style.display = "none";
}

window.restartGame = function() {
  window.location.reload();
}

window.submitGuess = async function() {
  if (gameOver) return;

  const guess = inputs.map(input => parseInt(input.value));
  if (guess.includes(0) || new Set(guess).size !== 4 || guess.some(n => n < 1 || n > 9 || isNaN(n))) {
    resultEl.innerText = "Invalid guess. Use 1-9 without repeats.";
    return;
  }

  let correctPosition = 0;
  let correctNumber = 0;

  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) {
      correctPosition++;
      correctNumber++;
    } else if (secret.includes(guess[i])) {
      correctNumber++;
    }
  }

  const guessStr = guess.join("");
  const resultStr = `Right place: ${correctPosition}, Right number: ${correctNumber}`;
  const roundInfo = {
    playerId: userId,
    guess: guessStr,
    result: resultStr,
    timestamp: new Date().toISOString()
  };

  inputs.forEach(input => input.value = "");
  inputs[0].focus();

  if (correctPosition === 4) {
    await updateDoc(gameRef, { 
      winner: userId,
      rounds: arrayUnion(roundInfo),
      lastUpdate: new Date().toISOString()
    });
  } else {
    await updateDoc(gameRef, { 
      rounds: arrayUnion(roundInfo),
      lastUpdate: new Date().toISOString()
    });
    resultEl.innerText = `Your guess: ${guessStr}\nCorrect position: ${correctPosition}\nCorrect number: ${correctNumber}`;
  }
}

// Input handling
inputs.forEach((input, idx) => {
  input.addEventListener("input", () => {
    if (input.value.length === 1 && idx < 3) {
      inputs[idx + 1].focus();
    }
  });
});

// Game Initialization
const gameRef = doc(db, "games", roomId);

async function initGame() {
  onSnapshot(gameRef, async (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      lastActivityTime = Date.now();
      
      // Update last activity timestamp
      await updateDoc(gameRef, {
        lastUpdate: new Date().toISOString()
      });

      // Set player positions
      if (!data.player1Id) {
        isPlayer1 = true;
        await updateDoc(gameRef, { 
          player1Id: userId,
          createdAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString()
        });
        await fetchPlayerName(userId, player1NameEl);
      } else if (!data.player2Id && data.player1Id !== userId) {
        await updateDoc(gameRef, { 
          player2Id: userId,
          joined: true,
          joinedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString()
        });
        await fetchPlayerName(userId, player2NameEl);
      }
      
      // Load player names
      if (data.player1Id) await fetchPlayerName(data.player1Id, player1NameEl);
      if (data.player2Id) await fetchPlayerName(data.player2Id, player2NameEl);
      
      if (!data.joined) {
        resultEl.innerText = "Waiting for another player to join...";
        submitBtn.disabled = true;
      } else {
        secret = data.secret || [];
        if (secret.length === 4) {
          resultEl.innerText = "Game started! Make your guess!";
          submitBtn.disabled = false;
          
          // Start inactivity check
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(checkHostInactivity, INACTIVITY_TIMEOUT);
        }
      }

      // Update game history
      if (data.rounds) {
        updateHistoryTable(data.rounds.filter(round => round.playerId === userId));
      }

      // Handle winner
      if (data.winner && !gameOver) {
        gameOver = true;
        disableInputs();
        await handleGameEnd(data.winner);
      }
    } else {
      resultEl.innerText = "Game not found.";
      submitBtn.disabled = true;
    }
  });
}

// Cleanup on page exit
window.addEventListener('beforeunload', async () => {
  if (isPlayer1 && !gameOver) {
    await updateDoc(gameRef, {
      lastUpdate: new Date().toISOString()
    });
  }
  clearTimeout(inactivityTimer);
});

// Start the game
initGame();
