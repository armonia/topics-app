import { join } from "node:path";

const DIR = join(import.meta.dir, "../../server/db/migrations");

/** The project_quota schema as the live database has it: the table, then the additive column. */
export const PROJECT_QUOTA_SCHEMA =
  (await Bun.file(join(DIR, "20261119000000-project-quota.sql")).text()) +
  "\n" +
  (await Bun.file(join(DIR, "20261129000000-project-quota-limit-none.sql")).text());
