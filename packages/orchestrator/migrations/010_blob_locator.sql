-- Where a blob's bytes actually live, as a locator rather than as the bytes.
--
-- `blobs.content bytea` held every document in the database, which imposed
-- three ceilings nobody chose: Postgres caps a bytea field at 1 GB, V8 caps a
-- string at 512 MB (so ~384 MB once a document is base64'd into a JSON body to
-- reach the API), and the upload route in front of it was capped at 100 MB to
-- match. A 300 MB document was streamed into Azure in 8 MiB blocks, converted
-- there, and then downloaded, buffered twice and refused — because the last leg
-- insisted on carrying bytes that were already stored.
--
-- The locator is OPAQUE and carries a backend prefix. `pg:<sha256>` means the
-- bytes are still in the column below; anything else names a blob in object
-- storage. That prefix is what makes a half-migrated table readable, and it is
-- what `scripts/migrate-blobs-to-azure.mjs` keys off — a row still reading
-- `pg:` has not been moved.
--
-- Backfilled rather than left null for existing rows: a null locator would mean
-- "neither here nor there", which is a row nothing can read. Every row that
-- exists today has its bytes in `content`, so every row gets the `pg:` form.
alter table blobs add column blob_path text;

update blobs set blob_path = 'pg:' || sha256 where blob_path is null;

-- `content` becomes nullable so a blob stored in object storage can exist
-- without it. The column is dropped entirely by 011, after a migration has been
-- run and verified — dropping it here would make this migration irreversible on
-- a database whose bytes have not moved yet.
alter table blobs alter column content drop not null;
