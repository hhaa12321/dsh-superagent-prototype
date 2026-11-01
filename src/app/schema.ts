/** Fresh persistence schema identity. There is no migration path: an older state directory must be replaced. */

/** Current SQLite schema version. Repository identity, Source instance IDs, and persisted forge capabilities require this version. */
export const SCHEMA_VERSION = 13
/** The oldest database schema this build opens. It is the current schema: earlier state is not migrated. */
export const OLDEST_SCHEMA = 13
/** Returns an error message explaining why `version` cannot be opened: it predates the fresh-schema break. */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} is older than schema ${OLDEST_SCHEMA}; this build has no migration or compatibility fallback, so start with a new state directory`
