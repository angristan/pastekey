import { Schema } from "effect";

import { PositiveInteger } from "./primitives";

export class ServiceLimits extends Schema.Class<ServiceLimits>("ServiceLimits")({
  maxFileBytes: PositiveInteger,
  maxFilesPerPaste: PositiveInteger,
  maxPastesPerUser: PositiveInteger,
  maxStorageBytes: PositiveInteger,
}) {}

export class AppConfig extends Schema.Class<AppConfig>("AppConfig")({
  limits: ServiceLimits,
  turnstileSiteKey: Schema.Union([Schema.String, Schema.Null]),
}) {}
