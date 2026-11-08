// Drizzle relations for the relational query API (`db.query.*`). Scope is
// deliberately narrow: only the generation→job→track→asset/cover spine, where
// each table pair is connected by exactly one FK (so no `relationName`
// disambiguation is needed). The multi-pointer Session/Queue edges
// (currentTrack/currentQueueItem vs the items collection) are intentionally left
// out to avoid ambiguous relations; they can be added with explicit
// `relationName`s when a query needs them. Relations are metadata only — they do
// not affect the generated migration.

import { relations } from 'drizzle-orm';
import { coverImages } from './covers';
import { generationRequests, providerJobs } from './generation';
import { activitySessions } from './sessions';
import { tracks, trackAudioAssets } from './tracks';

export const generationRequestsRelations = relations(generationRequests, ({ one, many }) => ({
  // One paid job per request (enforced by a unique index).
  providerJob: one(providerJobs),
  tracks: many(tracks),
  activitySession: one(activitySessions, {
    fields: [generationRequests.activitySessionId],
    references: [activitySessions.id],
  }),
}));

export const providerJobsRelations = relations(providerJobs, ({ one, many }) => ({
  generationRequest: one(generationRequests, {
    fields: [providerJobs.generationRequestId],
    references: [generationRequests.id],
  }),
  tracks: many(tracks),
}));

export const tracksRelations = relations(tracks, ({ one, many }) => ({
  generationRequest: one(generationRequests, {
    fields: [tracks.generationRequestId],
    references: [generationRequests.id],
  }),
  providerJob: one(providerJobs, {
    fields: [tracks.providerJobId],
    references: [providerJobs.id],
  }),
  coverImage: one(coverImages, {
    fields: [tracks.coverImageId],
    references: [coverImages.id],
  }),
  audioAssets: many(trackAudioAssets),
}));

export const trackAudioAssetsRelations = relations(trackAudioAssets, ({ one }) => ({
  track: one(tracks, {
    fields: [trackAudioAssets.trackId],
    references: [tracks.id],
  }),
}));

export const coverImagesRelations = relations(coverImages, ({ many }) => ({
  tracks: many(tracks),
}));
