const WebSocket = require("ws");
const https = require("https");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const { alignAndMergeAudios } = require("./index.cjs");
const { uploadRecordingToSupabase } = require("./uploadFile");
const { updateRecording } = require("./db/queries.js");
const options = {
  key: fs.readFileSync("./my-app/certificates/localhost-key.pem"),
  cert: fs.readFileSync("./my-app/certificates/localhost.pem"),
};
const {
  roomQueries,
  recordingQueries,
  incrementCurrentParticipants,
  decrementCurrentParticipants,
} = require("./db/queries.js");

const roomDbIds = new Map();

const server = https.createServer(options);
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    done(true);
  },
});

// Store rooms and their participants
const rooms = new Map();
// Store active connections
const connections = new Map();
// Store room recordings
const roomRecordings = new Map();

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, "recordings");
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

wss.on("connection", (ws) => {
  console.log("New client connected");
  const connectionId = Date.now().toString();
  connections.set(connectionId, {
    ws,
    userName: null,
    roomId: null,
    name: null,
    id: null,
    imageUrl: null,
    roomNumberId: null,
  });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      console.log("Received message:", data.type, "from:", data.userName);

      switch (data.type) {
        case "create_room":
          handleCreateRoom(ws, data, connectionId);
          break;
        case "join_room":
          handleJoinRoom(ws, data, connectionId);
          break;
        case "leave_room":
          handleLeaveRoom(ws, data);
          break;
        case "message":
          handleMessage(ws, data);
          break;
        case "get_users":
          handleGetUsers(ws, data);
          break;
        case "voice_ready":
          handleVoiceReady(ws, data);
          break;
        case "offer":
          handleOffer(ws, data);
          break;
        case "answer":
          handleAnswer(ws, data);
          break;
        case "ice-candidate":
          handleIceCandidate(ws, data);
          break;
        case "recording_started":
          handleRecordingStarted(ws, data);
          break;
        case "recording_stopped":
          handleRecordingStopped(ws, data);
          break;
        case "audio_chunk":
          handleAudioChunk(ws, data);
          break;
        case "start_recording":
          console.log(`Starting recording for room ${data.roomId}`);
          if (!roomRecordings.has(data.roomId)) {
            const recording = {
              roomId: data.roomId,
              startTime: Date.now(),
              participants: new Map(),
              isRecording: true,
              recordingPath: path.join(
                recordingsDir,
                `room_${data.roomId}_${Date.now()}`
              ),
            };

            // Create directory for this room's recording
            if (!fs.existsSync(recording.recordingPath)) {
              fs.mkdirSync(recording.recordingPath, { recursive: true });
            }

            roomRecordings.set(data.roomId, recording);

            // Notify all users in the room that recording has started
            const roomUsers = rooms.get(data.roomId) || [];
            roomUsers.forEach((user) => {
              const userWs = connections.get(user);
              if (
                userWs &&
                userWs.ws &&
                userWs.ws.readyState === WebSocket.OPEN
              ) {
                userWs.ws.send(
                  JSON.stringify({
                    type: "recording_started",
                    roomId: data.roomId,
                    userName: userWs.userName,
                  })
                );
              }
            });
          }
          break;
        default:
          console.log("Unknown message type:", data.type);
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    handleDisconnect(connectionId);
    connections.delete(connectionId);
  });
});

