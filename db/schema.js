const { pgTable, serial, varchar, integer, timestamp, boolean } = require("drizzle-orm/pg-core");

const RoomTable = pgTable("room", {
  id: serial().primaryKey(),
  name: varchar().notNull(),
  hostId: integer().notNull(),
  roomId: varchar().notNull(),
  numberOfAllowedParticipants: integer().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp({ withTimezone: true }),
  isActive: boolean().default(true),
  currentParticiants: integer().default(0),
});

const RecordingsTable = pgTable("recordings", {
  id: serial().primaryKey(),
  recordingUrl: varchar(),
  roomId: integer()
    .references(() => RoomTable.id)
    .notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  recordingCreatedAt: timestamp({ withTimezone: true }),
  recordingLength: varchar(),
});

module.exports = { RoomTable, RecordingsTable };
