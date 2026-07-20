import { config } from "dotenv";

/**
 * Side-effect module: loads `.env` from the current working directory into
 * process.env. Import it *first* in a service entry point, before any module
 * that reads process.env at module scope:
 *
 *   import "@hive/shared/env";
 *
 * ESM evaluates dependencies in import-declaration order, so listing this
 * first guarantees the file is loaded before those modules initialize.
 * Real environment variables always win over .env values.
 */
config({ quiet: true });
