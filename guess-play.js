import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { 
  getFirestore, 
  doc, 
  getDoc,
  onSnapshot, 
  updateDoc, 
  arrayUnion
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

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const userId = localStorage.getItem('userId') || Math.random().toString(36).substring(2, 9);
localStorage.setItem('userId', userId);

let secret = [];
let gameOver = false;
let isPlayer1 = false;

const inputs = ["g1", "g2", "g3", "g4"].map(id => document.getElementById(id));
const submitBtn = document.getElementById("submit-btn");
const resultEl = document.getElementById("result");
const player1NameEl = document.getElementById("player1-name");
const player2NameEl = document.getElementById("player2-name");
const winnerDisplay = document.getElementById("winner-display");
const winnerMessage = document.getElementById("winner-message");
const historyTable = document.getElementById("history-table");

async function fetchPlayerName(playerId, element) {
  const userRef = doc(db, "users", playerId);
  const docSnap = await getDoc(userRef);
  if (docSnap.exists()) {
    element.innerText = element.id === "player1-name" 
      ? `Player 1: ${docSnap.data().username}`
      : `Player 2: ${docSnap.data().username}`;
  }
}

inputs.forEach((input, idx) => {
  input.addEventListener("input", () => {
    if (input.value.length === 1 && idx < 3) {
      inputs[idx + 1].focus();
    }
  });
});

const gameRef = doc(db, "games", roomId);

async function initGame() {
  onSnapshot(gameRef, async (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      
      // Set player positions
      if (!data.player1Id) {
        isPlayer1 = true;
        await updateDoc(gameRef, { 
          player1Id: userId,
          createdAt: new Date().toISOString()
        });
        await fetchPlayerName(userId, player1NameEl);
      } else if (!data.player2Id && data.player1Id !== userId) {
        await updateDoc(gameRef, { 
          player2Id: userId,
          joined: true,
          joinedAt: new Date().toISOString()
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
        }
      }

      // Update game history in table format
      if (data.rounds) {
        updateHistoryTable(data.rounds.filter(round => round.playerId === userId));
      }

      // Handle winner
      if (data.winner && !gameOver) {
        gameOver = true;
        disableInputs();
        
        if (data.winner === userId) {
          showWinnerDisplay(`You guessed the number ${data.secret.join('')} correctly!`);
          createConfetti();
        } else {
          const winnerName = await fetchPlayerName(data.winner);
          resultEl.innerText = `Game over! ${winnerName} guessed the number correctly!`;
        }
      }
    } else {
      resultEl.innerText = "Game not found.";
      submitBtn.disabled = true;
    }
  });
}

function updateHistoryTable(rounds) {
  // Clear existing rows except header
  while (historyTable.rows.length > 1) {
    historyTable.deleteRow(1);
  }

  // Add each round as a row
  rounds.forEach(round => {
    const row = historyTable.insertRow();
    const guessCell = row.insertCell(0);
    const numberCell = row.insertCell(1);
    const orderCell = row.insertCell(2);
    
    guessCell.textContent = round.guess;
    numberCell.textContent = round.result.split(', ')[1].split(': ')[1]; // Extract correct numbers
    orderCell.textContent = round.result.split(', ')[0].split(': ')[1]; // Extract correct positions
  });
}

function disableInputs() {
  inputs.forEach(input => input.disabled = true);
  submitBtn.disabled = true;
}

window.submitGuess = async function () {
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
      correctNumber++; // Increment both if correct position
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
      rounds: arrayUnion(roundInfo)
    });
  } else {
    await updateDoc(gameRef, { 
      rounds: arrayUnion(roundInfo)
    });
  //  resultEl.innerText = `Your guess: ${guessStr}\nCorrect position: ${correctPosition}\nCorrect number: ${correctNumber}`;
  }
}

window.restartGame = function () {
  window.location.reload();
}

window.showWinnerDisplay = function(message) {
  winnerMessage.innerText = message;
  winnerDisplay.style.display = "flex";
}

window.hideWinnerDisplay = function() {
  winnerDisplay.style.display = "none";
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

// ... (previous imports remain the same)

async function updateUserBalance(userId, amount) {
  const userRef = doc(db, "users", userId);
  try {
    await updateDoc(userRef, {
      balance: increment(amount)
    });
  } catch (error) {
    console.error("Error updating balance:", error);
  }
}

async function handleGameEnd(winnerId) {
  const gameData = (await getDoc(gameRef)).data();
  const loserId = winnerId === gameData.player1Id ? gameData.player2Id : gameData.player1Id;
  
  // Update balances
  await updateUserBalance(winnerId, 50);
  await updateUserBalance(loserId, -50);
  
  // Show winner/loser displays
  if (winnerId === userId) {
    showWinnerDisplay(`You won! +50 coins!`);
    createConfetti();
  } else {
    showLoserDisplay(`You lost! -50 coins!`);
  }
}

function showLoserDisplay(message) {
  const loserDisplay = document.getElementById("loser-display");
  const loserMessage = document.getElementById("loser-message");
  loserMessage.innerText = message;
  loserDisplay.style.display = "flex";
}

// ... (rest of the existing code remains the same until the onSnapshot callback)

onSnapshot(gameRef, async (snap) => {
  if (snap.exists()) {
    const data = snap.data();
    
    // ... (previous game setup code remains the same)

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

// ... (rest of the code remains the same)



initGame();