function handleCreateRoom(ws, data, connectionId) {
  const { roomId, userName, roomNumberId, name, imageUrl } = data;

  if (rooms.has(roomId)) {
    const existingUsers = getUsersInRoom(roomId);
    const isUserAlreadyInRoom = existingUsers.some(
      (user) => user.userName === userName
    );

    if (isUserAlreadyInRoom) {
      const users = getUsersInRoom(roomId);
      ws.send(
        JSON.stringify({
          type: "room_created",
          roomId,
          message: `You are already in room ${roomId}`,
          users: users,
        })
      );
      return;
    } else {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Room already exists",
        })
      );
      return;
    }
  }
  incrementCurrentParticipants(roomId);
  const roomSet = new Set();
  roomSet.add(connectionId);
  rooms.set(roomId, roomSet);

  const connectionInfo = connections.get(connectionId);
  connectionInfo.userName = userName;
  connectionInfo.roomId = roomId;
  connectionInfo.roomNumberId = roomNumberId;
  connectionInfo.imageUrl = imageUrl;
  connectionInfo.name = name;

  ws.userName = userName;
  ws.roomId = roomId;
  ws.connectionId = connectionId;

  roomQueries.getRoomByRoomId(roomId).then((roomData) => {
    if (roomData) {
      roomDbIds.set(roomId, roomData.id);
      console.log(`Room ${roomId} mapped to DB ID ${roomData.id}`);
    }
  });

  const users = getUsersInRoom(roomId);

  ws.send(
    JSON.stringify({
      type: "room_created",
      roomId,
      message: `Room ${roomId} created successfully`,
      users: users,
    })
  );

  console.log(`Room ${roomId} created by ${userName}`);
}

function handleJoinRoom(ws, data, connectionId) {
  const { roomId, userName, roomNumberId, name, imageUrl } = data;

  if (!rooms.has(roomId)) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Room does not exist",
      })
    );
    return;
  }

  const room = rooms.get(roomId);

  if (room.has(connectionId)) {
    const users = getUsersInRoom(roomId);
    ws.send(
      JSON.stringify({
        type: "welcome",
        roomId,
        message: `You are already in room ${roomId}!`,
        users: users,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  const existingUsers = getUsersInRoom(roomId);
  const isUserInRoom = existingUsers.some((user) => user.userName === userName);

  if (isUserInRoom) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "User already in room",
      })
    );
    return;
  }

  room.add(connectionId);

  const connectionInfo = connections.get(connectionId);
  connectionInfo.userName = userName;
  connectionInfo.roomId = roomId;
  connectionInfo.roomNumberId = roomNumberId;
  connectionInfo.imageUrl = imageUrl;
  connectionInfo.name = name;
  incrementCurrentParticipants(roomId);

  ws.userName = userName;
  ws.roomId = roomId;
  ws.connectionId = connectionId;

  if (!roomDbIds.has(roomId)) {
    roomQueries.getRoomByRoomId(roomId).then((roomData) => {
      if (roomData) {
        roomDbIds.set(roomId, roomData.id);
        console.log(`Room ${roomId} mapped to DB ID ${roomData.id}`);
      }
    });
  }

  const users = getUsersInRoom(roomId);

  broadcastToRoom(roomId, {
    type: "user_joined",
    userName,
    message: `${userName} joined the room`,
    users: users,
    timestamp: new Date().toISOString(),
  });

  ws.send(
    JSON.stringify({
      type: "welcome",
      roomId,
      message: `Welcome to room ${roomId}!`,
      users: users,
      timestamp: new Date().toISOString(),
    })
  );

  console.log(`${userName} joined room ${roomId}`);
}

async function handleLeaveRoom(ws, data) {
  const { roomId, roomNumberId } = data;
  const room = rooms.get(roomId); // Add this missing line

  if (rooms.has(roomId) && ws.connectionId) {
    room.delete(ws.connectionId);

    const connectionInfo = connections.get(ws.connectionId);
    if (connectionInfo) {
      connectionInfo.roomId = null;
    }

    const users = getUsersInRoom(roomId);

    broadcastToRoom(roomId, {
      type: "user_left",
      userName: ws.userName,
      message: `${ws.userName} left the room`,
      users: users,
      timestamp: new Date().toISOString(),
    });

    decrementCurrentParticipants(roomId);
    console.log("decrementing in Leave Room");
    if (room.size === 0) {
      await endRoomInDatabase(roomId);
      rooms.delete(roomId);

      // If there's an active recording for this room, finalize it
      if (roomRecordings.has(roomId)) {
        const recording = roomRecordings.get(roomId);
        // Force stop recording and combine
        setTimeout(async () => {
          await combineRecordings(roomId, roomNumberId, recording);
        }, 2000); // Give 2 seconds for any pending audio processing
      }

      console.log(`Room ${roomId} deleted (empty)`);
    }
  }
}

