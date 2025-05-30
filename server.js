const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Configuration - Supabase keys remain hardcoded for now
// Port and CORS Origin will read from Environment Variables in Render
const config = {
    supabaseUrl: 'https://evberyanshxxalxtwnnc.supabase.co', // Hardcoded as requested
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2YmVyeWFuc2h4eGFleHR3bm5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQwODMwOTcsImV4cCI6MjA1OTY1OTA5N30.pEoPiIi78Tvl5URw0Xy_vAxsd-3XqRlC8FTnX9HpgMw', // Hardcoded as requested
    // Removed hardcoded port
    // Removed hardcoded corsOrigin
};

// Read PORT and CORS_ORIGIN from environment variables
const PORT = process.env.PORT || 3000; // Use Render's PORT, fallback to 3000 for local dev
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:1384'; // Use env var for deployed origin, fallback for local dev


// Middleware
app.use(cors({
    origin: CORS_ORIGIN, // Use the dynamic origin variable
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Initialize Supabase
const supabase = createClient(config.supabaseUrl, config.supabaseKey); // Still using hardcoded values

// Create HTTP server
// Listen on the PORT environment variable
const server = app.listen(PORT, () => { // Use the dynamic PORT variable
    console.log(`Server running on port ${PORT}`); // Log the correct port
});

// Initialize Socket.IO
const io = new Server(server, {
    cors: {
        origin: CORS_ORIGIN, // Use the dynamic origin variable
        methods: ["GET", "POST"]
    },
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true
    }
});

// ... rest of your server code (Socket.IO connections, game logic, routes)

// Game state management
const gameTimers = {};
const activeGames = new Map();
const gameRooms = new Map(); // Tracks players in each room: { gameCode: { white: socketId, black: socketId } }

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Handle joining a game room
   socket.on('joinGame', async (gameCode) => {
    try {
      socket.join(gameCode);
      socket.gameCode = gameCode;
  
      if (!gameRooms.has(gameCode)) {
        gameRooms.set(gameCode, { white: null, black: null });
      }
      const room = gameRooms.get(gameCode);
  
      if (!room.white) {
        room.white = socket.id;
        // Notify white player
        socket.emit('notification', {
          type: 'role-assignment',
          role: 'white',
          message: 'You are WHITE. Waiting for BLACK player...'
        });
      } 
      else if (!room.black) {
        room.black = socket.id;
        
        // Notify both players
        io.to(gameCode).emit('notification', {
          type: 'game-start',
          message: 'Game started! WHITE moves first.',
          timeControl: 600 // or your default time
        });
      

            
        // Notify white player specifically
        io.to(room.white).emit('notification', {
          type: 'opponent-connected',
          message: 'BLACK has joined. Make your move!'
        });
        
        // Start game logic
        const game = await getOrCreateGame(gameCode);
        if (game.status === 'ongoing' && !gameTimers[gameCode]) {
          startGameTimer(gameCode, game.time_control || 600);
        }
        
      } else {
        throw new Error('Room is full');
      }
  
      const game = await getOrCreateGame(gameCode);
      activeGames.set(gameCode, game);
      socket.emit('gameState', game);
  
    } catch (error) {
      socket.emit('notification', {
        type: 'error',
        message: error.message
      });
    }
  });
  // Handle move events
  socket.on('move', async (moveData) => {
    try {
      const { gameCode, from, to, player, promotion } = moveData; // ADD PROMOTION HERE
      if (!gameCode || !from || !to || !player) {
        throw new Error('Invalid move data');
      }
  
      const room = gameRooms.get(gameCode);
      if (!room?.white || !room?.black) {
        throw new Error('Wait for the other player to join!');
      }
  
      // PASS PROMOTION TO processMove
      const result = await processMove(gameCode, from, to, player, promotion);
      
      io.to(gameCode).emit('gameUpdate', result);
      checkGameEndConditions(gameCode, result.gameState);
  
    } catch (error) {
      console.error('Move error:', error);
      socket.emit('moveError', error.message);
    }
  });
  socket.on('gameOver', async ({ winner, reason }) => {
    try {
      await endGame(socket.gameCode, winner, reason);
      
      // Notify players
      const message = winner 
        ? `${winner} wins! ${reason}. ${game.bet ? `$${game.bet} transferred` : ''}`
        : `Game drawn. ${reason}`;
      
      io.to(socket.gameCode).emit('gameOver', { winner, reason: message });
      
    } catch (error) {
      console.error('Game over error:', error);
      socket.emit('error', 'Failed to process game result');
    }
  });
  // Handle disconnections
// Inside your socket.io 'disconnect' handler
socket.on('disconnect', async () => {
  try {
    console.log(`Client disconnected: ${socket.id}`);
    if (!socket.gameCode) return;

    const room = gameRooms.get(socket.gameCode);
    if (!room) return;

    // Determine which player disconnected
    let disconnectedRole = null;
    if (room.white === socket.id) {
      disconnectedRole = 'white';
      room.white = null;
    } else if (room.black === socket.id) {
      disconnectedRole = 'black';
      room.black = null;
    }

    if (!disconnectedRole) return;

    const game = activeGames.get(socket.gameCode);
    const isGameActive = game?.status === 'ongoing';

    // Check if this was the last player
    const isLastPlayer = !room.white && !room.black;

    if (isLastPlayer) {
      // Mark game as finished if it was active
      if (isGameActive) {
        await supabase
          .from('chess_games')
          .update({
            status: 'finished',
            result: 'abandoned',
            updated_at: new Date().toISOString()
          })
          .eq('code', socket.gameCode);
      }

      // Clean up all game resources
      if (gameTimers[socket.gameCode]) {
        clearInterval(gameTimers[socket.gameCode].interval);
        delete gameTimers[socket.gameCode];
      }
      activeGames.delete(socket.gameCode);
      gameRooms.delete(socket.gameCode);

      console.log(`Game ${socket.gameCode} cleaned up (last player left)`);
      await supabase
          .from('chess_games')
          .update({
            status: 'finished',
            result: 'abandoned',
            updated_at: new Date().toISOString()
          })
          .eq('code', socket.gameCode);
    } 
    else if (isGameActive) {
      // Handle single player disconnect (opponent wins)
      const winner = disconnectedRole === 'white' ? 'black' : 'white';
      const remainingSocketId = room[winner];
      
      // Only end game if remaining player is still connected
      if (io.sockets.sockets.has(remainingSocketId)) {
        await endGame(socket.gameCode, winner, 'disconnection');
        io.to(remainingSocketId).emit('gameOver', {
          winner,
          reason: 'Opponent disconnected'
        });
      }
    }

  } catch (error) {
    console.error('Disconnect handler error:', error);
  }
});
 





socket.on('acceptDraw', async ({ gameCode, player }) => {
  try {
    const game = activeGames.get(gameCode);
    if (!game) throw new Error('Game not found');
    
    // Verify there's an active draw offer from the opponent
    if (!game.draw_offer || game.draw_offer === player) {
      throw new Error('No valid draw offer to accept');
    }

    const room = gameRooms.get(gameCode);
    if (!room) throw new Error('Game room not found');

    // Refund each player only their own bet
    let refundTransactions = [];
    
    if (game.bet && game.bet > 0) {
      // Refund current player (the one accepting the draw)
      const currentPlayerPhone = player === 'white' ? game.white_phone : game.black_phone;
      const currentPlayerSocket = player === 'white' ? room.white : room.black;
      
      if (currentPlayerPhone) {
        const newBalance = await updatePlayerBalance(
          currentPlayerPhone,
          game.bet,
          'refund',
          gameCode,
          `Draw refund for game ${gameCode}`
        );
        
        refundTransactions.push({
          player,
          phone: currentPlayerPhone,
          amount: game.bet,
          newBalance
        });

        // Notify current player
        if (currentPlayerSocket) {
          io.to(currentPlayerSocket).emit('balanceUpdate', {
            amount: game.bet,
            newBalance,
            message: `$${game.bet} refunded for draw`
          });
        }
      }

      // Refund opponent (the one who offered the draw)
      const opponent = player === 'white' ? 'black' : 'white';
      const opponentPhone = opponent === 'white' ? game.white_phone : game.black_phone;
      const opponentSocket = opponent === 'white' ? room.white : room.black;
      
      if (opponentPhone) {
        const newBalance = await updatePlayerBalance(
          opponentPhone,
          game.bet,
          'refund',
          gameCode,
          `Draw refund for game ${gameCode}`
        );
        
        refundTransactions.push({
          player: opponent,
          phone: opponentPhone,
          amount: game.bet,
          newBalance
        });

        // Notify opponent
        if (opponentSocket) {
          io.to(opponentSocket).emit('balanceUpdate', {
            amount: game.bet,
            newBalance,
            message: `$${game.bet} refunded for draw`
          });
        }
      }
    }

    // End the game as a draw
    const endedGame = await endGame(gameCode, null, 'agreement');
    
    // Notify both players
    io.to(gameCode).emit('gameOver', {
      winner: null,
      reason: 'Draw by agreement',
      refunds: refundTransactions
    });

  } catch (error) {
    console.error('Accept draw error:', error);
    socket.emit('error', error.message);
  }
});
  socket.on('offerDraw', async ({ gameCode, player }) => {
    try {
      const { data: game, error } = await supabase
        .from('chess_games')
        .update({ 
          draw_offer: player,
          updated_at: new Date().toISOString()
        })
        .eq('code', gameCode)
        .select()
        .single();

      if (error) throw error;
      
      io.to(gameCode).emit('drawOffer', { player });
      activeGames.set(gameCode, game);

    } catch (error) {
      console.error('Draw offer error:', error);
      socket.emit('error', 'Failed to offer draw');
    }
  });

  // Handle resignations
  socket.on('resign', async ({ gameCode, player }) => {
    try {
      const winner = player === 'white' ? 'black' : 'white';
      const endedGame = await endGame(gameCode, winner, 'resignation');
      
      // Notify winner
      io.to(winner === 'white' ? room.white : room.black).emit('gameWon', {
        animation: 'moneyIncrease',
        amount: endedGame.winningAmount,
        newBalance: endedGame.winnerNewBalance,
        reason: 'Opponent resigned! You won the game'
      });
      
      // Notify loser
      io.to(player === 'white' ? room.white : room.black).emit('gameLost', {
        animation: 'moneyDecrease',
        amount: -endedGame.betAmount,
        newBalance: endedGame.loserNewBalance,
        reason: 'You resigned the game'
      });
      
      // General game over notification
      io.to(gameCode).emit('gameOver', {
        winner,
        reason: 'resignation',
        betAmount: endedGame.betAmount,
        winningAmount: endedGame.winningAmount
      });
  
    } catch (error) {
      console.error('Resign error:', error);
    }
  });
  // Handle disconnections
  
});

