const { eq, sql } = require("drizzle-orm");
const { db } = require("./connection.js");
const { RoomTable, RecordingsTable } = require("./schema.js");

const roomQueries = {
  getRoomByRoomId: async (roomId) => {
    try {
      const result = await db
        .select()
        .from(RoomTable)
        .where(eq(RoomTable.roomId, roomId));
      return result[0] || null;
    } catch (error) {
      console.error("Error fetching room:", error);
      return null;
    }
  },

  // Update room when it ends
  endRoom: async (roomId, endTime = new Date()) => {
    try {
      const result = await db
        .update(RoomTable)
        .set({
          endedAt: endTime,
          isActive: false,
        })
        .where(eq(RoomTable.roomId, roomId))
        .returning();

      console.log(`Room ${roomId} ended at ${endTime.toISOString()}`);
      return result[0] || null;
    } catch (error) {
      console.error("Error ending room:", error);
      return null;
    }
  },

  // Get active rooms
  getActiveRooms: async () => {
    try {
      return await db
        .select()
        .from(RoomTable)
        .where(eq(RoomTable.isActive, true));
    } catch (error) {
      console.error("Error fetching active rooms:", error);
      return [];
    }
  },
};

const recordingQueries = {
  // Create recording entry
  createRecording: async (roomDbId, startTime, participantCount) => {
    try {
      const result = await db
        .insert(RecordingsTable)
        .values({
          roomId: roomDbId,
          startTime: startTime,
          participantCount: participantCount,
          isProcessed: false,
        })
        .returning();

      console.log(`Recording created for room DB ID ${roomDbId}`);
      return result[0] || null;
    } catch (error) {
      console.error("Error creating recording:", error);
      return null;
    }
  },

  // Update recording when processing is complete
  updateRecording: async (roomDbId, recordingUrl, duration) => {
    try {
      const result = await db
        .update(RecordingsTable)
        .set({
          recordingUrl: recordingUrl,
          recordingCreatedAt: new Date(),
          recordingLength: duration,
        })
        .where(eq(RecordingsTable.roomId, roomDbId))
        .returning();

      console.log(`Recording updated for room DB ID ${roomDbId}`);
      return result[0] || null;
    } catch (error) {
      console.error("Error updating recording:", error);
      return null;
    }
  },

  // Get recording by room ID
  getRecordingByRoomId: async (roomDbId) => {
    try {
      const result = await db
        .select()
        .from(RecordingsTable)
        .where(eq(RecordingsTable.roomId, roomDbId));
      return result[0] || null;
    } catch (error) {
      console.error("Error fetching recording:", error);
      return null;
    }
  },
};

async function decrementCurrentParticipants(roomId) {
  await db
    .update(RoomTable)
    .set({
      currentParticiants: sql`${RoomTable.currentParticiants} - 1`,
    })
    .where(eq(RoomTable.roomId, roomId));
}

async function incrementCurrentParticipants(roomId) {
  await db
    .update(RoomTable)
    .set({
      currentParticiants: sql`${RoomTable.currentParticiants} + 1`,
    })
    .where(eq(RoomTable.roomId, roomId));
}

module.exports = {
  roomQueries,
  recordingQueries,
  decrementCurrentParticipants,
  incrementCurrentParticipants,
};