function handleMessage(ws, data) {
  const { roomId, message, name } = data;

  if (rooms.has(roomId)) {
    broadcastToRoom(roomId, {
      type: "message",
      userName: ws.userName,
      name: name,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
  
function handleGetUsers(ws, data) {
  const { roomId } = data;

  if (!rooms.has(roomId)) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Room does not exist",
      })
    );
    return;
  }

  const users = getUsersInRoom(roomId);
  ws.send(
    JSON.stringify({
      type: "room_users",
      roomId,
      users,
    })
  );
}

async function handleDisconnect(connectionId) {
  const connectionInfo = connections.get(connectionId);

  if (connectionInfo && connectionInfo.roomId) {
    const roomId = connectionInfo.roomId;
    const roomNumberId = connectionInfo.roomNumberId;
    const room = rooms.get(roomId); // Add this missing line

    if (room) {
      room.delete(connectionId);

      const users = getUsersInRoom(roomId);

      broadcastToRoom(roomId, {
        type: "user_left",
        userName: connectionInfo.userName,
        message: `${connectionInfo.userName} left the room`,
        users: users,
        timestamp: new Date().toISOString(),
      });

      decrementCurrentParticipants(roomId);
      console.log("decrementing in disconnect Room");

      if (room.size === 0) {
        rooms.delete(roomId);

        await endRoomInDatabase(roomId);

        // If there's an active recording for this room, finalize it
        if (roomRecordings.has(roomId)) {
          const recording = roomRecordings.get(roomId);
          // Force stop recording and combine
          setTimeout(async () => {
            await combineRecordings(roomId, roomNumberId, recording);
          }, 2000); // Give 2 seconds for any pending audio processing
        }

        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
  }
}

async function endRoomInDatabase(roomId) {
  try {
    const endTime = new Date();
    const result = await roomQueries.endRoom(roomId, endTime);

    if (result) {
      console.log(
        `✅ Room ${roomId} ended in database at ${endTime.toISOString()}`
      );

      // Clean up the room DB ID cache
      roomDbIds.delete(roomId);
    } else {
      console.log(`⚠️ Room ${roomId} not found in database or already ended`);
    }
  } catch (error) {
    console.error(`❌ Error ending room ${roomId} in database:`, error);
  }
}

function getUsersInRoom(roomId) {
  if (!rooms.has(roomId)) {
    return [];
  }

  const room = rooms.get(roomId);
  const users = [];

  room.forEach((connectionId) => {
    const connectionInfo = connections.get(connectionId);
    if (connectionInfo && connectionInfo.userName) {
      users.push({
        userName: connectionInfo.userName,
        name: connectionInfo.name,
        imageUrl: connectionInfo.imageUrl,
        isConnected: true,
      });
    }
  });

  return users;
}

function broadcastToRoom(roomId, message) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    const messageStr = JSON.stringify(message);

    room.forEach((connectionId) => {
      const connectionInfo = connections.get(connectionId);
      if (
        connectionInfo &&
        connectionInfo.ws &&
        connectionInfo.ws.readyState === WebSocket.OPEN
      ) {
        connectionInfo.ws.send(messageStr);
      }
    });
  }
}

function handleVoiceReady(ws, data) {
  const { roomId, userName } = data;
  console.log(`${userName} is ready for voice chat in room ${roomId}`);

  const room = rooms.get(roomId);
  if (room) {
    const otherUsers = Array.from(room).filter((connId) => {
      const conn = connections.get(connId);
      return conn && conn.userName !== userName;
    });

    console.log(
      `Notifying ${otherUsers.length} other users about ${userName}'s voice readiness`
    );

    otherUsers.forEach((connId) => {
      const conn = connections.get(connId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        console.log(`Sending voice_ready notification to ${conn.userName}`);
        conn.ws.send(
          JSON.stringify({
            type: "voice_ready",
            userName: userName,
            roomId: roomId,
          })
        );
      }
    });
  }
}

