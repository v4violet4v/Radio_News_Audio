import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * MINIMAL schema for the audio worker — only the two tables (and only the
 * columns) the audio stage reads/writes. This deliberately does NOT mirror the
 * private repo's full schema (no users / auth / topics / dedup columns), so the
 * public repo reveals nothing about the rest of the data model.
 *
 * Drizzle only requires the columns a query references, so a partial table
 * definition is valid as long as the table + column names/types match the live
 * Neon DB. Keep these in sync with the private repo's `segments`/`categories`
 * definitions if those change (see README "Maintenance").
 */

/** One read-along line: spoken sentence with its audio time range (seconds). */
export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

// categories — the audio stage reads `speed` (per-category TTS speed) by id.
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  speed: doublePrecision("speed").notNull().default(1.0),
});

// segments — the shared audio library. Audio stage READS id/scriptText/voiceId/
// categoryId/headline/status/audioUrl/createdAt and WRITES audioUrl/duration/
// transcript/status.
export const segments = pgTable("segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: integer("category_id").notNull(),
  headline: text("headline").notNull(),
  scriptText: text("script_text").notNull(),
  audioUrl: text("audio_url"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  voiceId: text("voice_id").notNull(),
  // Pipeline stage: 'pending_audio' (text done, no audio yet) | 'ready' | 'failed'.
  status: text("status").notNull().default("ready"),
  // Per-sentence read-along timing: [{start,end,text}] (set by this audio stage).
  transcript: jsonb("transcript").$type<TranscriptLine[]>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});
