import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { QueueServiceClient, QueueClient } from "@azure/storage-queue";
import { TableClient } from "@azure/data-tables";
import {
  type Config, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER,
  JOB_QUEUE, POISON_QUEUE, JOBS_TABLE,
} from "./config.js";

export interface Storage {
  blob: BlobServiceClient;
  queue: (name: string) => QueueClient;
  table: TableClient;
  sharedKey: StorageSharedKeyCredential;
  accountName: string;
}

export const getStorage = (cfg: Config): Storage => {
  const blob = BlobServiceClient.fromConnectionString(cfg.connectionString);
  const queues = QueueServiceClient.fromConnectionString(cfg.connectionString);
  const table = TableClient.fromConnectionString(cfg.connectionString, JOBS_TABLE, {
    allowInsecureConnection: true,
  });
  // Key-based connection strings give a StorageSharedKeyCredential, which is
  // what generateBlobSASQueryParameters needs. In prod this becomes a user
  // delegation key obtained through Managed Identity (spec §12).
  const sharedKey = blob.credential as StorageSharedKeyCredential;
  if (!(sharedKey instanceof StorageSharedKeyCredential)) {
    throw new Error("connection string must be key-based; SAS minting needs the shared key");
  }
  return {
    blob,
    queue: (name: string) => queues.getQueueClient(name),
    table,
    sharedKey,
    accountName: sharedKey.accountName,
  };
};

export const ensureStorage = async (s: Storage): Promise<void> => {
  await Promise.all([
    s.blob.getContainerClient(UPLOADS_CONTAINER).createIfNotExists(),
    s.blob.getContainerClient(ARTIFACTS_CONTAINER).createIfNotExists(),
    s.queue(JOB_QUEUE).createIfNotExists(),
    s.queue(POISON_QUEUE).createIfNotExists(),
    s.table.createTable().catch((e: any) => {
      if (e?.statusCode !== 409) throw e; // 409 = already there
    }),
  ]);
};