function handleOffer(ws, data) {
  const { roomId, offer, targetPeer, userName } = data;
  console.log(
    `Forwarding offer from ${userName} to ${targetPeer} in room ${roomId}`
  );

  const room = rooms.get(roomId);
  if (room) {
    const targetConnection = Array.from(room).find((connId) => {
      const conn = connections.get(connId);
      return conn && conn.userName === targetPeer;
    });

    if (targetConnection) {
      const conn = connections.get(targetConnection);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        console.log(`Successfully forwarding offer to ${targetPeer}`);
        conn.ws.send(
          JSON.stringify({
            type: "offer",
            offer: offer,
            userName: userName,
            roomId: roomId,
          })
        );
      } else {
        console.log(`Target user ${targetPeer} connection not open`);
      }
    } else {
      console.log(`Target user ${targetPeer} not found in room ${roomId}`);
    }
  }
}

function handleAnswer(ws, data) {
  const { roomId, answer, targetPeer, userName } = data;
  console.log(
    `Forwarding answer from ${userName} to ${targetPeer} in room ${roomId}`
  );

  const room = rooms.get(roomId);
  if (room) {
    const targetConnection = Array.from(room).find((connId) => {
      const conn = connections.get(connId);
      return conn && conn.userName === targetPeer;
    });

    if (targetConnection) {
      const conn = connections.get(targetConnection);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        console.log(`Successfully forwarding answer to ${targetPeer}`);
        conn.ws.send(
          JSON.stringify({
            type: "answer",
            answer: answer,
            userName: userName,
            roomId: roomId,
          })
        );
      }
    }
  }
}

function handleIceCandidate(ws, data) {
  const { roomId, candidate, targetPeer, userName } = data;
  console.log(`Forwarding ICE candidate from ${userName} to ${targetPeer}`);

  const room = rooms.get(roomId);
  if (room) {
    const targetConnection = Array.from(room).find((connId) => {
      const conn = connections.get(connId);
      return conn && conn.userName === targetPeer;
    });

    if (targetConnection) {
      const conn = connections.get(targetConnection);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: candidate,
            userName: userName,
            roomId: roomId,
          })
        );
      }
    }
  }
}

function handleRecordingStarted(ws, data) {
  const { roomId, userName, startTime } = data;

  if (!roomRecordings.has(roomId)) {
    const recordingData = {
      roomId,
      startTime,
      participants: new Map(),
      isRecording: true,
      isCombining: false,
      recordingPath: path.join(recordingsDir, `room_${roomId}_${Date.now()}`),
    };

    // Create directory for this room's recording
    if (!fs.existsSync(recordingData.recordingPath)) {
      fs.mkdirSync(recordingData.recordingPath, { recursive: true });
    }

    roomRecordings.set(roomId, recordingData);
    console.log(`Started recording for room ${roomId}`);
  }

  const recording = roomRecordings.get(roomId);
  if (!recording.participants.has(userName)) {
    // Create user-specific directory
    const userDir = path.join(recording.recordingPath, userName);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    // Create temporary WebM file for collecting audio chunks
    const tempWebmPath = path.join(userDir, `temp_${Date.now()}.webm`);
    const finalMp3Path = path.join(userDir, `recording_${Date.now()}.mp3`);

    recording.participants.set(userName, {
      userName,
      audioChunks: [],
      tempWebmPath,
      finalMp3Path,
      fileStream: fs.createWriteStream(tempWebmPath),
      startTime,
      userDir,
    });
    console.log(`Added ${userName} to recording session`);
  }
}

