export type AppConfig = {
  limits: {
    maxFileBytes: number;
    maxFilesPerPaste: number;
    maxPastesPerUser: number;
    maxStorageBytes: number;
  };
  registrationEnabled: boolean;
  turnstileSiteKey: string | null;
};
