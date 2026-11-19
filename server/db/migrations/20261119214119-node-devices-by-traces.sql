-- 20261119214119-node-devices-by-traces.sql
--
-- Every owner credential that never showed a person's hand becomes a node one.
-- The work is in code, keyed by this file name (`db/migration-steps.ts` ->
-- `restrictMachineLikeDevices`), because it logs which devices it narrowed and
-- SQL cannot write the server log. 20261119100000-node-devices.sql, already
-- applied on live nodes, decided from the device NAME, which is the user agent
-- in disguise: a server named like a platform stayed owner, a person with
-- curl became a node. This one reads no name at all.
SELECT 1;
