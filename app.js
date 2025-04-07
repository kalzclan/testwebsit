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

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const userId = localStorage.getItem('userId') || Math.random().toString(36).substring(2, 9);
localStorage.setItem('userId', userId);

let secret = [];
let history = [];
let timeLeft = 60;
let gameOver = false;
let isPlayer1 = false;
let playerName = "Player";

const inputs = ["g1", "g2", "g3", "g4"].map(id => document.getElementById(id));
const submitBtn = document.getElementById("submit-btn");
const resultEl = document.getElementById("result");
const player1NameEl = document.getElementById("player1-name");
const player2NameEl = document.getElementById("player2-name");
const winnerDisplay = document.getElementById("winner-display");
const winnerMessage = document.getElementById("winner-message");
const chatPopup = document.getElementById("chat-popup");
const chatMessages = document.getElementById("chat-messages");

// Load user data from Firestore
async function loadUserData(userId) {
  const userRef = doc(db, "users", userId);
  const userSnap = await getDoc(userRef);
  
  if (userSnap.exists()) {
    return userSnap.data();
  } else {
    // Create new user if doesn't exist
    const newName = prompt("Enter your name:") || "Player";
    await updateDoc(userRef, {
      name: newName,
      lastActive: new Date().toISOString()
    });
    return { name: newName };
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

// Initialize game
async function initGame() {
  const userData = await loadUserData(userId);
  playerName = userData.name;
  
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
        player1NameEl.innerText = `Player 1: ${playerName}`;
      } else if (!data.player2Id && data.player1Id !== userId) {
        await updateDoc(gameRef, { 
          player2Id: userId,
          joined: true,
          joinedAt: new Date().toISOString()
        });
        player2NameEl.innerText = `Player 2: ${playerName}`;
      }
      
      // Load player names from users collection
      if (data.player1Id) {
        const player1Data = await getDoc(doc(db, "users", data.player1Id));
        player1NameEl.innerText = `Player 1: ${player1Data.exists() ? player1Data.data().name : 'Unknown'}`;
      }
      
      if (data.player2Id) {
        const player2Data = await getDoc(doc(db, "users", data.player2Id));
        player2NameEl.innerText = `Player 2: ${player2Data.exists() ? player2Data.data().name : 'Unknown'}`;
      }
      
      if (!data.joined) {
        resultEl.innerText = "Waiting for another player to join...";
        submitBtn.disabled = true;
      } else {
        secret = data.secret || [];
        if (secret.length === 4) {
          resultEl.innerText = "Game started! Make your guess!";
          submitBtn.disabled = false;
          if (!timeLeft) startTimer();
        }
      }

      // Update game history (only show current player's guesses)
      if (data.rounds) {
        history = data.rounds
          .filter(round => round.playerId === userId)
          .map(round => {
            const time = new Date(round.timestamp).toLocaleTimeString();
            return `${time} - You: ${round.guess} → ${round.result}`;
          });
        document.getElementById("history").innerText = history.join("\n");
      }

      // Handle winner
      if (data.winner && !gameOver) {
        gameOver = true;
        clearInterval(timerInterval);
        disableInputs();
        
        if (data.winner === userId) {
          showWinnerDisplay(`You guessed the number ${data.secret.join('')} correctly!`);
          createConfetti();
        } else {
          const winnerRef = doc(db, "users", data.winner);
          const winnerSnap = await getDoc(winnerRef);
          const winnerName = winnerSnap.exists() ? winnerSnap.data().name : "Opponent";
          resultEl.innerText = `Game over! ${winnerName} guessed the number correctly!`;
        }
      }

      // Update chat
      if (data.messages) {
        chatMessages.innerHTML = data.messages
          .map(msg => {
            const isCurrentUser = msg.senderId === userId;
            return `<div style="color: ${isCurrentUser ? '#00ffcc' : 'white'}">
              <strong>${msg.senderName}:</strong> ${msg.text}
            </div>`;
          })
          .join('');
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    } else {
      resultEl.innerText = "Game not found.";
      submitBtn.disabled = true;
    }
  });
}

let timerInterval;
function startTimer() {
  timeLeft = 60;
  const timerDisplay = document.getElementById("timer");
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (gameOver) {
      clearInterval(timerInterval);
      return;
    }
    timeLeft--;
    timerDisplay.innerText = `Time left: ${timeLeft}s`;
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      resultEl.innerText = "⏰ Time's up!";
      disableInputs();
    }
  }, 1000);
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

  // Clear inputs
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
    resultEl.innerText = `Your guess: ${guessStr}\nCorrect position: ${correctPosition}\nCorrect number: ${correctNumber}`;
  }
}

window.restartGame = function () {
  window.location.reload();
}

window.toggleChat = function() {
  chatPopup.style.display = chatPopup.style.display === 'block' ? 'none' : 'block';
}

window.sendMessage = async function () {
  const message = document.getElementById("chat-message-input").value;
  if (!message) return;
  
  await updateDoc(gameRef, {
    messages: arrayUnion({
      senderId: userId,
      senderName: playerName,
      text: message,
      timestamp: new Date().toISOString()
    })
  });
  document.getElementById("chat-message-input").value = '';
}

window.showWinnerDisplay = function(message) {
  winnerMessage.innerText = message;
  winnerDisplay.style.display = "flex";
}

window.hideWinnerDisplay =