// Game Management Functions (same as before)
async function getOrCreateGame(gameCode) {
  let game = activeGames.get(gameCode);
  if (game) return game;

  // Check database for existing game
  const { data: existingGame, error } = await supabase
    .from('chess_games')
    .select('*')
    .eq('code', gameCode)
    .single();

  if (!error && existingGame) {
    activeGames.set(gameCode, existingGame);
    return existingGame;
  }

  // Create new game
  const newGame = {
    code: gameCode,
    status: 'waiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: createdGame, error: createError } = await supabase
    .from('chess_games')
    .insert(newGame)
    .select()
    .single();

  if (createError) throw createError;

  activeGames.set(gameCode, createdGame);
  return createdGame;
}

async function processMove(gameCode, from, to, player, promotion ) {
  try {
    const game = activeGames.get(gameCode);
    if (!game) throw new Error('Game not found');

    const chess = new Chess(game.fen);

    // Handle bet deduction on first move (if applicable)
    if ((player === 'white' || player === 'black') && (!game.moves || game.moves.length === (player === 'black' ? 1 : 0))) {
      try {
        const phone = player === 'white' ? game.white_phone : game.black_phone;
        if (phone && game.bet) {
          // Updated to include transaction tracking
          const newBalance = await updatePlayerBalance(
            phone,
            -game.bet,
            'bet',
            gameCode,
            `Game bet for match ${gameCode}`
          );
          
          const room = gameRooms.get(gameCode);
          const socketId = player === 'white' ? room?.white : room?.black;
          
          if (socketId) {
            io.to(socketId).emit('balanceUpdate', {
              amount: -game.bet,
              newBalance: newBalance,
              message: `$${game.bet} deducted for game bet`,
              transaction: {
                type: 'bet',
                gameId: gameCode,
                timestamp: new Date().toISOString()
              }
            });
          }
        }
      } catch (error) {
        console.error('Failed to deduct bet:', error);
        throw new Error('Failed to process bet. Please try again.');
      }
    }

    // Validate turn
    if ((chess.turn() === 'w' && player !== 'white') ||
        (chess.turn() === 'b' && player !== 'black')) {
        throw new Error("It's not your turn");
    }

    // Validate promotion piece if this is a promotion move
    const movingPiece = chess.get(from);
    const isPromotion = movingPiece?.type === 'p' && 
                       ((player === 'white' && to[1] === '8') || 
                        (player === 'black' && to[1] === '1'));

    const validPromotions = ['q', 'r', 'b', 'n'];
    if (isPromotion && (!promotion || !validPromotions.includes(promotion))) {
      throw new Error('Invalid promotion piece. Choose q (queen), r (rook), b (bishop), or n (knight)');
    }

    // Execute move
    const move = chess.move({ 
      from, 
      to, 
      promotion: isPromotion ? promotion : undefined
    });

    if (!move) throw new Error('Invalid move');

    // Update move history
    const moves = Array.isArray(game.moves) ? game.moves : [];
    moves.push({ 
      from, 
      to, 
      player,
      promotion: isPromotion ? promotion : null,
      timestamp: new Date().toISOString() 
    });

    // Timer logic
    if (moves.length === 1 && !gameTimers[gameCode]) {
      startGameTimer(gameCode, game.time_control || 600);
    } else if (gameTimers[gameCode]) {
      gameTimers[gameCode].currentTurn = chess.turn() === 'w' ? 'white' : 'black';
      gameTimers[gameCode].lastUpdate = Date.now();
    }

    // Update game state
    const updatedState = {
      fen: chess.fen(),
      turn: chess.turn() === 'w' ? 'white' : 'black',
      moves,
      white_time: gameTimers[gameCode]?.whiteTime || game.white_time,
      black_time: gameTimers[gameCode]?.blackTime || game.black_time,
      updated_at: new Date().toISOString(),
      draw_offer: null
    };

    // Save to database
    const { data: updatedGame, error } = await supabase
      .from('chess_games')
      .update(updatedState)
      .eq('code', gameCode)
      .select()
      .single();

    if (error) throw error;

    activeGames.set(gameCode, updatedGame);

    // Prepare response with transaction info if bet was deducted
    const response = {
      success: true,
      gameState: updatedGame,
      move,
      whiteTime: gameTimers[gameCode]?.whiteTime,
      blackTime: gameTimers[gameCode]?.blackTime
    };

    // Add bet information if this was the first move
    if ((player === 'white' && moves.length === 1) || (player === 'black' && moves.length === 2)) {
      response.betDeducted = {
        player,
        amount: game.bet,
        transactionType: 'bet'
      };
    }

    return response;

  } catch (error) {
    console.error('Move processing error:', error);
    throw error;
  }
}
async function updatePlayerBalance(phone, amount, transactionType, gameCode = null, description = '') {
  try {
    // Get current balance
    const { data: user, error } = await supabase
      .from('users')
      .select('balance')
      .eq('phone', phone)
      .single();

    if (error) throw error;
    if (!user) throw new Error('User not found');

    const balanceBefore = user.balance || 0;
    const newBalance = Math.max(0, balanceBefore + amount);

    // Update balance
    const { error: updateError } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('phone', phone);

    if (updateError) throw updateError;

    // Record transaction
    await recordTransaction({
      player_phone: phone,
      transaction_type: transactionType,
      amount: amount,
      balance_before: balanceBefore,
      balance_after: newBalance,
      game_id: gameCode,
      description: description || `${transactionType} ${amount >= 0 ? '+' : ''}${amount}`
    });

    return newBalance;
  } catch (error) {
    console.error('Balance update error:', error);
    throw error;
  }
}
function startGameTimer(gameCode, initialTime = 600) {
  if (gameTimers[gameCode]) {
    clearInterval(gameTimers[gameCode].interval);
    delete gameTimers[gameCode];
  }

  gameTimers[gameCode] = {
    whiteTime: initialTime,
    blackTime: initialTime,
    lastUpdate: Date.now(),
    currentTurn: 'white',
    interval: setInterval(async () => {
      try {
        const now = Date.now();
        const elapsed = Math.floor((now - gameTimers[gameCode].lastUpdate) / 1000);
        gameTimers[gameCode].lastUpdate = now;

        const room = gameRooms.get(gameCode);
        const game = activeGames.get(gameCode);

        // Update current player's time
        if (gameTimers[gameCode].currentTurn === 'white') {
          gameTimers[gameCode].whiteTime = Math.max(0, gameTimers[gameCode].whiteTime - elapsed);
          
          if (gameTimers[gameCode].whiteTime <= 0) {
            const endedGame = await endGame(gameCode, 'black', 'timeout');
            
            // Notify black player (winner)
            if (room?.black) {
              io.to(room.black).emit('gameWon', {
                animation: 'moneyIncrease',
                amount: endedGame.winningAmount,
                newBalance: endedGame.winnerNewBalance,
                reason: 'Time out! You won!'
              });
            }
            
            // Notify white player (loser)
            if (room?.white) {
              io.to(room.white).emit('gameLost', {
                animation: 'moneyDecrease',
                amount: -endedGame.betAmount,
                newBalance: endedGame.loserNewBalance,
                reason: 'You ran out of time!'
              });
            }

            clearInterval(gameTimers[gameCode].interval);
            delete gameTimers[gameCode];
            return;
          }
        } else {
          gameTimers[gameCode].blackTime = Math.max(0, gameTimers[gameCode].blackTime - elapsed);
          if (gameTimers[gameCode].blackTime <= 0) {
            const endedGame = await endGame(gameCode, 'white', 'timeout');
            
            // Notify white player (winner)
            if (room?.white) {
              io.to(room.white).emit('gameWon', {
                animation: 'moneyIncrease',
                amount: endedGame.winningAmount,
                newBalance: endedGame.winnerNewBalance,
                reason: 'Time out! You won!'
              });
            }
            
            // Notify black player (loser)
            if (room?.black) {
              io.to(room.black).emit('gameLost', {
                animation: 'moneyDecrease',
                amount: -endedGame.betAmount,
                newBalance: endedGame.loserNewBalance,
                reason: 'You ran out of time!'
              });
            }

            clearInterval(gameTimers[gameCode].interval);
            delete gameTimers[gameCode];
            return;
          }
        }

        // Send timer updates
        io.to(gameCode).emit('timerUpdate', {
          whiteTime: gameTimers[gameCode].whiteTime,
          blackTime: gameTimers[gameCode].blackTime,
          currentTurn: gameTimers[gameCode].currentTurn
        });

      } catch (error) {
        console.error('Timer error:', error);
        if (gameTimers[gameCode]) {
          clearInterval(gameTimers[gameCode].interval);
          delete gameTimers[gameCode];
        }
      }
    }, 1000)
  };

  // Send initial timer state
  io.to(gameCode).emit('timerUpdate', {
    whiteTime: gameTimers[gameCode].whiteTime,
    blackTime: gameTimers[gameCode].blackTime,
    currentTurn: gameTimers[gameCode].currentTurn
  });
}
async function endGame(gameCode, winner, result) {
  try {
    // 1. Get game data
    const { data: game, error: gameError } = await supabase
      .from('chess_games')
      .select('*')
      .eq('code', gameCode)
      .single();

    if (gameError) throw gameError;

    // 2. Prepare game result data
    const updateData = {
      status: 'finished',
      winner,
      result: result.slice(0, 10), // Ensure result isn't too long
      updated_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    };

    // 3. Initialize transaction variables
    let winnerTransaction = null;
    let loserTransaction = null;
    let commissionTransaction = null;
    const room = gameRooms.get(gameCode);

    // 4. Process financial transactions if there was a bet
    if (game.bet && game.bet > 0 && winner) {
      const totalPrizePool = game.bet * 2;
      const commissionAmount = totalPrizePool * 0.1; // 10% commission
      const winnerPayout = totalPrizePool - commissionAmount;

      // Get current balances for both players
      const [{ data: winnerData }, { data: loserData }] = await Promise.all([
        supabase.from('users').select('balance').eq('phone', winner === 'white' ? game.white_phone : game.black_phone).single(),
        supabase.from('users').select('balance').eq('phone', winner === 'white' ? game.black_phone : game.white_phone).single()
      ]);

      // Update winner's balance (gets 90%)
      if (winner === 'white' && game.white_phone) {
        const winnerNewBalance = await updatePlayerBalance(
          game.white_phone,
          winnerPayout,
          'win',
          gameCode,
          `Won game against ${game.black_phone} (${result})`
        );
        
        winnerTransaction = {
          player: game.white_phone,
          amount: winnerPayout,
          newBalance: winnerNewBalance
        };

        // Notify winner
        if (room?.white) {
          io.to(room.white).emit('gameWon', {
            amount: winnerPayout,
            newBalance: winnerNewBalance,
            transaction: await supabase
              .from('player_transactions')
              .select('*')
              .eq('game_id', gameCode)
              .eq('player_phone', game.white_phone)
              .order('created_at', { ascending: false })
              .limit(1)
              .single()
          });
        }
      } 
      else if (winner === 'black' && game.black_phone) {
        const winnerNewBalance = await updatePlayerBalance(
          game.black_phone,
          winnerPayout,
          'win',
          gameCode,
          `Won game against ${game.white_phone} (${result})`
        );
        
        winnerTransaction = {
          player: game.black_phone,
          amount: winnerPayout,
          newBalance: winnerNewBalance
        };

        // Notify winner
        if (room?.black) {
          io.to(room.black).emit('gameWon', {
            amount: winnerPayout,
            newBalance: winnerNewBalance,
            transaction: await supabase
              .from('player_transactions')
              .select('*')
              .eq('game_id', gameCode)
              .eq('player_phone', game.black_phone)
              .order('created_at', { ascending: false })
              .limit(1)
              .single()
          });
        }
      }

      // Record loss for the other player (no balance change, just for history)
      const loserPhone = winner === 'white' ? game.black_phone : game.white_phone;
      if (loserPhone) {
        const loserBalanceBefore = winner === 'white' ? 
          (loserData?.balance || 0) : 
          (winnerData?.balance || 0);
        
        await recordTransaction({
          player_phone: loserPhone,
          transaction_type: 'loss',
          amount: -game.bet,
          balance_before: loserBalanceBefore,
          balance_after: loserBalanceBefore, // No change (already deducted)
          game_id: gameCode,
          description: `Lost game to ${winner === 'white' ? game.white_phone : game.black_phone} (${result})`,
          status: 'completed'
        });

        loserTransaction = {
          player: loserPhone,
          amount: -game.bet,
          newBalance: loserBalanceBefore
        };

        // Notify loser
        const loserSocket = winner === 'white' ? room?.black : room?.white;
        if (loserSocket) {
          io.to(loserSocket).emit('gameLost', {
            amount: -game.bet,
            newBalance: loserBalanceBefore,
            transaction: await supabase
              .from('player_transactions')
              .select('*')
              .eq('game_id', gameCode)
              .eq('player_phone', loserPhone)
              .order('created_at', { ascending: false })
              .limit(1)
              .single()
          });
        }
      }

      // Update house balance (gets 10%)
      const newHouseBalance = await updateHouseBalance(commissionAmount);
      commissionTransaction = {
        amount: commissionAmount,
        newBalance: newHouseBalance
      };
    }

    // 5. Update game status in database
    const { error: updateError } = await supabase
      .from('chess_games')
      .update(updateData)
      .eq('code', gameCode);

    if (updateError) throw updateError;

    // 6. Clean up game state
    if (gameTimers[gameCode]) {
      clearInterval(gameTimers[gameCode].interval);
      delete gameTimers[gameCode];
    }
    activeGames.delete(gameCode);
    gameRooms.delete(gameCode);

    // 7. Return comprehensive result
    return {
      ...game,
      ...updateData,
      transactions: {
        winner: winnerTransaction,
        loser: loserTransaction,
        commission: commissionTransaction
      },
      financials: {
        betAmount: game.bet || 0,
        prizePool: game.bet ? game.bet * 2 : 0,
        commission: game.bet ? game.bet * 0.2 : 0,
        winnerPayout: game.bet ? game.bet * 1.8 : 0
      }
    };

  } catch (error) {
    console.error('Error ending game:', error);
    
    // Attempt to mark game as failed if error occurred
    try {
      await supabase
        .from('chess_games')
        .update({
          status: 'error',
          updated_at: new Date().toISOString()
        })
        .eq('code', gameCode);
    } catch (cleanupError) {
      console.error('Failed to mark game as error:', cleanupError);
    }
    
    throw error;
  }
}
async function updateHouseBalance(amount) {
  try {
    // Get current house balance
    const { data: house, error } = await supabase
      .from('house_balance')
      .select('balance')
      .eq('id', 1) // Assuming you have a row with id=1 for house balance
      .single();

    if (error) throw error;

    // Calculate new balance
    const newBalance = (house?.balance || 0) + amount;

    // Update house balance
    const { error: updateError } = await supabase
      .from('house_balance')
      .update({ balance: newBalance })
      .eq('id', 1);

    if (updateError) throw updateError;

    return newBalance;
  } catch (error) {
    console.error('House balance update error:', error);
    throw error;
  }
}
function checkGameEndConditions(gameCode, gameState) {
  const chess = new Chess(gameState.fen);
  
  if (chess.isGameOver()) {
    let result, winner;
    
    if (chess.isCheckmate()) {
      winner = chess.turn() === 'w' ? 'black' : 'white';
      result = 'checkmate';
    } else if (chess.isDraw()) {
      winner = null;
      result = 'draw';
    } else if (chess.isStalemate()) {
      winner = null;
      result = 'stalemate';
    } else if (chess.isThreefoldRepetition()) {
      winner = null;
      result = 'repetition';
    } else if (chess.isInsufficientMaterial()) {
      winner = null;
      result = 'insufficient material';
    }

    if (result) {
      endGame(gameCode, winner, result);
      io.to(gameCode).emit('gameOver', { winner, reason: result });
    }
  }
}

// REST API Endpoints
app.get('/api/game-by-code/:code', async (req, res) => {
  try {
    const { data: game, error } = await supabase
      .from('chess_games')
      .select('*')
      .eq('code', req.params.code)
      .single();

    if (error || !game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json(game);
  } catch (error) {
    console.error('Game fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    const { gameCode, from, to, player } = req.body;
    
    if (!gameCode || !from || !to || !player) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await processMove(gameCode, from, to, player);
    
    if (io.sockets.adapter.rooms.get(gameCode)) {
      io.to(gameCode).emit('gameUpdate', result);
    }

    checkGameEndConditions(gameCode, result.gameState);

    res.json(result);
  } catch (error) {
    console.error('Move error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/offer-draw', async (req, res) => {
  try {
    const { gameCode, player } = req.body;
    
    const { data: game, error } = await supabase
      .from('chess_games')
      .update({ 
        draw_offer: player,
        updated_at: new Date().toISOString()
      })
      .eq('code', gameCode)
      .select()
      .single();

    if (error) throw error;
    
    if (io.sockets.adapter.rooms.get(gameCode)) {
      io.to(gameCode).emit('drawOffer', { player });
    }

    activeGames.set(gameCode, game);
    res.json({ success: true, game });

  } catch (error) {
    console.error('Draw offer error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/resign', async (req, res) => {
  try {
    const { gameCode, player } = req.body;
    const winner = player === 'white' ? 'black' : 'white';
    
    await endGame(gameCode, winner, 'resignation');
    
    if (io.sockets.adapter.rooms.get(gameCode)) {
      io.to(gameCode).emit('gameOver', { winner, reason: 'resignation' });
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Resign error:', error);
    res.status(400).json({ error: error.message });
  }
});
app.get('/api/transactions/:phone', async (req, res) => {
  try {
    const transactions = await getPlayerTransactions(req.params.phone);
    res.json(transactions);
  } catch (error) {
    console.error('Transactions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});
app.post('/api/start-timer', async (req, res) => {
  try {
    const { gameCode, timeControl } = req.body;
    startGameTimer(gameCode, timeControl);
    res.json({ success: true });
  } catch (error) {
    console.error('Timer start error:', error);
    res.status(400).json({ error: error.message });
  }
});
// Add this to your server initialization
const abandonedGameChecker = setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes
    
    const { data: abandonedGames } = await supabase
      .from('chess_games')
      .select('code, status, created_at')
      .or('status.eq.ongoing,status.eq.waiting')
      .lt('updated_at', cutoff);

    for (const game of abandonedGames) {
      await supabase
        .from('chess_games')
        .update({
          status: 'finished',
          result: 'abandoned',
          updated_at: new Date().toISOString()
        })
        .eq('code', game.code);

      // Clean up in-memory state if exists
      if (activeGames.has(game.code)) {
        if (gameTimers[game.code]) {
          clearInterval(gameTimers[game.code].interval);
          delete gameTimers[game.code];
        }
        activeGames.delete(game.code);
        gameRooms.delete(game.code);
      }

      console.log(`Marked abandoned game ${game.code}`);
    }
  } catch (error) {
    console.error('Abandoned game checker error:', error);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Clean up on server shutdown
process.on('SIGTERM', () => {
  clearInterval(abandonedGameChecker);
});
async function recordTransaction(transactionData) {
  try {
    const { data, error } = await supabase
      .from('player_transactions')
      .insert(transactionData)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Transaction recording error:', error);
    throw error;
  }
}

async function getPlayerTransactions(phone) {
  try {
    const { data, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching transactions:', error);
    throw error;
  }
}
// Get user balance
app.get('/api/balance', async (req, res) => {
  try {
      const { phone } = req.query;
      if (!phone) return res.status(400).json({ error: 'Phone number required' });

      const { data: user, error } = await supabase
          .from('users')
          .select('balance')
          .eq('phone', phone)
          .single();

      if (error || !user) throw error || new Error('User not found');
      
      res.json({ balance: user.balance || 0 });
  } catch (error) {
      console.error('Balance fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Process deposit
app.post('/api/deposit', async (req, res) => {
  try {
      const { phone, amount, method } = req.body;
      if (!phone || !amount || amount <= 0) {
          return res.status(400).json({ error: 'Invalid deposit request' });
      }

      // In a real app, you would process payment here
      // For demo, we'll just update the balance
      
      const newBalance = await updatePlayerBalance(
          phone,
          amount,
          'deposit',
          null,
          `Deposit via ${method}`
      );

      res.json({ success: true, newBalance });
  } catch (error) {
      console.error('Deposit error:', error);
      res.status(500).json({ error: 'Deposit failed' });
  }
});

// Process withdrawal
app.post('/api/withdraw', async (req, res) => {
  try {
      const { phone, amount, method } = req.body;
      if (!phone || !amount || amount <= 0) {
          return res.status(400).json({ error: 'Invalid withdrawal request' });
      }

      // Check balance first
      const { data: user, error: userError } = await supabase
          .from('users')
          .select('balance')
          .eq('phone', phone)
          .single();

      if (userError || !user) throw userError || new Error('User not found');
      if (user.balance < amount) {
          return res.status(400).json({ error: 'Insufficient balance' });
      }

      // In a real app, you would process withdrawal here
      // For demo, we'll just update the balance
      
      const newBalance = await updatePlayerBalance(
          phone,
          -amount,
          'withdrawal',
          null,
          `Withdrawal via ${method}`
      );

      res.json({ 
          success: true, 
          newBalance,
          message: 'Withdrawal request received. Processing may take 1-3 business days.'
      });
  } catch (error) {
      console.error('Withdrawal error:', error);
      res.status(500).json({ error: 'Withdrawal failed' });
  }
});
app.post('/api/accept-draw', async (req, res) => {
  try {
    const { gameCode, player } = req.body;
    
    const game = activeGames.get(gameCode);
    if (!game) throw new Error('Game not found');
    
    if (!game.draw_offer || game.draw_offer === player) {
      throw new Error('No valid draw offer to accept');
    }

    const room = gameRooms.get(gameCode);
    if (!room) throw new Error('Game room not found');

    // Refund each player only their own bet
    let refundTransactions = [];
    
    if (game.bet && game.bet > 0) {
      // Refund current player
      const currentPlayerPhone = player === 'white' ? game.white_phone : game.black_phone;
      if (currentPlayerPhone) {
        const newBalance = await updatePlayerBalance(
          currentPlayerPhone,
          game.bet,
          'refund',
          gameCode,
          `Draw refund for game ${gameCode}`
        );
        refundTransactions.push({
          player,
          amount: game.bet,
          newBalance
        });
      }

      // Refund opponent
      const opponent = player === 'white' ? 'black' : 'white';
      const opponentPhone = opponent === 'white' ? game.white_phone : game.black_phone;
      if (opponentPhone) {
        const newBalance = await updatePlayerBalance(
          opponentPhone,
          game.bet,
          'refund',
          gameCode,
          `Draw refund for game ${gameCode}`
        );
        refundTransactions.push({
          player: opponent,
          amount: game.bet,
          newBalance
        });
      }
    }

    const endedGame = await endGame(gameCode, null, 'agreement');
    
    if (io.sockets.adapter.rooms.get(gameCode)) {
      io.to(gameCode).emit('gameOver', {
        winner: null,
        reason: 'Draw by agreement',
        refunds: refundTransactions
      });
    }

    res.json({ 
      success: true,
      game: endedGame,
      refunds: refundTransactions
    });

  } catch (error) {
    console.error('Accept draw error:', error);
    res.status(400).json({ error: error.message });
  }
});