async function handleRecordingStopped(ws, data) {
  const { roomId, userName, roomNumberId } = data;
  console.log(`Recording stopped for user ${userName} in room ${roomId}`);

  if (roomRecordings.has(roomId)) {
    const recording = roomRecordings.get(roomId);
    const participant = recording.participants.get(userName);

    if (participant && participant.fileStream) {
      // Close the file stream
      participant.fileStream.end();
      participant.fileStream = null; // Mark as stopped
      console.log(`Closed file stream for ${userName} in room ${roomId}`);

      // Convert WebM to MP3
      ffmpeg(participant.tempWebmPath)
        .toFormat("mp3")
        .audioBitrate("192k")
        .on("end", async () => {
          console.log(`Converted recording to MP3 for ${userName}`);

          // Delete the temporary WebM file
          fs.unlink(participant.tempWebmPath, (err) => {
            if (err)
              console.error(`Error deleting temp file for ${userName}:`, err);
          });

          // Create metadata file
          const metadata = {
            userName,
            startTime: participant.startTime,
            endTime: Date.now(),
            duration: Date.now() - participant.startTime,
            filePath: participant.finalMp3Path,
          };

          const metadataPath = path.join(participant.userDir, "metadata.json");
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

          // Check if all participants have finished processing
          const allProcessed = Array.from(
            recording.participants.values()
          ).every((p) => {
            return !p.fileStream && fs.existsSync(p.finalMp3Path);
          });

          if (allProcessed) {
            // Notify room participants that recordings are ready
            await combineRecordings(roomId, roomNumberId, recording);

            broadcastToRoom(roomId, {
              type: "recordings_ready",
              roomId,
              message: "Individual recordings are ready for download",
              recordings: Array.from(recording.participants.values()).map(
                (p) => ({
                  userName: p.userName,
                  downloadUrl: `/download/${path.relative(
                    recordingsDir,
                    p.finalMp3Path
                  )}`,
                  startTime: p.startTime,
                  duration: Date.now() - p.startTime,
                })
              ),
              timestamp: new Date().toISOString(),
            });

            // Clean up recording data
            roomRecordings.delete(roomId);
          }
        })
        .on("error", (err) => {
          console.error(`Error converting recording for ${userName}:`, err);
        })
        .save(participant.finalMp3Path);
    }
  } else {
    console.log(`No recording found for room ${roomId}`);
  }
}

function handleAudioChunk(ws, data) {
  const { roomId, userName, audioData, timestamp } = data;
  const recording = roomRecordings.get(roomId);

  if (
    recording &&
    recording.isRecording &&
    recording.participants.has(userName)
  ) {
    const participant = recording.participants.get(userName);

    try {
      // Convert base64 audio data back to buffer
      const base64Data = audioData.split(",")[1];
      if (!base64Data) {
        console.error("Invalid audio data format for user:", userName);
        return;
      }

      const audioBuffer = Buffer.from(base64Data, "base64");

      // Write to file stream
      if (participant.fileStream) {
        participant.fileStream.write(audioBuffer);
        console.log(
          `Received audio chunk from ${userName}, size: ${audioBuffer.length} bytes`
        );
      } else {
        console.log(`No file stream available for ${userName}`);
      }
    } catch (error) {
      console.error(`Error processing audio chunk from ${userName}:`, error);
    }
  } else {
    console.log(`No active recording for room ${roomId} or user ${userName}`);
  }
}

// Import the alignAndMergeAudios function at the top of your server.js file

