export type AppConfig = {
  limits: {
    maxFileBytes: number;
    maxFilesPerPaste: number;
    maxPastesPerUser: number;
    maxStorageBytes: number;
  };
  turnstileSiteKey: string | null;
};