async function combineRecordings(roomId, roomNumberId, recording) {
  console.log(`Starting to combine recordings for room ${roomId}`);
  if (recording.isCombining) {
    console.log(`⚠️ Skipping duplicate combine for room ${roomId}`);
    return;
  }
  recording.isCombining = true;

  const roomDbId = roomDbIds.get(roomId);
  console.log(roomNumberId);
  let totalDuration = null;

  // if (roomDbId) {
  //   const participantCount = recording.participants.size;
  //   recordingEntry = await recordingQueries.createRecording(
  //     roomDbId,
  //     new Date(recording.startTime),
  //     participantCount
  //   );
  // }

  // Get all participants with valid audio files
  const participantList = [];
  recording.participants.forEach((participant, userName) => {
    if (fs.existsSync(participant.finalMp3Path)) {
      const stats = fs.statSync(participant.finalMp3Path);
      if (stats.size > 0) {
        participantList.push({
          userName,
          filePath: participant.finalMp3Path,
          startTime: participant.startTime,
        });
        console.log(
          `Found audio file for ${userName}: ${
            stats.size
          } bytes, started at ${new Date(
            participant.startTime
          ).toLocaleTimeString()}`
        );
      } else {
        console.log(`Empty audio file for ${userName}`);
      }
    } else {
      console.log(`No audio file found for ${userName}`);
    }
  });

  if (participantList.length === 0) {
    console.log(`No valid audio files found for room ${roomId}`);
    roomRecordings.delete(roomId);
    return;
  }

  if (participantList.length === 1) {
    // Only one participant, just copy their file
    const singleParticipant = participantList[0];
    const outputPath = path.join(
      recording.recordingPath,
      `room_${roomId}_combined.mp3`
    );

    try {
      fs.copyFileSync(singleParticipant.filePath, outputPath);
      console.log(`Single participant recording copied to: ${outputPath}`);

      // Clean up individual file
      fs.unlinkSync(singleParticipant.filePath);

      const supabaseUrl = await uploadRecordingToSupabase(outputPath, roomId);
      const stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
      const fileSize = stats ? stats.size : 0;

      fs.unlinkSync(outputPath);
      console.log(`Local file deleted after Supabase upload: ${outputPath}`);

      if (roomNumberId) {
        const endTime = new Date();
        const duration = endTime.getTime() - recording.startTime;
        const totalSeconds = Math.floor(duration / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        const durationString = `${minutes} min ${seconds} sec`;
        console.log(
          "testing" +
            " " +
            roomNumberId +
            " " +
            supabaseUrl +
            " " +
            durationString
        );

        await recordingQueries.updateRecording(
          roomNumberId,
          supabaseUrl,
          durationString
        );
      }

      // Notify room participants
      broadcastToRoom(roomId, {
        type: "recording_ready",
        roomId,
        message: "Recording is ready for download",
        downloadUrl: supabaseUrl,
        timestamp: new Date().toISOString(),
      });

      roomRecordings.delete(roomId);
    } catch (error) {
      console.error(`Error copying single participant recording:`, error);
      broadcastToRoom(roomId, {
        type: "recording_error",
        roomId,
        message: "Error processing recording: " + error.message,
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  console.log(`Found ${participantList.length} audio files to combine`);

  try {
    // Sort participants by start time
    participantList.sort((a, b) => a.startTime - b.startTime);

    // Start with the first two participants
    let currentCombined = null;
    let outputPath = null;

    for (let i = 0; i < participantList.length - 1; i++) {
      const participant1 = participantList[i];
      const participant2 = participantList[i + 1];

      // Convert timestamps to readable format (HH:MM:SS AM/PM)
      const timestamp1 = new Date(participant1.startTime).toLocaleTimeString(
        "en-US",
        {
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }
      );

      const timestamp2 = new Date(participant2.startTime).toLocaleTimeString(
        "en-US",
        {
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }
      );

      // Define paths for this combination
      const audio1Path = currentCombined || participant1.filePath;
      const audio2Path = participant2.filePath;
      outputPath = path.join(
        recording.recordingPath,
        `temp_combined_${i + 1}.mp3`
      );

      console.log(
        `Combining ${
          i === 0 ? participant1.userName : "previous combination"
        } (${timestamp1}) with ${participant2.userName} (${timestamp2})`
      );

      // Use your alignAndMergeAudios function
      totalDuration = await alignAndMergeAudios(
        audio1Path,
        timestamp1,
        audio2Path,
        timestamp2,
        outputPath
      );

      console.log(`Successfully combined audio files, output: ${outputPath}`);

      // Clean up the previous temporary combined file (but not original participant files yet)
      if (currentCombined && fs.existsSync(currentCombined)) {
        fs.unlinkSync(currentCombined);
        console.log(`Cleaned up temporary file: ${currentCombined}`);
      }

      currentCombined = outputPath;
    }

    // Rename the final combined file
    const finalOutputPath = path.join(
      recording.recordingPath,
      `room_${roomId}_combined.mp3`
    );
    if (currentCombined && currentCombined !== finalOutputPath) {
      fs.renameSync(currentCombined, finalOutputPath);
      console.log(`Final combined recording saved as: ${finalOutputPath}`);
    }

    // Verify the output file exists and has content
    if (fs.existsSync(finalOutputPath)) {
      const stats = fs.statSync(finalOutputPath);
      console.log(`Combined file size: ${stats.size} bytes`);

      if (stats.size > 0) {
        try {
          console.log(`Uploading combined recording to Supabase...`);
          const supabaseUrl = await uploadRecordingToSupabase(
            finalOutputPath,
            roomId
          );
          console.log(`Successfully uploaded to Supabase: ${supabaseUrl}`);
          const fileSize = stats.size;

          fs.unlinkSync(finalOutputPath);
          console.log(
            `Local combined file deleted after Supabase upload: ${finalOutputPath}`
          );
          if (roomNumberId) {
            console.log(
              "testing" +
                " " +
                roomNumberId +
                " " +
                supabaseUrl +
                " " +
                totalDuration
            );
            if (totalDuration != null) {
              console.log("ok");
              await recordingQueries.updateRecording(
                roomNumberId,
                supabaseUrl,
                totalDuration.toString()
              );
            }
          }

          // Clean up individual participant files
          participantList.forEach((participant) => {
            try {
              if (fs.existsSync(participant.filePath)) {
                fs.unlinkSync(participant.filePath);
                console.log(`Cleaned up: ${participant.filePath}`);
              }
            } catch (error) {
              console.error(
                `Error cleaning up ${participant.filePath}:`,
                error
              );
            }
          });

          try {
            const recordingDir = recording.recordingPath;
            const remainingFiles = fs.readdirSync(recordingDir);
            if (remainingFiles.length === 0) {
              fs.rmdirSync(recordingDir);
              console.log(
                `Cleaned up empty recording directory: ${recordingDir}`
              );
            }
          } catch (error) {
            console.error(`Error cleaning up recording directory:`, error);
          }

          // Notify room participants
          broadcastToRoom(roomId, {
            type: "recording_ready",
            roomId,
            message: "Recording is ready for download",
            downloadUrl: supabaseUrl,
            timestamp: new Date().toISOString(),
          });
        } catch (uploadError) {
          console.error(`Error uploading to Supabase:`, uploadError);

          broadcastToRoom(roomId, {
            type: "recording_ready",
            roomId,
            message: "Recording is ready for download (local fallback)",
            downloadUrl: `/download/${path.basename(finalOutputPath)}`,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        console.error("Combined file is empty");
        broadcastToRoom(roomId, {
          type: "recording_error",
          roomId,
          message: "Error: Combined recording is empty",
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      console.error("Combined file was not created");
      broadcastToRoom(roomId, {
        type: "recording_error",
        roomId,
        message: "Error: Failed to create combined recording",
        timestamp: new Date().toISOString(),
      });
    }

    // Clean up recording data
    roomRecordings.delete(roomId);
  } catch (error) {
    console.error(`Error combining audio files for room ${roomId}:`, error);

    // Notify room participants of error
    broadcastToRoom(roomId, {
      type: "recording_error",
      roomId,
      message: "Error processing recording: " + error.message,
      timestamp: new Date().toISOString(),
    });

    roomRecordings.delete(roomId);
  }
}

// Add HTTP route for downloading recordings
server.on("request", (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);

  if (url.pathname.startsWith("/download/")) {
    const filename = path.basename(url.pathname);
    const filePath = path.join(recordingsDir, filename);

    console.log(`Download request for file: ${filePath}`);

    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`File size: ${stats.size} bytes`);

      if (stats.size > 0) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );
        res.setHeader("Content-Length", stats.size);

        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

        fileStream.on("error", (error) => {
          console.error("Error streaming file:", error);
          res.statusCode = 500;
          res.end("Error downloading file");
        });
      } else {
        console.error("File is empty");
        res.statusCode = 500;
        res.end("Error: File is empty");
      }
    } else {
      console.error("File not found");
      res.statusCode = 404;
      res.end("File not found");
    }
  }
});

const PORT = process.env.PORT || 3005;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`WebSocket server is running on wss://${HOST}:${PORT}`);

  const os = require("os");
  const networkInterfaces = os.networkInterfaces();
  const localIPs = [];

  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((interface) => {
      if (interface.family === "IPv4" && !interface.internal) {
        localIPs.push(interface.address);
      }
    });
  });

  console.log("Server accessible at:");
  console.log(`- wss://localhost:${PORT}`);
  localIPs.forEach((ip) => {
    console.log(`- wss://${ip}:${PORT}`);
  });
});
